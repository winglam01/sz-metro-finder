#!/usr/bin/env node
// @ts-check

/**
 * Draw the app icons for the Shenzhen Metro app.
 *
 * The icons are generated rather than hand-drawn: this file paints the same
 * mark the app header uses — a metro train front on Shenzhen Metro green — and
 * writes it out as PNG. There is no image library in the toolchain, so a small
 * PNG encoder and a supersampled rasteriser live here.
 *
 *   node tools/make-szmetro-icons.mjs
 *   node tools/make-szmetro-icons.mjs web/sz-metro
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** Shenzhen Metro green, the colour of Line 1 and of the operator's own mark. */
const GREEN = [0x00, 0x99, 0x43];
const WHITE = [0xff, 0xff, 0xff];

/* ------------------------------------------------------------------ PNG */

const CRC_TABLE = (() => {
  /** @type {number[]} */
  const table = new Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * @param {Buffer} buffer
 * @returns {number}
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type
 * @param {Buffer} data
 * @returns {Buffer}
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const head = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head, data])));
  return Buffer.concat([length, head, data, crc]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba
 * @returns {Buffer}
 */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------- drawing */

/**
 * A canvas that paints at four times the resolution and is then averaged
 * down, which is enough to get clean edges without a graphics library.
 */
class Canvas {
  /**
   * @param {number} size
   * @param {number} [scale]
   */
  constructor(size, scale = 4) {
    this.size = size;
    this.scale = scale;
    this.width = size * scale;
    /** @type {Float64Array} */
    this.pixels = new Float64Array(this.width * this.width * 4);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number[]} colour
   * @param {number} alpha
   */
  blend(x, y, colour, alpha) {
    if (alpha <= 0) return;
    const index = (y * this.width + x) * 4;
    const a = Math.min(1, alpha);
    for (let channel = 0; channel < 3; channel += 1) {
      this.pixels[index + channel] = this.pixels[index + channel] * (1 - a) + colour[channel] * a;
    }
    this.pixels[index + 3] = this.pixels[index + 3] * (1 - a) + 255 * a;
  }

  /**
   * @param {(x: number, y: number) => boolean} inside
   * @param {number[]} colour
   */
  fill(inside, colour) {
    for (let y = 0; y < this.width; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        if (inside(x + 0.5, y + 0.5)) this.blend(x, y, colour, 1);
      }
    }
  }

  /** @returns {Uint8Array} */
  resolve() {
    const { size, scale, width } = this;
    /** @type {Uint8Array} */
    const out = new Uint8Array(size * size * 4);
    const samples = scale * scale;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            const index = ((y * scale + sy) * width + (x * scale + sx)) * 4;
            r += this.pixels[index];
            g += this.pixels[index + 1];
            b += this.pixels[index + 2];
            a += this.pixels[index + 3];
          }
        }
        const offset = (y * size + x) * 4;
        out[offset] = Math.round(r / samples);
        out[offset + 1] = Math.round(g / samples);
        out[offset + 2] = Math.round(b / samples);
        out[offset + 3] = Math.round(a / samples);
      }
    }
    return out;
  }
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} left
 * @param {number} top
 * @param {number} right
 * @param {number} bottom
 * @param {number} radius
 * @returns {boolean}
 */
function inRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} cx
 * @param {number} cy
 * @param {number} radius
 * @returns {boolean}
 */
function inCircle(x, y, cx, cy, radius) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * Paint the metro train mark.
 *
 * @param {number} size
 * @returns {Uint8Array}
 */
function drawIcon(size) {
  const canvas = new Canvas(size);
  const unit = canvas.width;

  // Rounded background.
  canvas.fill((x, y) => inRoundedRect(x, y, 0, 0, unit - 1, unit - 1, unit * 0.22), GREEN);

  // Train body.
  const bodyLeft = unit * 0.26;
  const bodyRight = unit * 0.74;
  const bodyTop = unit * 0.2;
  const bodyBottom = unit * 0.7;
  canvas.fill((x, y) => inRoundedRect(x, y, bodyLeft, bodyTop, bodyRight, bodyBottom, unit * 0.12), WHITE);

  // Windscreen band.
  canvas.fill(
    (x, y) => inRoundedRect(x, y, unit * 0.32, unit * 0.27, unit * 0.68, unit * 0.46, unit * 0.05),
    GREEN,
  );

  // Headlights.
  canvas.fill((x, y) => inCircle(x, y, unit * 0.4, unit * 0.57, unit * 0.035), GREEN);
  canvas.fill((x, y) => inCircle(x, y, unit * 0.6, unit * 0.57, unit * 0.035), GREEN);

  // Legs down to the rails.
  canvas.fill((x, y) => inRoundedRect(x, y, unit * 0.36, bodyBottom - 2, unit * 0.42, unit * 0.79, unit * 0.02), WHITE);
  canvas.fill((x, y) => inRoundedRect(x, y, unit * 0.58, bodyBottom - 2, unit * 0.64, unit * 0.79, unit * 0.02), WHITE);

  return canvas.resolve();
}

/* ----------------------------------------------------------------- main */

/**
 * @param {string[]} argv
 * @returns {string}
 */
function outDir(argv) {
  const index = argv.indexOf('--out');
  if (index !== -1 && argv[index + 1]) return path.resolve(argv[index + 1]);
  // The tool runs from a workspace root, where the app lives in
  // `web/sz-metro`, and from the published repository, where the app is the
  // repository root.
  if (existsSync(path.join(ROOT, 'index.html'))) return ROOT;
  return path.join(ROOT, 'web', 'sz-metro');
}

async function main() {
  const argv = process.argv.slice(2);
  const target = outDir(argv);
  await mkdir(target, { recursive: true });

  const files = [
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['apple-touch-icon.png', 180],
  ];

  for (const [name, size] of files) {
    const png = encodePng(size, size, drawIcon(size));
    await writeFile(path.join(target, name), png);
    console.log(`Wrote ${path.join(target, name)} (${size}×${size}, ${png.length} bytes)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
