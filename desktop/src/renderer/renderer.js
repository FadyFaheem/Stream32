const { DeckController } = require('./deck');
const { DeviceController } = require('./device');

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
const checkUpdatesButton = document.querySelector('#check-updates');
const updateRow = document.querySelector('.update-row');
const updateStatus = document.querySelector('#update-status');

const UPDATE_BUSY_STATES = new Set(['available', 'checking', 'downloading']);
let updateReady = false;

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
  document,
  serial: navigator.serial,
});

deckController.initialize().catch((error) => {
  const syncStatus = document.querySelector('#deck-sync-status');
  syncStatus.dataset.state = 'error';
  syncStatus.textContent =
    `Deck setup failed: ${error instanceof Error ? error.message : error}`;
});
deviceController.initialize().catch((error) => {
  const deviceStatus = document.querySelector('#device-status');
  deviceStatus.dataset.state = 'error';
  deviceStatus.textContent =
    `Device setup failed: ${error instanceof Error ? error.message : error}`;
});
