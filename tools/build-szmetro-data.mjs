#!/usr/bin/env node
// @ts-check

/**
 * Build the Shenzhen Metro station catalogue used by the web app.
 *
 * The catalogue is not maintained by hand: it is extracted from the official
 * Shenzhen Metro station bundle (`metroStationsList.js`), which is the same
 * file the official website loads to draw its line diagrams. That file carries
 * every station's Chinese name, its official station code, its full pinyin and
 * its pinyin initials — which is exactly the search key the app needs.
 *
 * The line colours are read out of the official line badge images, so the app
 * shows the same colour per line as the network map.
 *
 *   node tools/build-szmetro-data.mjs
 *   node tools/build-szmetro-data.mjs --out web/sz-metro/data/stations.json
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const STATION_SOURCE = 'https://www.szmc.net/styles/index/js/metroStationsList.js';
const IMAGE_BASE = 'https://www.szmc.net/styles/index/images';

/** Lines the network currently runs, plus the Line 6 branch. */
const LINE_IDS = ['1', '2', '3', '4', '5', '6', '66', '7', '8', '9', '10', '11', '12', '13', '14', '16', '20'];

/**
 * @param {string[]} argv
 * @returns {string}
 */
function outPath(argv) {
  const index = argv.indexOf('--out');
  if (index !== -1 && argv[index + 1]) return path.resolve(argv[index + 1]);
  // The tool runs from a workspace root, where the app lives in
  // `web/sz-metro`, and from the published repository, where the app is the
  // repository root.
  const standalone = path.join(ROOT, 'index.html');
  if (existsSync(standalone)) return path.join(ROOT, 'data', 'stations.json');
  return path.join(ROOT, 'web', 'sz-metro', 'data', 'stations.json');
}

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (sz-metro-data build)' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

/**
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function fetchBinary(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (sz-metro-data build)' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/* ------------------------------------------------------------------ PNG */

/**
 * Minimal PNG reader: enough to pull the dominant colour out of a small badge
 * image. Handles 8-bit greyscale, RGB, palette and alpha images, which is
 * what the official line badges are.
 *
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number, pixels: Uint8Array, channels: number }}
 */
function decodePng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error('not a PNG');

  let offset = 8;
  /** @type {Buffer} */
  let idat = Buffer.alloc(0);
  /** @type {{ width: number, height: number, bitDepth: number, colorType: number } | null} */
  let header = null;
  /** @type {Buffer | null} */
  let palette = null;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const data = buffer.subarray(start, start + length);
    offset = start + length + 4; // skip CRC

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
      };
      if (data[12] !== 0) throw new Error('interlaced PNG is not supported');
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat = Buffer.concat([idat, Buffer.from(data)]);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!header) throw new Error('PNG has no header');
  if (header.bitDepth !== 8) throw new Error(`unsupported PNG depth ${header.bitDepth}`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${header.colorType}`);

  const raw = inflateSync(idat);
  const { width, height } = header;
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);

  let previous = Buffer.alloc(stride);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position];
    position += 1;
    const line = Buffer.from(raw.subarray(position, position + stride));
    position += stride;

    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      switch (filter) {
        case 0:
          break;
        case 1:
          line[x] = (line[x] + a) & 0xff;
          break;
        case 2:
          line[x] = (line[x] + b) & 0xff;
          break;
        case 3:
          line[x] = (line[x] + ((a + b) >> 1)) & 0xff;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const value = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[x] = (line[x] + value) & 0xff;
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
    }

    line.copy(pixels, y * stride);
    previous = line;
  }

  return { width, height, pixels, channels };
}

/**
 * The colour the official badge is painted in: the most common pixel that is
 * not transparent and not a near-grey.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
function dominantColour(buffer) {
  const { width, height, pixels, channels } = decodePng(buffer);
  /** @type {Map<number, number>} */
  const counts = new Map();

  for (let i = 0; i < width * height; i += 1) {
    const base = i * channels;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 255;
    if (channels === 1) {
      if (header3(palette, pixels[base])) continue;
      r = g = b = pixels[base];
    } else if (channels === 2) {
      r = g = b = pixels[base];
      a = pixels[base + 1];
    } else if (channels === 3) {
      r = pixels[base];
      g = pixels[base + 1];
      b = pixels[base + 2];
    } else {
      r = pixels[base];
      g = pixels[base + 1];
      b = pixels[base + 2];
      a = pixels[base + 3];
    }
    if (a < 128) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min < 24 && max < 235) continue; // grey or near-white
    const key = (r << 16) | (g << 8) | b;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let best = -1;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  if (best < 0) throw new Error('no colour found in badge');
  return `#${best.toString(16).padStart(6, '0')}`;
}

