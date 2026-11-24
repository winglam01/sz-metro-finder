// @ts-check

/**
 * In-browser replacement for the Mini App HTTP API.
 *
 * The routes, the response shapes and the error contract are the ones the
 * Node server exposes, so the existing client works unchanged: the same paths
 * are answered, the same JSON is returned, and a failure produces an `Error`
 * whose `message` is the server's `payload.message` and whose `status` is the
 * HTTP status the server would have used.
 *
 *   GET    /api/bootstrap
 *   GET    /api/stations?q=
 *   GET    /api/station/{code}?dayType=
 *   GET    /api/journey?from=&to=&ridingType=
 *   GET    /api/favourites
 *   POST   /api/favourites
 *   DELETE /api/favourites/{code}
 */

import {
  NotFoundError,
  addFavourite,
  bootstrap,
  journey,
  listFavourites,
  removeFavourite,
  searchStations,
  stationDetail,
} from './domain.mjs';

export class ValidationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * @param {{ body?: unknown }} [options]
 */
function readBody(options = {}) {
  const raw = options.body;
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'string') {
    if (raw.length > 64 * 1024) throw new ValidationError('request body is too large');
    try {
      return JSON.parse(raw);
    } catch {
      throw new ValidationError('request body is not valid JSON');
    }
  }
  if (typeof raw === 'object') return raw;
  throw new ValidationError('request body is not valid JSON');
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Route one request and return the response the Node server would have sent.
 *
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {Promise<{ status: number, payload: any }>}
 */
export async function handleApi(path, options = {}) {
  const url = new URL(path, 'http://api.local');
  const { pathname } = url;
  const method = String(options.method ?? 'GET').toUpperCase();

  try {
    if (method === 'GET' && pathname === '/api/bootstrap') {
      return { status: 200, payload: await bootstrap() };
    }

    if (method === 'GET' && pathname === '/api/stations') {
      const results = await searchStations(url.searchParams.get('q') ?? '');
      return { status: 200, payload: { results } };
    }

    const stationMatch = pathname.match(/^\/api\/station\/([^/]+)$/);
    if (method === 'GET' && stationMatch) {
      const payload = await stationDetail(decodeSegment(stationMatch[1]), {
        dayType: url.searchParams.get('dayType') ?? undefined,
      });
      return { status: 200, payload };
    }

    if (method === 'GET' && pathname === '/api/journey') {
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      if (!from || !to) throw new ValidationError('from and to are required');
      const ridingType = url.searchParams.get('ridingType') === '1' ? 1 : 0;
      const payload = await journey(from, to, /** @type {0 | 1} */ (ridingType));
      return { status: 200, payload };
    }

    if (method === 'GET' && pathname === '/api/favourites') {
      return { status: 200, payload: { items: listFavourites() } };
    }

    if (method === 'POST' && pathname === '/api/favourites') {
      const body = readBody(options);
      const code = typeof body === 'object' && body ? /** @type {any} */ (body).code : '';
      if (typeof code !== 'string' || !code) throw new ValidationError('code is required');
      return { status: 200, payload: { items: addFavourite(code) } };
    }

    const favouriteMatch = pathname.match(/^\/api\/favourites\/([^/]+)$/);
    if (method === 'DELETE' && favouriteMatch) {
      return { status: 200, payload: { items: removeFavourite(decodeSegment(favouriteMatch[1])) } };
    }

    return { status: 404, payload: { error: 'not_found' } };
  } catch (error) {
    if (error instanceof ValidationError) {
      return { status: 400, payload: { error: 'invalid_request', message: error.message } };
    }
    if (error instanceof NotFoundError) {
      return { status: 404, payload: { error: 'not_found', message: error.message } };
    }
    const message = error instanceof Error ? error.message : 'unexpected error';
    return { status: 502, payload: { error: 'upstream_unavailable', message } };
  }
}

/**
 * Call the API. Resolves with the parsed payload, or rejects with an `Error`
 * carrying the HTTP `status` and the server's `message`.
 *
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {Promise<any>}
 */
export async function api(path, options = {}) {
  const { status, payload } = await handleApi(path, options);
  if (status >= 400) {
    const error = new Error(payload?.message || `Request failed (${status})`);
    error.status = status;
    throw error;
  }
  return payload;
}

export default api;
