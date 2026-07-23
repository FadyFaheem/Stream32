const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createFocusWatcher,
  platformCapability,
} = require('../src/focus-watcher');

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function linuxSnapshot(name, processId = 42) {
  return {
    platform: 'linux',
    processId,
    identities: [{ kind: 'wmClass', value: name }],
  };
}

test('focus watcher emits identity changes only and stops its fake probe', async () => {
  const changes = [];
  const snapshots = [
    linuxSnapshot('obs', 1),
    linuxSnapshot('stream32', 2),
    linuxSnapshot('obs', 3),
    linuxSnapshot('firefox', 4),
  ];
  let probes = 0;
  let intervalCallback;
  let cleared = false;
  const watcher = createFocusWatcher({
    platform: 'linux',
    environment: { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' },
    probe: async () => snapshots[Math.min(probes++, snapshots.length - 1)],
    isOwnSnapshot: (snapshot) => snapshot.processId === 2,
    onChange: (snapshot) => changes.push(snapshot),
    setIntervalFn(callback) {
      intervalCallback = callback;
      return { unref() {} };
    },
    clearIntervalFn() {
      cleared = true;
    },
  });

  watcher.start();
  await flush();
  await watcher.poll();
  await watcher.poll();
  await watcher.poll();

  assert.deepEqual(
    changes.map((snapshot) => snapshot.identities[0].value),
    ['obs', 'obs', 'firefox'],
  );
  watcher.stop();
  intervalCallback();
  await flush();
  assert.equal(cleared, true);
  assert.equal(probes, 4);
  assert.equal(watcher.getStatus().running, false);
});

test('focus watcher deduplicates errors and does not emit after stop', async () => {
  const statuses = [];
  const error = Object.assign(new Error('spawn xdotool ENOENT'), {
    code: 'ENOENT',
  });
  const watcher = createFocusWatcher({
    platform: 'linux',
    environment: { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' },
    probe: async () => {
      throw error;
    },
    onStatus: (status) => statuses.push(status),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });

  watcher.start();
  await flush();
  await watcher.poll();

  assert.equal(
    statuses.filter((status) => status.state === 'error').length,
    1,
  );
  assert.match(watcher.getStatus().reason, /xdotool/);

  let resolveProbe;
  const changes = [];
  const inFlight = createFocusWatcher({
    platform: 'linux',
    environment: { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' },
    probe: () => new Promise((resolve) => {
      resolveProbe = resolve;
    }),
    isOwnSnapshot: () => false,
    onChange: (snapshot) => changes.push(snapshot),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });

  inFlight.start();
  inFlight.stop();
  resolveProbe(linuxSnapshot('late'));
  await flush();
  assert.deepEqual(changes, []);
});

test('Wayland reports unsupported without executing a probe', () => {
  let probes = 0;
  const watcher = createFocusWatcher({
    platform: 'linux',
    environment: {
      DISPLAY: ':1',
      WAYLAND_DISPLAY: 'wayland-0',
      XDG_SESSION_TYPE: 'wayland',
    },
    probe: async () => {
      probes++;
      return linuxSnapshot('never');
    },
  });

  watcher.start();

  assert.equal(probes, 0);
  assert.equal(watcher.getStatus().supported, false);
  assert.equal(watcher.getStatus().state, 'unsupported');
  assert.match(watcher.getStatus().reason, /Wayland/);
  assert.equal(
    platformCapability('linux', { XDG_SESSION_TYPE: 'wayland' }).supported,
    false,
  );
});

test('macOS probe failures surface a permission hint', async () => {
  const watcher = createFocusWatcher({
    platform: 'darwin',
    probe: async () => {
      throw new Error('Not authorized to send Apple events');
    },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });

  watcher.start();
  await flush();

  assert.equal(watcher.getStatus().state, 'error');
  assert.match(watcher.getStatus().reason, /Automation access/);
  watcher.stop();
});
