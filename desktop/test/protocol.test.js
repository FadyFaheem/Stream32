const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_PROTOCOL_LINE_LENGTH,
  crc32,
  createLineDecoder,
  encodeDisplayMessage,
  encodeHostHello,
  encodeImageChunks,
  encodeKeyUpdateMessage,
  encodeLayoutMessage,
  encodePageMessage,
  encodeRle565,
  isExpectedChip,
  layoutLineLimitFor,
  validateDeviceHello,
  validateImageAck,
  validateKeyUpdateAck,
  validateLayoutAck,
  validatePageMessage,
  validatePressMessage,
  validateTouchMessage,
} = require('../src/renderer/protocol');

function decodeRle565Reference(encoded) {
  assert.equal(encoded.length % 4, 0);
  const output = [];

  for (let offset = 0; offset < encoded.length; offset += 4) {
    const count = encoded[offset] | (encoded[offset + 1] << 8);
    assert.ok(count > 0);

    for (let run = 0; run < count; run++) {
      output.push(encoded[offset + 2], encoded[offset + 3]);
    }
  }

  return Uint8Array.from(output);
}

function chunkMessages(chunks) {
  return chunks.map((chunk) => JSON.parse(new TextDecoder().decode(chunk)));
}

function decodeBase64(text) {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}

