// Renders the PWA's raster icons from the same geometry as public/icon.svg, with no image library needed.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BASE = [31, 29, 25];
const LAYERS = [
  { y: 22, colour: [239, 233, 220] },
  { y: 33, colour: [201, 128, 74] },
  { y: 44, colour: [58, 163, 154] },
];
const [X0, X1, HALF_WIDTH, RADIUS] = [14, 50, 2, 14];

const wave = (x, y) => y + Math.sin(((x - X0) / (X1 - X0)) * Math.PI * 2) * 1.8;

function roundedCoverage(x, y) {
  const dx = Math.max(RADIUS - x, x - (64 - RADIUS), 0);
  const dy = Math.max(RADIUS - y, y - (64 - RADIUS), 0);
  return Math.min(1, Math.max(0, RADIUS - Math.hypot(dx, dy) + 0.5));
}

function layerCoverage(x, y, layer) {
  const cx = Math.min(X1, Math.max(X0, x));
  const distance = Math.hypot(x - cx, y - wave(cx, layer.y));
  return Math.min(1, Math.max(0, HALF_WIDTH - distance + 0.5));
}

function render(size) {
  const k = 64 / size;
  const rows = [];
  for (let py = 0; py < size; py += 1) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px += 1) {
      const [x, y] = [(px + 0.5) * k, (py + 0.5) * k];
      let rgb = BASE;
      for (const layer of LAYERS) {
        const c = layerCoverage(x, y, layer);
        if (c > 0) rgb = rgb.map((v, i) => Math.round(v * (1 - c) + layer.colour[i] * c));
      }
      row.set([...rgb, Math.round(roundedCoverage(x, y) * 255)], 1 + px * 4);
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => (buf.reduce((c, b) => crcTable[(c ^ b) & 255] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function png(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(render(size))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) writeFileSync(`apps/web/public/icon-${size}.png`, png(size));
console.log('Icons written.');
