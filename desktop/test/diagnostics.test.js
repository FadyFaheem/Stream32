const assert = require('node:assert/strict');
const {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createDiagnosticLogger,
  sanitizeLogText,
} = require('../src/diagnostic-log');
const { createDiagnostics } = require('../src/diagnostics');

test('rotates persistent logs and redacts sensitive values', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'stream32-logs-'));
  const homeDirectory = 'C:\\Users\\private-user';
  const userDataDirectory = `${homeDirectory}\\AppData\\Stream32`;
  let tick = 0;

  try {
    const logger = createDiagnosticLogger({
      directory,
      homeDirectory,
      keepFiles: 3,
      maxBytes: 260,
      now: () => new Date(tick++ * 1000),
      userDataDirectory,
    });

    for (let index = 0; index < 8; index++) {
      logger.info('test:event', {
        actionText: 'launch a private action',
        message:
          `failure at ${userDataDirectory} https://example.com ` +
          'data:image/png;base64,AAAA token=secret-value',
        sequence: index,
      });
    }

    const files = readdirSync(directory).sort();
    assert.deepEqual(files, [
      'stream32.log',
      'stream32.log.1',
      'stream32.log.2',
    ]);
    const content = files
      .map((file) => readFileSync(path.join(directory, file), 'utf8'))
      .join('');
    assert.doesNotMatch(content, /private-user|example\.com|AAAA|secret-value/);
    assert.match(content, /\[redacted\]|\[redacted-path\]/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('redacts command lines without hiding ordinary event messages', () => {
  assert.equal(
    sanitizeLogText('> tool.exe --password secret'),
    '[command line redacted]',
  );
  assert.equal(sanitizeLogText('Firmware flash completed'), 'Firmware flash completed');
});

test('diagnostics contain counts and plugin versions without private payloads', () => {
  const report = createDiagnostics({
    version: '1.2.3',
    settings: {
      displayBrightnessPercent: 70,
      serialDevices: [{ portName: 'COM42', serialNumber: 'private' }],
    },
    decks: {
      version: 2,
      devices: {
        aabbccddeeff: {
          defaultProfileId: 'default',
          profiles: {
            default: {
              pages: [
                {
                  keys: [{
                    index: 0,
                    image: 'data:image/png;base64,AAAA',
                    action: { type: 'launch', command: 'private.exe' },
                  }],
                },
              ],
            },
            live: {
              appMatches: {
                win32: {
                  kind: 'executable',
                  value: 'c:/users/private-user/apps/obs64.exe',
                },
              },
              pages: [{ keys: [{ index: 0 }, { index: 1 }] }],
            },
          },
        },
      },
    },
    pluginCatalog: {
      plugins: [{ id: 'safe-plugin', version: '2.0.0', actions: [] }],
      errors: [{
        file: 'broken.json',
        message: 'failed under C:\\Users\\private-user\\plugin.json',
      }],
    },
    homeDirectory: 'C:\\Users\\private-user',
    userDataDirectory: 'C:\\Users\\private-user\\AppData\\Stream32',
  });
  const text = JSON.stringify(report);

  assert.deepEqual(report.decks, {
    devices: 1,
    profiles: 2,
    defaultProfiles: 1,
    appMatches: {
      win32: 1,
      darwin: 0,
      linux: 0,
    },
    pages: 2,
    keys: 3,
  });
  assert.deepEqual(report.plugins.installed, [
    { id: 'safe-plugin', version: '2.0.0' },
  ]);
  assert.doesNotMatch(
    text,
    /COM42|private\.exe|private-user|data:image|aabbccddeeff/,
  );
});
