// Erzeugt die PNG-App-Icons (180/192/512) ohne externe Abhängigkeiten:
// zeichnet das Orange-Bar-Motiv in einen RGBA-Puffer und kodiert PNG selbst.
// Aufruf: node scripts/gen-icons.js
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

// --- Mini-PNG-Encoder (RGBA, Filter 0) ---
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // Bit-Tiefe
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Zeichnen ---
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
function inRoundRect(x, y, rx, ry, w, h, r) {
  const dx = Math.max(rx - x, x - (rx + w - 1), 0);
  const dy = Math.max(ry - y, y - (ry + h - 1), 0);
  if (dx === 0 && dy === 0) {
    const cx = Math.max(rx + r - x, x - (rx + w - 1 - r), 0);
    const cy = Math.max(ry + r - y, y - (ry + h - 1 - r), 0);
    return cx * cx + cy * cy <= r * r;
  }
  return false;
}

function drawIcon(size) {
  const s = size / 512; // Design-Koordinaten wie im SVG
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let [r, g, b, a] = [0, 0, 0, 0];
      if (inRoundRect(x, y, 0, 0, size, size, 112 * s)) [r, g, b, a] = [0x1e, 0x1a, 0x16, 255];
      // Sockel
      if (inRoundRect(x, y, 146 * s, 336 * s, 220 * s, 28 * s, 14 * s)) [r, g, b, a] = [0x5a, 0x46, 0x32, 255];
      // Orangene Bar mit Verlauf
      if (inRoundRect(x, y, 96 * s, 216 * s, 320 * s, 80 * s, 40 * s)) {
        const t = (x - 96 * s) / (320 * s);
        [r, g, b, a] = [lerp(0xff, 0xff, t), lerp(0x7a, 0x9d, t), lerp(0x00, 0x3d, t), 255];
      }
      // "Sonne"
      const dx = x - 256 * s, dy = y - 152 * s;
      if (dx * dx + dy * dy <= 34 * s * (34 * s)) [r, g, b, a] = [0xff, 0xb0, 0x66, 255];
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
    }
  }
  return encodePng(size, size, rgba);
}

for (const size of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${size}.png`), drawIcon(size));
  console.log(`icon-${size}.png erzeugt`);
}
