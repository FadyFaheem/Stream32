const { DeckController } = require('./deck');
const { DeviceController } = require('./device');
const { catalogViewModel } = require('./plugin-catalog');

const navItems = document.querySelectorAll('.nav-item');
const views = new Map(
  ['deck', 'flash', 'settings'].map((name) => [
    name,
    document.querySelector(`#view-${name}`),
  ]),
);

function showView(name) {
  for (const [viewName, view] of views) {
    view.hidden = viewName !== name;
  }

  for (const item of navItems) {
    item.dataset.active = String(item.dataset.view === name);
  }
}

for (const item of navItems) {
  item.addEventListener('click', () => showView(item.dataset.view));
}

document
  .querySelector('#deck-goto-flash')
  .addEventListener('click', () => showView('flash'));

const autoStartControl = document.querySelector('#autostart');
const backupExportButton = document.querySelector('#backup-export');
const backupRestoreButton = document.querySelector('#backup-restore');
const checkUpdatesButton = document.querySelector('#check-updates');
const dataToolsStatus = document.querySelector('#data-tools-status');
const diagnosticsExportButton = document.querySelector('#diagnostics-export');
const displayBrightnessControl = document.querySelector('#display-brightness');
const displayIdleControl = document.querySelector('#display-idle-timeout');
const logsOpenButton = document.querySelector('#logs-open');
const pluginBuiltInList = document.querySelector('#plugin-built-in-list');
const pluginCatalogList = document.querySelector('#plugin-catalog-list');
const pluginCatalogRefresh = document.querySelector('#plugin-catalog-refresh');
const pluginCatalogStatus = document.querySelector('#plugin-catalog-status');
const pluginManualInstructions =
  document.querySelector('#plugin-manual-instructions');
const pluginManualReload = document.querySelector('#plugin-manual-reload');
const sleepWhenLockedControl = document.querySelector('#sleep-when-locked');
const updateRow = document.querySelector('.update-row');
const updateStatus = document.querySelector('#update-status');

const UPDATE_BUSY_STATES = new Set(['available', 'checking', 'downloading']);
let updateReady = false;

function pluginSummary(plugin, source) {
  const summary = document.createElement('div');
  const title = document.createElement('strong');
  const details = document.createElement('span');
  summary.className = 'plugin-summary';
  title.textContent = plugin.name;
  details.textContent = `${source} · v${plugin.version}`;
  summary.append(title, details);
  return summary;
}

function renderBuiltInPlugins(plugins) {
  pluginBuiltInList.replaceChildren();

  for (const plugin of plugins) {
    const row = document.createElement('div');
    const badge = document.createElement('span');
    row.className = 'plugin-built-in-row';
    badge.className = 'plugin-state';
    badge.dataset.state = 'built-in';
    badge.textContent = 'Built in';
    row.append(pluginSummary(plugin, 'Stream32'), badge);
    pluginBuiltInList.append(row);
  }
}

async function runPluginOperation(plugin, operation) {
  const verb = operation === 'remove'
    ? 'Removing'
    : operation === 'update'
      ? 'Updating'
      : 'Installing';
  pluginCatalogList.setAttribute('aria-busy', 'true');
  pluginCatalogStatus.dataset.state = 'working';
  pluginCatalogStatus.textContent = `${verb} ${plugin.name}…`;

  try {
    const listing = await window.stream32[
      operation === 'remove'
        ? 'removePlugin'
        : operation === 'update'
          ? 'updatePlugin'
          : 'installPlugin'
    ](plugin.id);
    renderPluginCatalog(listing);
    await deckController.reloadPlugins(false);
  } catch (error) {
    pluginCatalogStatus.dataset.state = 'error';
    pluginCatalogStatus.textContent = error.message;
  } finally {
    pluginCatalogList.removeAttribute('aria-busy');
  }
}

