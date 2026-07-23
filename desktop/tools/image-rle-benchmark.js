const { encodeImageChunks } = require('../src/renderer/protocol');

const KEY_PX = 180;

function makeImage(pixelAt) {
  const pixels = new Uint8Array(KEY_PX * KEY_PX * 2);

  for (let y = 0; y < KEY_PX; y++) {
    for (let x = 0; x < KEY_PX; x++) {
      const color = pixelAt(x, y);
      const offset = (y * KEY_PX + x) * 2;
      pixels[offset] = color & 0xff;
      pixels[offset + 1] = color >>> 8;
    }
  }

  return pixels;
}

function wireBytes(pixels, rleSupported) {
  return encodeImageChunks({
    page: 0,
    index: 0,
    width: KEY_PX,
    height: KEY_PX,
    pixels,
    rleSupported,
  }).reduce((total, chunk) => total + chunk.length, 0);
}

function benchmarkImages() {
  return [
    {
      name: 'flat',
      pixels: makeImage(() => 0x18e3),
    },
    {
      name: 'striped-icon',
      pixels: makeImage((x, y) => {
        if (x < 8 || x >= 172 || y < 8 || y >= 172) {
          return 0xffff;
        }
        if (x >= 52 && x < 128 && y >= 48 && y < 132) {
          return y % 16 < 8 ? 0xf800 : 0xfd20;
        }
        return y % 24 < 12 ? 0x0841 : 0x1082;
      }),
    },
  ];
}

function runBenchmark() {
  return benchmarkImages().map(({ name, pixels }) => {
    const rawWireBytes = wireBytes(pixels, false);
    const rleWireBytes = wireBytes(pixels, true);

    return {
      name,
      rawWireBytes,
      rleWireBytes,
      reductionPercent:
        Math.round((1 - rleWireBytes / rawWireBytes) * 1000) / 10,
    };
  });
}

if (require.main === module) {
  for (const result of runBenchmark()) {
    console.log(
      `${result.name}: ${result.rawWireBytes} raw wire bytes -> ` +
        `${result.rleWireBytes} RLE wire bytes ` +
        `(${result.reductionPercent}% reduction)`,
    );
  }
}

module.exports = { runBenchmark };
