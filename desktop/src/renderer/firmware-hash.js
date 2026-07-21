const SparkMD5 = require('spark-md5');

function calculateFirmwareMd5(image) {
  const bytes = image.buffer.slice(
    image.byteOffset,
    image.byteOffset + image.byteLength,
  );

  return SparkMD5.ArrayBuffer.hash(bytes);
}

module.exports = { calculateFirmwareMd5 };
