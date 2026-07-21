const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_PROTOCOL_LINE_LENGTH,
  createLineDecoder,
  encodeHostHello,
  isExpectedChip,
  validateDeviceHello,
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
