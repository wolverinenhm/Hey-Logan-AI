'use strict';

/**
 * Generate the PNG app icons used by the PWA manifest and the favicon fallback.
 * Pure Node (zlib + manual PNG encoding) so setup needs no image libraries.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.resolve(__dirname, '..', 'public');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

const BG = [7, 11, 22];

function mix(a, b, t) {
  return a + (b - a) * t;
}

function mixColor(colorA, colorB, t) {
  return [mix(colorA[0], colorB[0], t), mix(colorA[1], colorB[1], t), mix(colorA[2], colorB[2], t)];
}

function renderIcon(size) {
  const SS = 2; // supersampling factor
  const S = size * SS;
  const buffer = Buffer.alloc(S * S * 4);
  const cx = S / 2;
  const cy = S / 2;
  const orbR = S * 0.3;
  const ringR = S * 0.405;
  const ringW = S * 0.024;
  const glowR = S * 0.52;

  const cyanSoft = [34, 211, 238];
  const cyanBright = [127, 243, 255];
  const blue = [79, 124, 255];
  const purple = [139, 92, 246];

  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const index = (y * S + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      let r = BG[0];
      let g = BG[1];
      let b = BG[2];

      // ambient glow behind the orb
      const glow = Math.max(0, 1 - dist / glowR);
      r += glow * 14;
      g += glow * 34;
      b += glow * 50;

      // outer ring
      const ringDelta = Math.abs(dist - ringR);
      if (ringDelta < ringW) {
        const alpha = (1 - ringDelta / ringW) * 0.8;
        const ringColor = mixColor(cyanSoft, purple, 0.25);
        r = mix(r, ringColor[0], alpha);
        g = mix(g, ringColor[1], alpha);
        b = mix(b, ringColor[2], alpha);
      }

      // orb body
      if (dist < orbR) {
        const t = Math.min(1, dist / orbR);
        const color = t < 0.5 ? mixColor(cyanBright, cyanSoft, t / 0.5) : mixColor(cyanSoft, blue, (t - 0.5) / 0.5);
        const edge = Math.min(1, (orbR - dist) / (1.5 * SS));
        r = mix(r, color[0], edge);
        g = mix(g, color[1], edge);
        b = mix(b, color[2], edge);
      }

      // centre highlight
      const coreR = S * 0.052;
      if (dist < coreR) {
        const alpha = Math.min(1, (coreR - dist) / (1.2 * SS)) * 0.9;
        r = mix(r, 235, alpha);
        g = mix(g, 253, alpha);
        b = mix(b, 255, alpha);
      }

      buffer[index] = Math.max(0, Math.min(255, Math.round(r)));
      buffer[index + 1] = Math.max(0, Math.min(255, Math.round(g)));
      buffer[index + 2] = Math.max(0, Math.min(255, Math.round(b)));
      buffer[index + 3] = 255;
    }
  }

  // downsample by averaging SS x SS blocks
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let rr = 0;
      let gg = 0;
      let bb = 0;
      let aa = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * S + (x * SS + sx)) * 4;
          rr += buffer[i];
          gg += buffer[i + 1];
          bb += buffer[i + 2];
          aa += buffer[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(rr / n);
      out[o + 1] = Math.round(gg / n);
      out[o + 2] = Math.round(bb / n);
      out[o + 3] = Math.round(aa / n);
    }
  }
  return out;
}

function generateIcons() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sizes = [192, 512];
  for (const size of sizes) {
    const rgba = renderIcon(size);
    const png = encodePng(size, size, rgba);
    fs.writeFileSync(path.join(OUT_DIR, `icon-${size}.png`), png);
    console.log(`[icons] wrote public/icon-${size}.png (${Math.round(png.length / 1024)} KB)`);
  }
}

if (require.main === module) {
  generateIcons();
}

module.exports = { generateIcons };
