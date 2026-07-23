const assert = require('node:assert/strict');
const test = require('node:test');

const {
  catalogViewModel,
  pluginUiState,
} = require('../src/renderer/plugin-catalog');

function plugin(overrides = {}) {
  return {
    id: 'search',
    version: '2.0.0',
    minimumDesktopVersion: '0.8.0',
    compatible: true,
    installedVersion: null,
    updateAvailable: false,
    ...overrides,
  };
}

test('derives install, update, remove, incompatible, and offline UI states', () => {
  assert.deepEqual(pluginUiState(plugin()), {
    state: 'available',
    label: 'Available · 2.0.0',
    installAction: 'install',
    installLabel: 'Install',
    installDisabled: false,
    removable: false,
  });

  const update = pluginUiState(
    plugin({ installedVersion: '1.0.0', updateAvailable: true }),
  );
  assert.equal(update.state, 'update-available');
  assert.equal(update.installAction, 'update');
  assert.equal(update.removable, true);

  const installed = pluginUiState(plugin({ installedVersion: '2.0.0' }));
  assert.equal(installed.state, 'installed');
  assert.equal(installed.installDisabled, true);
  assert.equal(installed.removable, true);

  const incompatible = pluginUiState(plugin({ compatible: false }));
  assert.equal(incompatible.state, 'incompatible');
  assert.equal(incompatible.installDisabled, true);

  const offline = pluginUiState(plugin(), true);
  assert.equal(offline.state, 'offline');
  assert.equal(offline.installDisabled, true);
});

test('marks cached warning listings offline without IPC or DOM dependencies', () => {
  const view = catalogViewModel({
    plugins: [plugin({ installedVersion: '2.0.0' })],
    builtIn: [],
    errors: [],
    source: 'cache',
    warning: 'Offline',
  });

  assert.equal(view.offline, true);
  assert.equal(view.plugins[0].ui.state, 'installed');
  assert.match(view.plugins[0].ui.label, /Offline/);
});
