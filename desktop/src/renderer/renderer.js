const { DeviceController } = require('./device');

const autoStartControl = document.querySelector('#autostart');
const checkUpdatesButton = document.querySelector('#check-updates');
const updateRow = document.querySelector('.update-row');
const updateStatus = document.querySelector('#update-status');

function showUpdateStatus({ message, state }) {
  updateRow.dataset.state = state;
  updateStatus.textContent = message;
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
  checkUpdatesButton.disabled = true;

  try {
    await window.stream32.checkForUpdates();
  } catch (error) {
    showUpdateStatus({
      message: `Update check failed: ${error.message}`,
      state: 'error',
    });
  } finally {
    checkUpdatesButton.disabled = false;
  }
});

window.stream32.onUpdateStatus(showUpdateStatus);
loadAutoStartState();

const deviceController = new DeviceController({
  api: window.stream32,
  document,
  serial: navigator.serial,
});

deviceController.initialize().catch((error) => {
  const deviceStatus = document.querySelector('#device-status');
  deviceStatus.dataset.state = 'error';
  deviceStatus.textContent =
    `Device setup failed: ${error instanceof Error ? error.message : error}`;
});
