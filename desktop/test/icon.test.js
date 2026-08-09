const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const {
  SIZES,
  SOURCE,
  TARGET,
  buildIcon,
  decodePng,
  renditions,
} = require('../tools/build-icon.js');

// Only the directory and the uncompressed renditions, which is all these
// assertions need and keeps them off zlib's exact output.
function readIco(bytes) {
  const frames = new Map();

  for (let index = 0; index < bytes.readUInt16LE(4); index++) {
    const entry = 6 + index * 16;
    const offset = bytes.readUInt32LE(entry + 12);
    const data = bytes.subarray(offset, offset + bytes.readUInt32LE(entry + 8));
    const declared = bytes[entry] === 0 ? 256 : bytes[entry];

    if (data.readUInt32BE(0) === 0x89504e47) {
      frames.set(declared, null);
      continue;
    }

    const width = data.readInt32LE(4);
    const height = data.readInt32LE(8) / 2;
    const stride = width * 4;
    const alpha = new Uint8Array(width * height);

    assert.equal(width, declared, `entry ${index} declares the wrong width`);
    assert.equal(height, declared, `entry ${index} declares the wrong height`);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        alpha[y * width + x] = data[40 + (height - 1 - y) * stride + x * 4 + 3];
      }
    }

    frames.set(declared, alpha);
  }

  return frames;
}

// What a shell gets when it scales one large image down: the source's own
// coverage, unaided. This is what the .ico replaces.
function plainCoverage(size) {
  const image = decodePng(SOURCE);
  const scale = image.width / size;
  let covered = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let alpha = 0;
      let samples = 0;

      for (let sy = Math.floor(y * scale); sy < (y + 1) * scale; sy++) {
        for (let sx = Math.floor(x * scale); sx < (x + 1) * scale; sx++) {
          alpha += image.pixels[(sy * image.width + sx) * 4 + 3] / 255;
          samples++;
        }
      }

      covered += alpha / samples >= 0.75 ? 1 : 0;
    }
  }

  return covered / (size * size);
}

test('the committed Windows icon still matches the logo mark', () => {
  // Editing the artwork without re-running tools/build-icon.js would ship an
  // icon of the previous mark, which nothing else would notice.
  assert.deepEqual(
    readIco(readFileSync(TARGET)),
    readIco(buildIcon()),
  );
});

test('the icon offers every size the Windows shell asks for', () => {
  assert.deepEqual([...readIco(readFileSync(TARGET)).keys()], SIZES);
});

test('small renditions stay solid enough to see on a dark taskbar', () => {
  // The mark is drawn as thin outlines, so scaling one large image down
  // leaves most of it at a fraction of a pixel: a smear of low alpha that a
  // light background still reads as a shape and a dark one swallows. Each
  // rendition is drawn to keep those strokes opaque instead, which is the
  // whole reason the .ico exists.
  const drawn = new Map(
    renditions().map((image) => [
      image.width,
      image.pixels.filter((unused, index) => index % 4 === 3 && unused >= 191)
        .length / (image.width * image.height),
    ]),
  );

  for (const size of [16, 24, 32]) {
    assert.ok(
      drawn.get(size) > plainCoverage(size) * 1.5,
      `${size} px covers ${(drawn.get(size) * 100).toFixed(1)}% against ` +
        `${(plainCoverage(size) * 100).toFixed(1)}% from a plain downscale`,
    );
    assert.ok(
      drawn.get(size) > 0.15,
      `${size} px is only ${(drawn.get(size) * 100).toFixed(1)}% opaque`,
    );
  }
});
