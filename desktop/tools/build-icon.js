// Builds assets/icon.ico, the Windows application icon, from the logo mark.
//
// Windows draws this at 16 to 32 pixels in the taskbar, the title bar and the
// tray, and asks the shell to scale whatever single image it is given. The
// brand mark is drawn as thin outlines, so a plain downscale leaves every
// stroke covering a fraction of a pixel: the result is a smear of low alpha
// that a light background still reads as a shape and a dark one swallows
// whole, which is what made it invisible on Windows 11 in dark mode.
//
// An .ico carries a rendition per size, so each small one is rendered here
// instead: cropped to the mark's own bounds, and with its alpha lifted enough
// that a half-covered stroke stays a stroke. Colours are untouched.
//
// Run from desktop/: node tools/build-icon.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const SOURCE = path.join(ASSETS, 'logo-mark.png');
const TARGET = path.join(ASSETS, 'icon.ico');

// Every size the Windows shell asks for, from the tray to the 256 the
// installer and the Explorer preview want.
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// How many times each rendition is composited over itself, which is what
// turns a 30%-covered stroke into a visible one. Anything already solid is
// unchanged, so this thickens without touching the shapes that survive on
// their own.
function alphaGain(size) {
  if (size <= 16) {
    return 3;
  }

  return size <= 24 ? 2.4 : size <= 32 ? 1.9 : size <= 48 ? 1.4 : 1;
}

// The mark is drawn with a margin of its own; a couple of percent is all the
// breathing room the shell needs on top.
const MARGIN = 0.02;

const CRC_TABLE = Array.from({ length: 256 }, (unused, index) => {
  let value = index;

  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }

  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;

  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }

  return (value ^ 0xffffffff) >>> 0;
}

function decodePng(file) {
  const buffer = fs.readFileSync(file);
  const parts = [];
  let offset = 8;
  let width = 0;
  let height = 0;

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);

      if (data[8] !== 8 || data[9] !== 6) {
        throw new Error(`${file} is not 8-bit RGBA`);
      }
    } else if (type === 'IDAT') {
      parts.push(data);
    }

    offset += length + 12;
  }

  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));

    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const corner = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
      let value = line[x];

      if (filter === 1) {
        value += left;
      } else if (filter === 2) {
        value += up;
      } else if (filter === 3) {
        value += (left + up) >> 1;
      } else if (filter === 4) {
        const guess = left + up - corner;
        const toLeft = Math.abs(guess - left);
        const toUp = Math.abs(guess - up);
        const toCorner = Math.abs(guess - corner);

        value += toLeft <= toUp && toLeft <= toCorner
          ? left
          : toUp <= toCorner ? up : corner;
      }

      pixels[y * stride + x] = value & 0xff;
    }
  }

  return { width, height, pixels };
}

function encodePng(image) {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);

  for (let y = 0; y < image.height; y++) {
    image.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12);

    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);

  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// The smallest square holding every pixel that is not fully transparent, so
// the mark fills its rendition rather than the canvas it was exported on.
function inkSquare(image) {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.pixels[(y * image.width + x) * 4 + 3] > 8) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }

  if (right < 0) {
    throw new Error('the source image is empty');
  }

  const side = Math.round(
    Math.max(right - left + 1, bottom - top + 1) * (1 + MARGIN * 2),
  );

  return {
    side,
    x: Math.round((left + right + 1 - side) / 2),
    y: Math.round((top + bottom + 1 - side) / 2),
  };
}

// Box filter over premultiplied colour, which is the only way a downscale of
// an image with transparent gaps keeps its edges from bleeding to black.
function render(image, crop, size) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = crop.side / size;
  const gain = alphaGain(size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = {
        x: crop.x + x * scale,
        y: crop.y + y * scale,
      };
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let samples = 0;

      for (
        let sy = Math.floor(from.y);
        sy < Math.ceil(from.y + scale);
        sy++
      ) {
        for (
          let sx = Math.floor(from.x);
          sx < Math.ceil(from.x + scale);
          sx++
        ) {
          samples++;

          if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) {
            continue;
          }

          const source = (sy * image.width + sx) * 4;
          const weight = image.pixels[source + 3] / 255;

          red += image.pixels[source] * weight;
          green += image.pixels[source + 1] * weight;
          blue += image.pixels[source + 2] * weight;
          alpha += weight;
        }
      }

      const target = (y * size + x) * 4;
      const covered = alpha / samples;

      pixels[target] = alpha > 0 ? Math.round(red / alpha) : 0;
      pixels[target + 1] = alpha > 0 ? Math.round(green / alpha) : 0;
      pixels[target + 2] = alpha > 0 ? Math.round(blue / alpha) : 0;
      pixels[target + 3] = Math.round(
        (1 - (1 - covered) ** gain) * 255,
      );
    }
  }

  return { width: size, height: size, pixels };
}

// A 32-bit bottom-up DIB with the empty AND mask every ICO entry still
// carries. Used below 128 px, where a raw bitmap is both smaller than a PNG
// and the encoding every Windows shell surface has always understood.
function encodeDib(image) {
  const stride = image.width * 4;
  const maskStride = Math.ceil(image.width / 32) * 4;
  const header = Buffer.alloc(40);
  const body = Buffer.alloc(stride * image.height);
  const mask = Buffer.alloc(maskStride * image.height);

  header.writeUInt32LE(40, 0);
  header.writeInt32LE(image.width, 4);
  header.writeInt32LE(image.height * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(body.length + mask.length, 20);

  for (let y = 0; y < image.height; y++) {
    const row = (image.height - 1 - y) * stride;

    for (let x = 0; x < image.width; x++) {
      const source = y * stride + x * 4;

      body[row + x * 4] = image.pixels[source + 2];
      body[row + x * 4 + 1] = image.pixels[source + 1];
      body[row + x * 4 + 2] = image.pixels[source];
      body[row + x * 4 + 3] = image.pixels[source + 3];
    }
  }

  return Buffer.concat([header, body, mask]);
}

function encodeIco(images) {
  const entries = images.map((image) => ({
    size: image.width,
    // PNG only at the sizes it was introduced for; a DIB stays universal.
    data: image.width >= 128 ? encodePng(image) : encodeDib(image),
  }));
  const directory = Buffer.alloc(6 + entries.length * 16);
  let offset = directory.length;

  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(entries.length, 4);

  entries.forEach((entry, index) => {
    const at = 6 + index * 16;

    directory[at] = entry.size === 256 ? 0 : entry.size;
    directory[at + 1] = entry.size === 256 ? 0 : entry.size;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([directory, ...entries.map((entry) => entry.data)]);
}

function renditions() {
  const source = decodePng(SOURCE);
  const crop = inkSquare(source);

  return SIZES.map((size) => render(source, crop, size));
}

function buildIcon() {
  return encodeIco(renditions());
}

if (require.main === module) {
  fs.writeFileSync(TARGET, buildIcon());
  console.log(
    `Wrote ${path.relative(process.cwd(), TARGET)} (${SIZES.join(', ')} px).`,
  );
}

module.exports = { SIZES, SOURCE, TARGET, buildIcon, decodePng, renditions };