function renderPluginCatalog(listing) {
  const view = catalogViewModel(listing);
  pluginCatalogList.replaceChildren();
  renderBuiltInPlugins(view.builtIn);
  pluginManualInstructions.textContent =
    `You can also copy a trusted JSON manifest into ${view.userDirectory}, ` +
    'then reload manual plugins.';

  for (const plugin of view.plugins) {
    const card = document.createElement('article');
    const header = document.createElement('div');
    const description = document.createElement('p');
    const badge = document.createElement('span');
    const actions = document.createElement('div');
    const install = document.createElement('button');
    card.className = 'plugin-catalog-item';
    header.className = 'plugin-catalog-item-head';
    description.textContent = plugin.description;
    badge.className = 'plugin-state';
    badge.dataset.state = plugin.ui.state;
    badge.textContent = plugin.ui.label;
    actions.className = 'plugin-catalog-actions';
    install.className = 'button button-secondary';
    install.type = 'button';
    install.textContent = plugin.ui.installLabel;
    install.disabled = plugin.ui.installDisabled;
    install.addEventListener('click', () =>
      runPluginOperation(plugin, plugin.ui.installAction));
    header.append(pluginSummary(plugin, 'Curated catalog'), badge);
    actions.append(install);

    if (plugin.ui.removable) {
      const remove = document.createElement('button');
      remove.className = 'button button-quiet';
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        if (
          window.confirm(
            `Remove ${plugin.name}? Saved deck references will be preserved.`,
          )
        ) {
          runPluginOperation(plugin, 'remove');
        }
      });
      actions.append(remove);
    }

    card.append(header, description, actions);
    pluginCatalogList.append(card);
  }

  pluginCatalogStatus.dataset.state = view.warning ? 'warning' : 'ready';
  pluginCatalogStatus.textContent = view.warning ||
    `${view.plugins.length} curated plugin${view.plugins.length === 1 ? '' : 's'} ` +
      `loaded from ${view.source === 'network' ? 'GitHub' : 'the local cache'}.`;

  if (view.errors.length) {
    pluginCatalogStatus.dataset.state = 'warning';
    pluginCatalogStatus.textContent +=
      ` ${view.errors.length} user manifest${view.errors.length === 1 ? '' : 's'} ` +
      'could not be loaded.';
  }
}

async function loadPluginCatalog(force = false) {
  pluginCatalogRefresh.disabled = true;
  pluginCatalogStatus.dataset.state = 'working';
  pluginCatalogStatus.textContent = force
    ? 'Refreshing curated plugins…'
    : 'Loading curated plugins…';

  try {
    renderPluginCatalog(await window.stream32.listPluginCatalog(force));
  } catch (error) {
    pluginCatalogStatus.dataset.state = 'error';
    pluginCatalogStatus.textContent = error.message;
  } finally {
    pluginCatalogRefresh.disabled = false;
  }
}

pluginCatalogRefresh.addEventListener('click', () => loadPluginCatalog(true));
pluginManualReload.addEventListener('click', async () => {
  pluginManualReload.disabled = true;

  try {
    await deckController.reloadPlugins(true);
    await loadPluginCatalog(false);
  } catch (error) {
    pluginCatalogStatus.dataset.state = 'error';
    pluginCatalogStatus.textContent = error.message;
  } finally {
    pluginManualReload.disabled = false;
  }
});

function showUpdateStatus({ message, state }) {
  updateRow.dataset.state = state;
  updateStatus.textContent = message;
  updateReady ||= state === 'downloaded';
  checkUpdatesButton.textContent = updateReady
    ? 'Restart to update'
    : 'Check now';
  checkUpdatesButton.disabled = UPDATE_BUSY_STATES.has(state);
}

async function loadAutoStartState() {
  try {
    autoStartControl.checked = await window.stream32.getAutoStart();
  } catch (error) {
    showUpdateStatus({
      message: `Could not read start-on-login setting: ${error.message}`,
      state: 'error',
    });
  } finally {
    autoStartControl.disabled = false;
  }
}

autoStartControl.addEventListener('change', async () => {
  autoStartControl.disabled = true;

  try {
    autoStartControl.checked = await window.stream32.setAutoStart(
      autoStartControl.checked,
    );
  } catch (error) {
    autoStartControl.checked = !autoStartControl.checked;
    showUpdateStatus({
      message: `Could not change start-on-login setting: ${error.message}`,
      state: 'error',
    });
  } finally {
    autoStartControl.disabled = false;
  }
});

async function loadDisplaySettings() {
  try {
    const settings = await window.stream32.getDisplaySettings();
    displayBrightnessControl.value = String(settings.brightnessPercent);
    displayIdleControl.value = String(settings.idleTimeoutMinutes);
    sleepWhenLockedControl.checked = settings.sleepWhenLocked;
    await deviceController.setMachineLocked(settings.machineLocked);
    await deviceController.setDisplayPolicy(settings);
  } catch (error) {
    showUpdateStatus({
      message: `Could not read display settings: ${error.message}`,
      state: 'error',
    });
  } finally {
    displayBrightnessControl.disabled = false;
    displayIdleControl.disabled = false;
    sleepWhenLockedControl.disabled = false;
  }
}

