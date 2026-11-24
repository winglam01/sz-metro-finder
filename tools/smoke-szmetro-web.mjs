#!/usr/bin/env node
// @ts-check

/**
 * Smoke test for the Shenzhen Metro app.
 *
 * It drives the real data layer against the real Shenzhen Metro endpoints and
 * asserts the station catalogue, the pinyin search, the timetable arithmetic,
 * the arrival board and the route planner. It needs network access and takes
 * about fifteen seconds.
 *
 *   node tools/smoke-szmetro-web.mjs
 */

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const REPO = resolve(HERE, '..');

/**
 * The app is the repository root in the published repository and lives in
 * `web/sz-metro` in the workspace.
 */
const WEB_ROOT = existsSync(join(REPO, 'index.html')) ? REPO : join(REPO, 'web', 'sz-metro');

/* --------------------------------------------------------------- server */

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

/**
 * A static server for the web build. The domain layer reads its station
 * catalogue with `fetch`, and Node's fetch does not speak `file:`, so the
 * catalogue is served over HTTP exactly as the browser would read it.
 */
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const relative = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    const target = normalize(join(WEB_ROOT, relative));
    if (!target.startsWith(WEB_ROOT + sep)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new Error('not a file');
      const body = await readFile(target);
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  })();
});

const port = await new Promise((resolvePort) => {
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolvePort(typeof address === 'object' && address ? address.port : 0);
  });
});

const base = `http://127.0.0.1:${port}`;

/**
 * Send `file:` URLs to the local server and leave everything else alone.
 * @type {typeof globalThis.fetch}
 */
const realFetch = globalThis.fetch;
const webRootPosix = WEB_ROOT.replace(/\\/g, '/');
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('file:')) {
    // Windows file URLs carry a leading slash before the drive letter.
    const filePath = decodeURIComponent(new URL(url).pathname)
      .replace(/^\/([A-Za-z]:)/, '$1')
      .replace(/\\/g, '/');
    const relative = filePath.startsWith(webRootPosix)
      ? filePath.slice(webRootPosix.length)
      : `/${filePath.split('/').pop()}`;
    return realFetch(`${base}${relative.startsWith('/') ? relative : `/${relative}`}`, init);
  }
  return realFetch(input, init);
};

/* ------------------------------------------------------------ assertions */

let failures = 0;

/**
 * @param {string} name
 * @param {boolean} condition
 * @param {string} [detail]
 */
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * @param {string} name
 * @param {unknown} actual
 * @param {unknown} expected
 */
function equal(name, actual, expected) {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

const domain = await import(pathToFileURL(join(WEB_ROOT, 'data', 'domain.mjs')).href);

console.log('catalogue');
const catalogue = await domain.loadCatalogue();
check('17 lines', catalogue.lines.length === 17, `got ${catalogue.lines.length}`);
check('351 stations', catalogue.stations.length === 351, `got ${catalogue.stations.length}`);
check(
  'every station has a pinyin spelling',
  catalogue.stations.every((station) => typeof station.qp === 'string' && station.qp.length > 0),
);
check(
  'every line has an official colour',
  catalogue.lines.every((line) => /^#[0-9a-f]{6}$/i.test(line.color)),
);

console.log('pinyin search');
const byInitials = await domain.searchStations('szb');
equal('"szb" finds 深圳北站 first', byInitials[0]?.name, '深圳北站');
const byPinyin = await domain.searchStations('shenzhenbei');
equal('"shenzhenbei" finds 深圳北站 first', byPinyin[0]?.name, '深圳北站');
const bySpaced = await domain.searchStations('shen zhen bei');
equal('"shen zhen bei" finds 深圳北站 first', bySpaced[0]?.name, '深圳北站');
const byChinese = await domain.searchStations('车公庙');
equal('"车公庙" finds 车公庙 first', byChinese[0]?.name, '车公庙');
const byEnglish = await domain.searchStations('luohu');
equal('"luohu" finds 罗湖 first', byEnglish[0]?.name, '罗湖');
const byTransfer = await domain.searchStations('cgm');
equal('"cgm" finds 车公庙 first', byTransfer[0]?.name, '车公庙');
check('an unknown query returns nothing', (await domain.searchStations('zzzzzz')).length === 0);

console.log('timetable arithmetic');
equal('parseClock reads 06:02', domain.parseClock('06:02'), 362);
equal('parseClock reads 00:33', domain.parseClock('00:33'), 33);
equal('parseHeadway reads 2分钟', domain.parseHeadway('2分钟')[0]?.minutes, 2);
equal('parseHeadway reads 5分50秒', Math.round(domain.parseHeadway('5分50秒')[0]?.minutes ?? 0), 6);
equal('parseHeadway averages 3-4分钟', domain.parseHeadway('3-4分钟')[0]?.minutes, 3.5);
const tagged = domain.parseHeadway('早2分15秒、晚3分钟。');
equal('parseHeadway keeps the morning figure', tagged.find((item) => item.tag === 'morning')?.minutes, 2.25);
equal('parseHeadway keeps the evening figure', tagged.find((item) => item.tag === 'evening')?.minutes, 3);
equal('a peak hour is a peak on a working day', domain.isPeak(8 * 60, 'work'), true);
equal('a peak hour is not a peak at the weekend', domain.isPeak(8 * 60, 'weekend'), false);

console.log('station page');
const detail = await domain.stationDetail('0111');
equal('车公庙 is the station', detail.station.name, '车公庙');
check('four lines are published', detail.directions.length === 8, `got ${detail.directions.length}`);
check(
  'every direction has a first and a last train',
  detail.directions.every((item) => /^\d{2}:\d{2}$/.test(item.first) && /^\d{2}:\d{2}$/.test(item.last)),
);
check(
  'every direction has an official headway',
  detail.directions.every((item) => item.peakHeadway || item.offPeakHeadway),
);
const arrivalCount = detail.directions.filter((item) => item.arrivals.length > 0).length;
check('at least one direction has arrivals right now', arrivalCount > 0, `${arrivalCount} of 8`);
check('the station publishes its exits', detail.exits.length > 0);
check('the station publishes nearby buses', detail.buses.length > 0);
check(
  'arrivals are in the future',
  detail.directions.every((item) => item.arrivals.every((arrival) => arrival.inMinutes >= 0)),
);

console.log('route planner');
const route = await domain.journey('0101', '0410');
check('a route comes back', route.segments.length >= 1);
check('the route has a travel time', route.minutes > 0, `${route.minutes} minutes`);
check('the route has a fare', route.fare > 0, `¥${route.fare}`);
check('the route names its lines', route.segments.every((segment) => segment.lineName));

console.log('favourites');
domain.addFavourite('0111');
check('a favourite is stored', domain.listFavourites().some((item) => item.code === '0111'));
domain.removeFavourite('0111');
check('a favourite is removed', !domain.listFavourites().some((item) => item.code === '0111'));

/* --------------------------------------------------------------- report */

server.close();

console.log('');
if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('all checks passed');
}
