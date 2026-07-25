const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const {
  decodeText,
  encodeSatelliteMessage,
  normalizeColor,
  parseKeyReference,
  parseSatelliteLine,
  truncateLabel,
} = require('../src/companion-protocol');
const { createCompanionSatellite } = require('../src/companion-satellite');

const DEVICE_ID = 'aabbccddeeff';

// Minimal stand-in for Companion's Satellite server: it records every line the
// client sends and lets a test wait for the one it cares about.
function startFakeCompanion() {
  const received = [];
  const waiters = [];
  let connection = null;

  const server = net.createServer((socket) => {
    connection = socket;
    socket.setEncoding('utf8');
    socket.write('BEGIN CompanionVersion=4.0.0 ApiVersion=1.10.0\n');

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;

      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        received.push(line);

        for (const [index, waiter] of [...waiters.entries()].reverse()) {
          if (line.startsWith(waiter.prefix)) {
            waiters.splice(index, 1);
            waiter.resolve(line);
          }
        }
      }
    });
  });

  return {
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    nextLine(prefix) {
      const existing = received.find((line) => line.startsWith(prefix));

      if (existing) {
        return Promise.resolve(existing);
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${prefix}`)),
          4000,
        );
        waiters.push({
          prefix,
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
        });
      });
    },
    send(line) {
      connection.write(line);
    },
    // Lines are processed in order, so a returned pong proves the client has
    // already handled everything sent before the ping.
    sync(token) {
      connection.write(`PING ${token}\n`);
      return this.nextLine(`PONG ${token}`);
    },
    async stop() {
      connection?.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('registers a surface and relays state and presses over TCP', async () => {
  const companion = startFakeCompanion();
  const port = await companion.listen();
  const keyStates = [];
  const cleared = [];
  const client = createCompanionSatellite({
    onKeyState: (state) => keyStates.push(state),
    onKeysClear: (deviceId) => cleared.push(deviceId),
    onStatus: () => {},
  });

  try {
    client.setConfig({ host: '127.0.0.1', port });
    client.addSurface({
      deviceId: DEVICE_ID,
      productName: 'Stream32 desk deck',
      rows: 4,
      cols: 8,
      bitmapSize: 60,
    });

    const registration = parseSatelliteLine(
      await companion.nextLine('ADD-DEVICE'),
    );
    assert.equal(registration.params.get('DEVICEID'), DEVICE_ID);
    assert.equal(registration.params.get('PRODUCT_NAME'), 'Stream32 desk deck');
    assert.equal(registration.params.get('KEYS_TOTAL'), '32');
    assert.equal(registration.params.get('KEYS_PER_ROW'), '8');
    assert.equal(registration.params.get('BITMAPS'), '60');
    assert.equal(registration.params.get('SERIAL'), `stream32:${DEVICE_ID}`);
    companion.send(`ADD-DEVICE OK DEVICEID=${DEVICE_ID}\n`);

    const bitmap = Buffer.alloc(60 * 60 * 3, 7);
    companion.send(
      `KEY-STATE DEVICEID=${DEVICE_ID} KEY=1/2 COLOR=#FF0000 ` +
        `TEXT=${Buffer.from('Go Live', 'utf8').toString('base64')} ` +
        `BITMAP=${bitmap.toString('base64')}\n`,
    );
    await companion.sync('after-key-state');

    assert.equal(keyStates.length, 1);
    assert.equal(keyStates[0].index, 10);
    assert.equal(keyStates[0].color, '#ff0000');
    assert.equal(keyStates[0].label, 'Go Live');
    assert.equal(keyStates[0].bitmap.length, bitmap.length);

    client.keyPress(DEVICE_ID, 5, true);
    assert.equal(
      await companion.nextLine('KEY-PRESS'),
      `KEY-PRESS DEVICEID=${DEVICE_ID} KEY=5 PRESSED=true`,
    );

    companion.send(`KEYS-CLEAR DEVICEID=${DEVICE_ID}\n`);
    await companion.sync('after-keys-clear');
    assert.deepEqual(cleared, [DEVICE_ID]);

    client.removeSurface(DEVICE_ID);
    assert.equal(
      await companion.nextLine('REMOVE-DEVICE'),
      `REMOVE-DEVICE DEVICEID=${DEVICE_ID}`,
    );
    assert.equal(client.getStatus().state, 'idle');
  } finally {
    client.dispose();
    await companion.stop();
  }
});

