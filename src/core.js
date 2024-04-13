import { EOL } from 'node:os';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import path from 'node:path';
import pico from 'picocolors';
import CleanCSS from 'clean-css';
import { invokeMap } from 'lodash-es';
import pAll from 'p-all';
import debugBase from 'debug';
import postcss from 'postcss';
import discard from 'postcss-discard';
import imageInliner from 'postcss-image-inliner';
import penthouse from 'penthouse';
import { PAGE_UNLOADED_DURING_EXECUTION_ERROR_MESSAGE } from 'penthouse/lib/core.js';
import { inline as inlineCritical } from 'inline-critical';
import { removeDuplicateStyles } from 'inline-critical/css';
import parseCssUrls from 'css-url-parser';
import { reduceAsync } from './array.js';
import { NoCssError } from './errors.js';
import { getDocument, getDocumentFromSource, token, getAssetPaths, isRemote, normalizePath } from './file.js';

const debug = debugBase('critical:core');

/**
 * Returns a string of combined and deduped css rules.
 * @param {array} cssArray Array with css strings
 * @returns {String} combined and deduped css rules
 */
function combineCss(cssArray) {
  if (cssArray.length === 1) {
    return cssArray[0].toString();
  }

  return new CleanCSS().minify(invokeMap(cssArray, 'toString').join(' ')).styles;
}

/**
 * Let penthouse compute the critical css
 * @param {vinyl} document Vinyl representation of the HTML document
 * @param {object} options Options passed to critical
 * @returns {string} Critical css for various dimensions combined and deduped
 */
function callPenthouse(document, options) {
  const { width, height, userAgent, user, pass, penthouse: params = {} } = options;
  const { customPageHeaders = {} } = params;
  const { css: cssString, url } = document;
  const config = { ...params, cssString, url };
  // Dimensions need to be sorted from small to wide. Otherwise the order gets corrupted
  const sizes = [{ width, height }, { width: 1300, height: 99999 }];

  if (userAgent) {
    config.userAgent = userAgent;
  }

  if (user && pass) {
    config.customPageHeaders = { ...customPageHeaders, Authorization: `Basic ${token(user, pass)}` };
  }

  return sizes.map(({ width, height }) => () => {
    const result = penthouse({ ...config, width, height });
    debug('Call penthouse with:', {
      ...config,
      width,
      height,
      cssString: `${(cssString || '').slice(0, 10)} ... ${(cssString || '').slice(-10)}`,
    });
    return result;
  });
}

/**
 * Critical path CSS generation
 * @param  {object} options Options
 * @accepts src, base, width, height, dimensions, dest
 * @return {Promise<object>} Object with critical css & html
 */
export async function create(options = {}) {
  const {
    base,
    src,
    html,
    inline,
    ignore,
    extract,
    target = {},
    inlineImages,
    maxImageFileSize,
    postcss: postProcess = [],
    strict,
    cleanCSS: cleanCSSOptions,
    concurrency = Number.POSITIVE_INFINITY,
    assetPaths = [],
  } = options;

  // Create vinyl representation for the document with normalized filepath and normalized styles
  const document = src ? await getDocument(src, options) : await getDocumentFromSource(html, options);

  if (!document.css || !document.css.toString()) {
    if (strict) {
      throw new NoCssError();
    }

    return {
      atf: '',
      btf: '',
      html: document.contents.toString(),
    };
  }

  // Generate critical css
  let criticalStyles;
  try {
    const tasks = callPenthouse(document, options);
    criticalStyles = await pAll(tasks, { concurrency });
  } catch (error) {
    if (error.message === PAGE_UNLOADED_DURING_EXECUTION_ERROR_MESSAGE) {
      process.stderr.write(pico.yellow(PAGE_UNLOADED_DURING_EXECUTION_ERROR_MESSAGE) + EOL);
      return {
        atf: '',
        btf: '',
        html: document.contents.toString(),
      };
    }

    throw error;
  }

  // Add postprocess configuration
  if (ignore) {
    postProcess.push(discard(ignore));
  }

  // Minify or prettify
  const cleanCSS = new CleanCSS(
    cleanCSSOptions || {
      level: {
        1: {
          all: true,
        },
        2: {
          all: false,
          removeDuplicateFontRules: true,
          removeDuplicateMediaBlocks: true,
          removeDuplicateRules: true,
          removeEmpty: true,
          mergeMedia: true,
        },
      },
    }
  );

  // Define uncritical as lazy evaluated property
  const lazyUncritical = (orig, diff) =>
    function () {
      this._uncritical ||= removeDuplicateStyles(orig, diff);

      return this._uncritical;
    };

  const prepareStyle = async (criticalCSS) => {

    if (inlineImages) {

      const refAssets = [...parseCssUrls(criticalCSS), ...document.stylesheets];
      const refAssetPaths = refAssets.reduce((res, file) => [...res, path.dirname(file)], []);

      const searchpaths = await reduceAsync([], [...new Set(refAssetPaths)], async (res, file) => {
        const paths = await getAssetPaths(document, file, options, false);
        return [...new Set([...res, ...paths])];
      });

      const filtered = searchpaths.filter((p) => isRemote(p) || p.includes(process.cwd()) || (base && p.includes(base)));

      const inlineOptions = {
        assetPaths: [...filtered, ...assetPaths],
        maxFileSize: maxImageFileSize,
      };

      debug('Inline images:', inlineOptions, refAssets);

      postProcess.push(imageInliner(inlineOptions));
    }

    // Post-process critical css
    if (postProcess.length > 0) {
      criticalCSS = await postcss(postProcess)
        .process(criticalCSS, { from: undefined })
        .then((contents) => contents.css);
    }

    criticalCSS = cleanCSS.minify(criticalCSS).styles;
    // Inline
    if (inline) {
      const { replaceStylesheets } = inline;

      if (typeof replaceStylesheets === 'function') {
        inline.replaceStylesheets = await replaceStylesheets(document, result.uncritical);
      }

      // If replaceStylesheets is not set via option and and uncritical is empty
      if (extract && replaceStylesheets === undefined && result.uncritical.trim() === '') {
        inline.replaceStylesheets = [];
      }

      if (target.uncritical) {
        const uncriticalHref = normalizePath(path.relative(document.cwd, path.resolve(base, target.uncritical)));
        // Only replace stylesheets if the uncriticalHref is inside document.cwd and replaceStylesheets is not set via options
        if (!/^\.\.\//.test(uncriticalHref) && replaceStylesheets === undefined) {
          inline.replaceStylesheets = [`/${uncriticalHref}`];
        }
      } else {
        inline.extract = extract;
      }

      const inlined = inlineCritical(document.contents.toString(), criticalCSS, { ...inline, basePath: document.cwd });
      document.contents = Buffer.from(inlined);
    }

    return criticalCSS;
  };
  
  const
    atf = await prepareStyle(criticalStyles[0]),
    btf = await prepareStyle(criticalStyles[1]);

  const result = {
    atf: atf, // above the fold critical css
    btf: removeDuplicateStyles(btf, atf), // below the fold critical css
  };

  console.log(result);

  Object.defineProperty(result, 'uncritical', {
    get: lazyUncritical(document.css, result.atf + result.btf),
  });

  // Clean tempfiles
  await document.cleanup();

  result.html = document.contents.toString();
  result.document = document;

  // Cleanup output
  return result;
}