async function saveDisplaySettings() {
  displayBrightnessControl.disabled = true;
  displayIdleControl.disabled = true;
  sleepWhenLockedControl.disabled = true;

  try {
    const settings = await window.stream32.setDisplaySettings({
      brightnessPercent: displayBrightnessControl.valueAsNumber,
      idleTimeoutMinutes: Number(displayIdleControl.value),
      sleepWhenLocked: sleepWhenLockedControl.checked,
    });
    await deviceController.setDisplayPolicy(settings);
  } catch (error) {
    showUpdateStatus({
      message: `Could not save display settings: ${error.message}`,
      state: 'error',
    });
  } finally {
    displayBrightnessControl.disabled = false;
    displayIdleControl.disabled = false;
    sleepWhenLockedControl.disabled = false;
  }
}

displayBrightnessControl.addEventListener('change', saveDisplaySettings);
displayIdleControl.addEventListener('change', saveDisplaySettings);
sleepWhenLockedControl.addEventListener('change', saveDisplaySettings);

async function runSettingsTool(button, pendingText, operation, successText) {
  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = pendingText;
  dataToolsStatus.dataset.state = 'idle';
  dataToolsStatus.textContent = '';

  try {
    const result = await operation();

    if (result === false || result?.saved === false || result?.restored === false) {
      dataToolsStatus.textContent = 'No changes were made.';
      return;
    }

    dataToolsStatus.dataset.state = 'ready';
    dataToolsStatus.textContent = successText;
  } catch (error) {
    dataToolsStatus.dataset.state = 'error';
    dataToolsStatus.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = previousText;
  }
}

backupExportButton.addEventListener('click', () =>
  runSettingsTool(
    backupExportButton,
    'Exporting…',
    () => window.stream32.exportBackup(),
    'Backup exported.',
  ),
);

backupRestoreButton.addEventListener('click', () => {
  if (
    !window.confirm(
      'Restore will replace all settings, decks, artwork, and user plugins. Continue?',
    )
  ) {
    return;
  }

  runSettingsTool(
    backupRestoreButton,
    'Restoring…',
    () => window.stream32.restoreBackup(),
    'Backup restored. Restarting Stream32…',
  );
});

logsOpenButton.addEventListener('click', () =>
  runSettingsTool(
    logsOpenButton,
    'Opening…',
    () => window.stream32.openLogs(),
    'Logs folder opened.',
  ),
);

diagnosticsExportButton.addEventListener('click', () =>
  runSettingsTool(
    diagnosticsExportButton,
    'Exporting…',
    () => window.stream32.exportDiagnostics(),
    'Redacted diagnostics exported.',
  ),
);

checkUpdatesButton.addEventListener('click', async () => {
  const installing = updateReady;
  let installStarted = false;
  checkUpdatesButton.disabled = true;

  try {
    if (installing) {
      checkUpdatesButton.textContent = 'Restarting…';
      await window.stream32.installUpdate();
      installStarted = true;
    } else {
      await window.stream32.checkForUpdates();
    }
  } catch (error) {
    showUpdateStatus({
      message: `Update ${installing ? 'install' : 'check'} failed: ${error.message}`,
      state: 'error',
    });
  } finally {
    checkUpdatesButton.disabled =
      UPDATE_BUSY_STATES.has(updateRow.dataset.state) || installStarted;
  }
});

window.stream32.onUpdateStatus(showUpdateStatus);
loadAutoStartState();

const deckController = new DeckController({
  api: window.stream32,
  document,
});
const deviceController = new DeviceController({
  api: window.stream32,
  deck: deckController,
  deckRuntime: deckController.runtime,
  document,
  serial: navigator.serial,
});

window.stream32.onMachineLockState((locked) => {
  deviceController.setMachineLocked(locked).catch((error) => {
    showUpdateStatus({
      message: `Could not update display lock state: ${error.message}`,
      state: 'error',
    });
  });
});

deckController.initialize().catch((error) => {
  const syncStatus = document.querySelector('#deck-sync-status');
  syncStatus.dataset.state = 'error';
  syncStatus.textContent =
    `Deck setup failed: ${error instanceof Error ? error.message : error}`;
});
loadDisplaySettings().finally(() => {
  deviceController.initialize().catch((error) => {
    const deviceStatus = document.querySelector('#device-status');
    deviceStatus.dataset.state = 'error';
    deviceStatus.textContent =
      `Device setup failed: ${error instanceof Error ? error.message : error}`;
  });
});
loadPluginCatalog();