test('drops a bitmap whose length does not match the requested size', async () => {
  const companion = startFakeCompanion();
  const port = await companion.listen();
  const keyStates = [];
  const client = createCompanionSatellite({
    onKeyState: (state) => keyStates.push(state),
    onStatus: () => {},
  });

  try {
    client.setConfig({ host: '127.0.0.1', port });
    client.addSurface({
      deviceId: DEVICE_ID,
      productName: 'Deck',
      rows: 2,
      cols: 2,
      bitmapSize: 32,
    });
    await companion.nextLine('ADD-DEVICE');
    companion.send(
      `KEY-STATE DEVICEID=${DEVICE_ID} KEY=0 ` +
        `BITMAP=${Buffer.from('data:image/png;base64,x').toString('base64')}\n`,
    );
    companion.send(`KEY-STATE DEVICEID=${DEVICE_ID} KEY=9 COLOR=#000000\n`);
    await companion.sync('after-key-states');

    assert.equal(keyStates.length, 1);
    assert.equal(keyStates[0].index, 0);
    assert.equal(keyStates[0].bitmap, null);
  } finally {
    client.dispose();
    await companion.stop();
  }
});

test('encodes plain values without quoting', () => {
  assert.equal(
    encodeSatelliteMessage('KEY-PRESS', {
      DEVICEID: 'aabbccddeeff',
      KEY: 4,
      PRESSED: true,
    }),
    'KEY-PRESS DEVICEID=aabbccddeeff KEY=4 PRESSED=true\n',
  );
});

test('quotes and escapes values that would break the line format', () => {
  assert.equal(
    encodeSatelliteMessage('ADD-DEVICE', {
      PRODUCT_NAME: 'Stream32 "desk" deck',
      EMPTY: '',
    }),
    'ADD-DEVICE PRODUCT_NAME="Stream32 \\"desk\\" deck" EMPTY=""\n',
  );
});

test('skips undefined and null parameters', () => {
  assert.equal(
    encodeSatelliteMessage('ADD-DEVICE', { A: 1, B: undefined, C: null }),
    'ADD-DEVICE A=1\n',
  );
});

test('parses commands, status words, and parameters', () => {
  const message = parseSatelliteLine(
    'ADD-DEVICE ERROR DEVICEID=00000 MESSAGE="Surface is already in use"',
  );
  assert.equal(message.command, 'ADD-DEVICE');
  assert.equal(message.status, 'ERROR');
  assert.equal(message.params.get('DEVICEID'), '00000');
  assert.equal(message.params.get('MESSAGE'), 'Surface is already in use');
});

test('parses escaped characters inside quoted values', () => {
  const message = parseSatelliteLine('ERROR MESSAGE="say \\"hi\\"\\nnow"');
  assert.equal(message.params.get('MESSAGE'), 'say "hi"\nnow');
});

test('keeps ping payload case so it can be echoed verbatim', () => {
  assert.equal(parseSatelliteLine('PING aBc123').status, 'aBc123');
});

test('round-trips a value through the encoder and parser', () => {
  const value = 'a b\\c"d';
  const line = encodeSatelliteMessage('X', { V: value }).trimEnd();
  assert.equal(parseSatelliteLine(line).params.get('V'), value);
});

test('resolves both flat and row/column key references', () => {
  assert.equal(parseKeyReference('11', 8), 11);
  assert.equal(parseKeyReference('1/3', 8), 11);
  assert.equal(parseKeyReference('0/0', 8), 0);
});

test('rejects key references outside the surface', () => {
  assert.equal(parseKeyReference('1/9', 8), null);
  assert.equal(parseKeyReference('-1', 8), null);
  assert.equal(parseKeyReference('', 8), null);
  assert.equal(parseKeyReference(undefined, 8), null);
});

test('normalizes the colour notations Companion can send', () => {
  assert.equal(normalizeColor('#00FF00'), '#00ff00');
  assert.equal(normalizeColor('#0f0'), '#00ff00');
  assert.equal(normalizeColor('rgb(0,255,0)'), '#00ff00');
  assert.equal(normalizeColor('rgb(300,0,0)'), '#ff0000');
  assert.equal(normalizeColor('rgb(0,-5,0)'), null);
  assert.equal(normalizeColor('chartreuse'), null);
  assert.equal(normalizeColor(undefined), null);
});

test('decodes base64 button text down to a single bounded label', () => {
  const encoded = Buffer.from('Live\nProgram', 'utf8').toString('base64');
  assert.equal(decodeText(encoded, 32), 'Live');
  assert.equal(decodeText('', 32), '');
  assert.equal(decodeText(undefined, 32), '');
});

test('truncates labels on whole code points within the byte budget', () => {
  assert.equal(Buffer.byteLength(truncateLabel('🎛️🎛️🎛️🎛️', 8), 'utf8') <= 8, true);
  assert.equal(truncateLabel('abc', 8), 'abc');
  assert.equal(truncateLabel('abcdefghij', 4), 'abcd');
});
