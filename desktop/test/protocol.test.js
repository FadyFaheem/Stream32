const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_PROTOCOL_LINE_LENGTH,
  crc32,
  createLineDecoder,
  encodeHostHello,
  encodeImageChunks,
  encodeLayoutMessage,
  encodePageMessage,
  isExpectedChip,
  validateDeviceHello,
  validateImageAck,
  validateLayoutAck,
  validatePageMessage,
  validatePressMessage,
  validateTouchMessage,
} = require('../src/renderer/protocol');

test('encodes the versioned desktop hello', () => {
  assert.equal(
    new TextDecoder().decode(encodeHostHello()),
    '{"type":"hello","protocol":1}\n',
  );
});

test('decodes newline JSON split across serial chunks', () => {
  const messages = [];
  const errors = [];
  const decoder = createLineDecoder({
    onError: (error) => errors.push(error),
    onMessage: (message) => messages.push(message),
  });
  const encoder = new TextEncoder();

  decoder.push(encoder.encode('{"type":"hel'));
  decoder.push(encoder.encode('lo","protocol":1}\r\n'));

  assert.deepEqual(messages, [{ protocol: 1, type: 'hello' }]);
  assert.deepEqual(errors, []);
});

test('drops oversized and malformed device messages', () => {
  const errors = [];
  const decoder = createLineDecoder({
    onError: (error) => errors.push(error),
    onMessage: () => assert.fail('Invalid messages must not be emitted.'),
  });
  const encoder = new TextEncoder();

  decoder.push(encoder.encode(`${'x'.repeat(MAX_PROTOCOL_LINE_LENGTH + 1)}\n`));
  decoder.push(encoder.encode('{bad json}\n'));

  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /exceeded/);
  assert.match(errors[1].message, /JSON/);
});

test('validates device identity and rejects the wrong board', () => {
  const hello = {
    boardId: 'waveshare-esp32-s3-touch-lcd-4-v3',
    deviceId: 'aabbccddeeff',
    firmwareVersion: '0.1.0',
    protocol: 1,
    type: 'hello',
  };

  assert.deepEqual(
    validateDeviceHello(
      hello,
      'waveshare-esp32-s3-touch-lcd-4-v3',
    ),
    hello,
  );
  assert.throws(
    () => validateDeviceHello(hello, 'another-board'),
    /not another-board/,
  );
  assert.throws(
    () =>
      validateDeviceHello(
        hello,
        hello.boardId,
        1,
        '0.2.0',
      ),
    /expected 0.2.0/,
  );
});

test('computes standard zlib CRC-32 hex digests', () => {
  // Reference vectors for CRC-32/ISO-HDLC, the polynomial used by
  // esp_rom_crc32_le(0, …) on the device.
  assert.equal(crc32(new TextEncoder().encode('123456789')), 'cbf43926');
  assert.equal(crc32(new Uint8Array(0)), '00000000');
  assert.equal(crc32(new Uint8Array([0xff, 0x00, 0xff])), '6cdb0272');
});

test('encodes layout pages and rejects invalid keys', () => {
  const line = new TextDecoder().decode(
    encodeLayoutMessage({
      page: 0,
      of: 2,
      rows: 2,
      cols: 3,
      keys: [
        { index: 0, label: 'OBS', color: '#ff5533', imageCrc: 'deadbeef' },
        { index: 5, goPage: 1 },
      ],
    }),
  );

  assert.deepEqual(JSON.parse(line), {
    type: 'layout',
    page: 0,
    of: 2,
    rows: 2,
    cols: 3,
    keys: [
      { index: 0, label: 'OBS', color: '#ff5533', imageCrc: 'deadbeef' },
      { index: 5, goPage: 1 },
    ],
  });
  assert.throws(
    () =>
      encodeLayoutMessage({
        page: 0,
        of: 1,
        rows: 2,
        cols: 2,
        keys: [{ index: 4 }],
      }),
    /outside the supported range/,
  );
  assert.throws(
    () =>
      encodeLayoutMessage({
        page: 0,
        of: 1,
        rows: 2,
        cols: 2,
        keys: [{ index: 0, color: 'red' }],
      }),
    /color/,
  );
  assert.throws(
    () =>
      encodeLayoutMessage({
        page: 1,
        of: 1,
        rows: 2,
        cols: 2,
        keys: [],
      }),
    /inconsistent/,
  );
});

test('chunks images under the protocol line limit', () => {
  const pixels = new Uint8Array(96 * 96 * 2).fill(0xa5);
  const chunks = encodeImageChunks({
    page: 1,
    index: 3,
    width: 96,
    height: 96,
    pixels,
  });

  assert.equal(chunks.length, Math.ceil(pixels.length / 2688));

  let reassembled = new Uint8Array(0);

  for (const [seq, chunk] of chunks.entries()) {
    assert.ok(chunk.length <= MAX_PROTOCOL_LINE_LENGTH);

    const message = JSON.parse(new TextDecoder().decode(chunk));
    assert.equal(message.type, 'image');
    assert.equal(message.page, 1);
    assert.equal(message.index, 3);
    assert.equal(message.seq, seq);
    assert.equal(message.of, chunks.length);

    const raw = Uint8Array.from(atob(message.data), (c) => c.charCodeAt(0));
    const merged = new Uint8Array(reassembled.length + raw.length);
    merged.set(reassembled);
    merged.set(raw, reassembled.length);
    reassembled = merged;
  }

  assert.deepEqual(reassembled, pixels);
  assert.throws(
    () =>
      encodeImageChunks({
        page: 0,
        index: 0,
        width: 8,
        height: 8,
        pixels: new Uint8Array(3),
      }),
    /RGB565/,
  );
});

test('validates deck acknowledgements and events', () => {
  assert.deepEqual(
    validateLayoutAck({
      type: 'layout-ack',
      page: 0,
      rows: 3,
      cols: 3,
      keyPx: 150,
      needImages: [0, 8],
    }),
    { page: 0, rows: 3, cols: 3, keyPx: 150, needImages: [0, 8] },
  );
  assert.throws(
    () =>
      validateLayoutAck({
        page: 0,
        rows: 3,
        cols: 3,
        keyPx: 150,
        needImages: [9],
      }),
    /needImages/,
  );
  assert.deepEqual(validateImageAck({ page: 0, index: 4, seq: 2 }), {
    page: 0,
    index: 4,
    seq: 2,
  });
  assert.deepEqual(
    new TextDecoder().decode(encodePageMessage(2)),
    '{"type":"page","index":2}\n',
  );
  assert.deepEqual(validatePageMessage({ index: 1 }), { index: 1 });
  assert.deepEqual(
    validatePressMessage({ page: 1, index: 7, phase: 'down' }),
    { page: 1, index: 7, phase: 'down' },
  );
  assert.throws(
    () => validatePressMessage({ page: 0, index: 0, phase: 'held' }),
    /invalid/,
  );
});

test('validates touch bounds and chip names', () => {
  assert.deepEqual(
    validateTouchMessage({
      phase: 'down',
      type: 'touch',
      x: 479,
      y: 0,
    }),
    { phase: 'down', x: 479, y: 0 },
  );
  assert.throws(
    () =>
      validateTouchMessage({
        phase: 'down',
        type: 'touch',
        x: 480,
        y: 0,
      }),
    /invalid/,
  );
  assert.equal(
    isExpectedChip(
      'ESP32-S3 (QFN56) (revision v0.2)',
      'esp32 s3',
    ),
    true,
  );
  assert.equal(isExpectedChip('ESP32-C3', 'ESP32-S3'), false);
});