test('encodes the versioned desktop hello', () => {
  assert.equal(
    new TextDecoder().decode(encodeHostHello()),
    '{"type":"hello","protocol":1,"features":["key-update"]}\n',
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

  assert.deepEqual(
    validateDeviceHello(
      { ...hello, features: ['display-control'] },
      hello.boardId,
    ).features,
    ['display-control'],
  );
  assert.throws(
    () =>
      validateDeviceHello(
        { ...hello, features: ['display-control', 'display-control'] },
        hello.boardId,
      ),
    /features/,
  );
  assert.throws(
    () =>
      validateDeviceHello(
        {
          ...hello,
          features: Array.from({ length: 17 }, (_, index) => `feature-${index}`),
        },
        hello.boardId,
      ),
    /features/,
  );
  assert.throws(
    () =>
      validateDeviceHello(
        { ...hello, features: ['A'.repeat(33)] },
        hello.boardId,
      ),
    /features/,
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
        {
          index: 0,
          label: 'OBS',
          color: '#ff5533',
          labelColor: '#ffffff',
          imageCrc: 'deadbeef',
        },
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
      {
        index: 0,
        label: 'OBS',
        color: '#ff5533',
        labelColor: '#ffffff',
        imageCrc: 'deadbeef',
      },
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
        page: 0,
        of: 1,
        rows: 2,
        cols: 2,
        keys: [{ index: 0, labelColor: 'white' }],
      }),
    /label color/,
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

test('page layouts respect the per-board line budgets', () => {
  function decoratedKeys(count) {
    return Array.from({ length: count }, (_, index) => ({
      index,
      label: 'W'.repeat(32),
      color: '#aabbcc',
      labelColor: '#ddeeff',
      imageCrc: '9a3f11d2',
      goPage: 7,
    }));
  }

  // 30 fully decorated keys are the most the baseline 4096-byte line fits.
  const baseline = encodeLayoutMessage({
    page: 7,
    of: 8,
    rows: 5,
    cols: 6,
    keys: decoratedKeys(30),
  });
  assert.ok(baseline.length <= MAX_PROTOCOL_LINE_LENGTH);

  // A fully decorated 9x4 page exceeds the baseline but fits the extended
  // budget advertised by boards with deck.maxKeys above 30.
  const nineByFour = {
    page: 0,
    of: 8,
    rows: 4,
    cols: 9,
    keys: decoratedKeys(36),
  };
  assert.throws(() => encodeLayoutMessage(nineByFour), RangeError);
  assert.equal(layoutLineLimitFor({ maxKeys: 25 }), 4096);
  assert.equal(layoutLineLimitFor({ maxKeys: 40 }), 8180);
  const extended = encodeLayoutMessage(
    nineByFour,
    layoutLineLimitFor({ maxKeys: 40 }),
  );
  assert.ok(extended.length <= 8180);

  // Axis and per-page key budgets stay bounded.
  assert.throws(
    () =>
      encodeLayoutMessage({
        page: 0,
        of: 1,
        rows: 5,
        cols: 11,
        keys: [],
      }),
    /cols/,
  );
  assert.throws(
    () =>
      encodeLayoutMessage({
        page: 0,
        of: 1,
        rows: 10,
        cols: 5,
        keys: [],
      }),
    /keys per page/,
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

test('round-trips bounded RGB565 run-length tuples', () => {
  const pixels = Uint8Array.from([
    0x00, 0x00,
    0x00, 0x00,
    0x34, 0x12,
    0x34, 0x12,
    0x34, 0x12,
    0xff, 0xff,
  ]);
  const encoded = encodeRle565(pixels);

  assert.deepEqual(
    [...encoded],
    [2, 0, 0, 0, 3, 0, 0x34, 0x12, 1, 0, 0xff, 0xff],
  );
  assert.deepEqual(decodeRle565Reference(encoded), pixels);
});

test('gates RLE by feature and falls back for incompressible pixels', () => {
  const flat = new Uint8Array(180 * 180 * 2).fill(0x44);
  const legacy = chunkMessages(
    encodeImageChunks({
      page: 0,
      index: 0,
      width: 180,
      height: 180,
      pixels: flat,
    }),
  );
  const capable = chunkMessages(
    encodeImageChunks({
      page: 0,
      index: 0,
      width: 180,
      height: 180,
      pixels: flat,
      rleSupported: true,
    }),
  );

  assert.equal(legacy[0].encoding, undefined);
  assert.equal(capable[0].encoding, 'rle565');

  const noisy = new Uint8Array(180 * 180 * 2);
  for (let pixel = 0; pixel < noisy.length / 2; pixel++) {
    noisy[pixel * 2] = pixel & 1;
    noisy[pixel * 2 + 1] = 0;
  }
  assert.equal(encodeRle565(noisy).length, noisy.length * 2);
  assert.equal(
    chunkMessages(
      encodeImageChunks({
        page: 0,
        index: 0,
        width: 180,
        height: 180,
        pixels: noisy,
        rleSupported: true,
      }),
    )[0].encoding,
    undefined,
  );
});

test('keeps RLE tuples within worst-case and chunk bounds', () => {
  const maximum = new Uint8Array(512 * 512 * 2).fill(0xab);
  const maximumRle = encodeRle565(maximum);
  assert.equal(maximumRle.length, Math.ceil(512 * 512 / 0xffff) * 4);
  assert.deepEqual(decodeRle565Reference(maximumRle), maximum);

  const grouped = new Uint8Array(180 * 180 * 2);
  for (let pixel = 0; pixel < grouped.length / 2; pixel++) {
    const color = Math.floor(pixel / 3) & 0xffff;
    grouped[pixel * 2] = color & 0xff;
    grouped[pixel * 2 + 1] = color >>> 8;
  }
  const chunks = encodeImageChunks({
    page: 0,
    index: 0,
    width: 180,
    height: 180,
    pixels: grouped,
    rleSupported: true,
  });
  const messages = chunkMessages(chunks);
  const encodedParts = messages.map((message, index) => {
    assert.equal(message.encoding, 'rle565');
    assert.equal(message.seq, index);
    assert.equal(message.of, chunks.length);
    assert.ok(chunks[index].length <= MAX_PROTOCOL_LINE_LENGTH);
    const part = decodeBase64(message.data);
    assert.equal(part.length % 4, 0);
    return part;
  });
  const encoded = Uint8Array.from(encodedParts.flatMap((part) => [...part]));

  assert.deepEqual(decodeRle565Reference(encoded), grouped);
});

test('encodes bounded live key patches and ephemeral image mode', () => {
  const patch = JSON.parse(new TextDecoder().decode(encodeKeyUpdateMessage({
    page: 2,
    index: 7,
    label: 'Live',
    color: '#112233',
    labelColor: '#ffffff',
    state: 'on',
    imageCrc: 'deadbeef',
  })));
  assert.deepEqual(patch, {
    type: 'key-update',
    page: 2,
    index: 7,
    label: 'Live',
    color: '#112233',
    labelColor: '#ffffff',
    state: 'on',
    imageCrc: 'deadbeef',
  });
  assert.throws(
    () => encodeKeyUpdateMessage({ page: 0, index: 40, state: 'on' }),
    /range/,
  );
  assert.throws(
    () => encodeKeyUpdateMessage({ page: 0, index: 0, state: 'maybe' }),
    /state/,
  );

  const chunks = encodeImageChunks({
    page: 0,
    index: 0,
    width: 2,
    height: 2,
    pixels: new Uint8Array(8),
    mode: 'ephemeral',
  });
  assert.equal(
    JSON.parse(new TextDecoder().decode(chunks[0])).mode,
    'ephemeral',
  );
  assert.deepEqual(validateKeyUpdateAck({
    page: 0,
    index: 0,
    needImage: true,
  }), { page: 0, index: 0, needImage: true });
});

test('enforces label and line limits in UTF-8 bytes', () => {
  const layout = {
    page: 0,
    of: 1,
    rows: 1,
    cols: 1,
    keys: [{ index: 0, label: 'é'.repeat(16) }],
  };
  const encoded = encodeLayoutMessage(layout);
  const characterLength = new TextDecoder().decode(encoded).length;

  assert.ok(characterLength < encoded.byteLength);
  assert.throws(
    () => encodeLayoutMessage(layout, encoded.byteLength - 1),
    /exceeds the limit/,
  );
  assert.throws(
    () => encodeLayoutMessage({
      ...layout,
      keys: [{ index: 0, label: 'é'.repeat(17) }],
    }),
    /label/,
  );
  assert.throws(
    () => encodeKeyUpdateMessage({
      page: 0,
      index: 0,
      label: 'é'.repeat(17),
    }),
    /label/,
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

test('encodes validated display policy messages', () => {
  assert.equal(
    new TextDecoder().decode(
      encodeDisplayMessage({ awake: false, idleTimeoutSeconds: 600 }),
    ),
    '{"type":"display","awake":false,"idleTimeoutSeconds":600}\n',
  );
  assert.equal(
    new TextDecoder().decode(
      encodeDisplayMessage({
        awake: true,
        idleTimeoutSeconds: 300,
        brightness: 42,
      }),
    ),
    '{"type":"display","awake":true,"idleTimeoutSeconds":300,"brightness":42}\n',
  );
  assert.throws(
    () => encodeDisplayMessage({ awake: 'yes', idleTimeoutSeconds: 600 }),
    /boolean/,
  );
  assert.throws(
    () => encodeDisplayMessage({ awake: true, idleTimeoutSeconds: 86401 }),
    /range/,
  );
  assert.throws(
    () =>
      encodeDisplayMessage({
        awake: true,
        idleTimeoutSeconds: 600,
        brightness: 101,
      }),
    /range/,
  );
});

test('validates touch bounds and chip names', () => {
  // A 1024x600 panel reports coordinates past the old 480px square limit.
  assert.deepEqual(
    validateTouchMessage({
      phase: 'down',
      type: 'touch',
      x: 1023,
      y: 599,
    }),
    { phase: 'down', x: 1023, y: 599 },
  );
  assert.throws(
    () =>
      validateTouchMessage({
        phase: 'down',
        type: 'touch',
        x: 4096,
        y: 0,
      }),
    /invalid/,
  );
  assert.throws(
    () =>
      validateTouchMessage({
        phase: 'down',
        type: 'touch',
        x: -1,
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
  assert.equal(isExpectedChip('ESP32-P4', 'ESP32-P4'), true);
  assert.equal(isExpectedChip('ESP32-C3', 'ESP32-S3'), false);
});