/**
 * @param {Buffer | null} palette
 * @param {number} index
 */
function header3(palette, index) {
  return !!palette && index >= palette.length;
}

/* ------------------------------------------------------------- catalogue */

/**
 * @param {string} source
 * @returns {any[]}
 */
function parseStations(source) {
  const start = source.indexOf('[');
  const end = source.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('station bundle not found');
  // The bundle is a plain object literal, so it can be read as data.
  // eslint-disable-next-line no-eval
  return eval(source.slice(start, end + 1));
}

/**
 * @param {any[]} lines
 */
function buildCatalogue(lines) {
  /** @type {Map<string, any>} */
  const stations = new Map();
  /** @type {any[]} */
  const catalogueLines = [];

  for (const line of lines) {
    if (!LINE_IDS.includes(String(line.line))) continue;
    /** @type {any[]} */
    const entries = [];
    line.stationList.forEach((station, index) => {
      entries.push({
        code: station.stationCode,
        name: station.stationName,
        qp: station.stationQP,
        jp: station.stationJP,
        index,
      });

      const existing = stations.get(station.stationName);
      const facilities = [...new Set((station.facilitiesList ?? []).map((item) => item.facilitiesName))];
      if (existing) {
        if (!existing.lines.includes(String(line.line))) existing.lines.push(String(line.line));
        existing.facilities = [...new Set([...existing.facilities, ...facilities])];
      } else {
        stations.set(station.stationName, {
          code: station.stationCode,
          name: station.stationName,
          qp: station.stationQP,
          jp: station.stationJP,
          lines: [String(line.line)],
          facilities,
        });
      }
    });

    catalogueLines.push({
      id: String(line.line),
      name: line.lineName,
      from: line.starStation,
      to: line.terminus,
      stations: entries,
    });
  }

  return { lines: catalogueLines, stations: [...stations.values()] };
}

/**
 * @param {string[]} ids
 * @returns {Promise<Map<string, string>>}
 */
async function lineColours(ids) {
  /** @type {Map<string, string>} */
  const colours = new Map();
  for (const id of ids) {
    let colour = '';
    for (const file of [`l${id}-c2.png`, `b${id}.png`]) {
      try {
        const buffer = await fetchBinary(`${IMAGE_BASE}/${file}`);
        colour = dominantColour(buffer);
        if (colour) break;
      } catch {
        /* try the next badge */
      }
    }
    if (colour) colours.set(id, colour);
  }
  return colours;
}

/* ----------------------------------------------------------------- main */

async function main() {
  const argv = process.argv.slice(2);
  const target = outPath(argv);

  console.log(`Reading ${STATION_SOURCE}`);
  const source = await fetchText(STATION_SOURCE);
  const lines = parseStations(source);
  const catalogue = buildCatalogue(lines);
  console.log(`  ${catalogue.lines.length} lines, ${catalogue.stations.length} stations`);

  console.log('Reading official line colours');
  const colours = await lineColours(catalogue.lines.map((line) => line.id));
  console.log(`  ${colours.size} line colours`);

  for (const line of catalogue.lines) {
    line.color = colours.get(line.id) ?? '#666666';
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: STATION_SOURCE,
    ...catalogue,
  };

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${target}`);
  for (const line of catalogue.lines) {
    console.log(`  ${line.name.padEnd(12)} ${line.color}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
