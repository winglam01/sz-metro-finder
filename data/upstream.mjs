// @ts-check

/**
 * Upstream access layer for Shenzhen Metro.
 *
 * The operator publishes two public JSON endpoints on its own website, and
 * both of them were probed and confirmed before this file was written:
 *
 *   Station information   POST https://www.szmc.net/zdxx
 *                        body: StieCode=<station code>
 *                        → exits, nearby buses, first/last train and headways
 *                          for every line and direction at the station
 *
 *   Journey planning     POST https://www.szmc.net/algorithm/Ticketing/MinTimeJson.do
 *                        body: departureStation, arriveStation, ridingType, …
 *                        → routes with travel time, transfer time and fare
 *
 * Both answer `Access-Control-Allow-Origin: *`, and both are called with a
 * form-encoded body, which keeps the request a CORS "simple request": no
 * preflight, no custom headers, no proxy. The phone build therefore talks to
 * Shenzhen Metro directly.
 *
 * Browser notes
 * --------------
 * - No `node:` imports: the transport is `fetch` only.
 * - No custom request headers from a browser. The `Content-Type` of a
 *   form-encoded body is on the CORS safelist, so the call stays a simple
 *   request; anything else would trigger a preflight the server does not
 *   answer with `Access-Control-Allow-Headers`.
 * - The station catalogue is a static file and is never fetched from here.
 */

/** Station information: exits, buses, first/last train, headways. */
export const STATION_INFO_URL = 'https://www.szmc.net/zdxx';

/** Journey planning: routes, transfer times, fares. */
export const JOURNEY_URL = 'https://www.szmc.net/algorithm/Ticketing/MinTimeJson.do';

export class UpstreamError extends Error {
  /**
   * @param {string} message
   * @param {string} [url]
   * @param {number} [status]
   */
  constructor(message, url = '', status = 0) {
    super(message);
    this.name = 'UpstreamError';
    this.url = url;
    this.status = status;
  }
}

/** True inside a real browser document. */
const IN_BROWSER = typeof document !== 'undefined' && typeof window !== 'undefined';

/**
 * Headers sent to the upstream server.
 *
 * A browser must not add any: the form-encoded body is already a CORS simple
 * request, and a custom header would turn it into a preflighted one. Outside a
 * browser the headers make the request look like the browser traffic the
 * server expects.
 * @returns {Record<string, string> | undefined}
 */
function requestHeaders() {
  if (IN_BROWSER) return undefined;
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  };
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST a form-encoded body and read the JSON answer.
 *
 * @param {string} url
 * @param {Record<string, string>} fields
 * @param {{ timeoutMs?: number, retries?: number, backoffMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<any>}
 */
async function postForm(url, fields, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const retries = opts.retries ?? 2;
  const backoffMs = opts.backoffMs ?? 600;
  const body = new URLSearchParams(fields).toString();

  /** @type {Error | undefined} */
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      /** @type {RequestInit} */
      const init = {
        method: 'POST',
        body,
        signal: opts.signal ?? AbortSignal.timeout(timeoutMs),
        // The form content type is on the CORS safelist, so this stays a
        // simple request and no preflight is triggered.
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      };
      const extra = requestHeaders();
      if (extra) init.headers = { ...init.headers, ...extra };

      const res = await fetch(url, init);
      if (!res.ok) throw new UpstreamError(`Shenzhen Metro answered ${res.status}`, url, res.status);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new UpstreamError('Shenzhen Metro returned a malformed answer', url, res.status);
      }
    } catch (error) {
      if (error instanceof UpstreamError && error.status >= 400 && error.status < 500) throw error;
      if (opts.signal?.aborted) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < retries) await sleep(backoffMs * (attempt + 1));
    }
  }

  throw new UpstreamError(
    lastError?.message ? `Shenzhen Metro is unreachable: ${lastError.message}` : 'Shenzhen Metro is unreachable',
    url,
  );
}

/* --------------------------------------------------------------- caching */

/**
 * @template T
 * @param {number} ttlMs
 * @returns {((key: string, load: () => Promise<T>) => Promise<T>) & { clear: () => void }}
 */
function memoise(ttlMs) {
  /** @type {Map<string, { at: number, value: Promise<T> }>} */
  const cache = new Map();

  /**
   * @param {string} key
   * @param {() => Promise<T>} load
   * @returns {Promise<T>}
   */
  const memo = async (key, load) => {
    const hit = cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < ttlMs) return hit.value;
    const value = load();
    cache.set(key, { at: now, value });
    try {
      return await value;
    } catch (error) {
      // A failed call is never cached: the next attempt must be a real one.
      cache.delete(key);
      throw error;
    }
  };

  memo.clear = () => cache.clear();
  return memo;
}

/** Station information changes slowly, so it is kept for half an hour. */
const stationInfo = memoise(30 * 60 * 1000);

/** A route between the same two stations is stable enough for ten minutes. */
const journey = memoise(10 * 60 * 1000);

/**
 * Everything the operator publishes about one station.
 *
 * @param {string} code official station code, e.g. `0111`
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<any>}
 */
export function fetchStationInfo(code, opts = {}) {
  return stationInfo(code, () => postForm(STATION_INFO_URL, { StieCode: code }, opts));
}

/**
 * A route between two stations.
 *
 * `ridingType` is `0` for the quickest route and `1` for the one with the
 * fewest transfers.
 *
 * @param {string} from official station code
 * @param {string} to official station code
 * @param {0 | 1} ridingType
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<any>}
 */
export function fetchJourney(from, to, ridingType, opts = {}) {
  const key = `${from}>${to}:${ridingType}`;
  return journey(key, () =>
    postForm(
      JOURNEY_URL,
      {
        departureStation: from,
        arriveStation: to,
        departureStationName: '',
        arriveStationName: '',
        ridingType: String(ridingType),
        zdcxCode: '',
        zdcxName: '',
      },
      opts,
    ),
  );
}

/** Drop every cached answer. Used by the smoke test. */
export function clearCache() {
  stationInfo.clear();
  journey.clear();
}
