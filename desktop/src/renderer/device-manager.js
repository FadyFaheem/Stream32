const { MAX_NAME_LENGTH } = require('../deck-model');
const { isVersionNewer } = require('../semver');

// Joins the persisted device registry, the live runtime sessions, and the
// board catalog into one inventory. Pure so the view model is unit-testable
// without a DOM.
function deviceInventory({ devices = {}, sessions, boards } = {}) {
  const sessionFor = (id) => (sessions && sessions.get ? sessions.get(id) : undefined);
  const boardFor = (id) => (boards && boards.get ? boards.get(id) : undefined);

  const rows = Object.entries(devices).map(([deviceId, device]) => {
    const session = sessionFor(deviceId);
    const connected = Boolean(session);
    const board = boardFor(device.boardId);
    const installed = connected
      ? session.hello?.firmwareVersion ?? null
      : null;
    const latestVersion = board?.firmwareVersion ?? null;

    return {
      deviceId,
      name: device.name,
      boardId: device.boardId,
      boardName: board?.name ?? device.boardId,
      hasCatalogBoard: Boolean(board),
      boardCompatible: board ? board.compatible === true : false,
      connected,
      firmwareVersion: installed,
      latestVersion,
      updateAvailable: Boolean(
        connected &&
          installed &&
          latestVersion &&
          isVersionNewer(latestVersion, installed),
      ),
      features: connected ? [...(session.hello?.features ?? [])] : [],
    };
  });

  rows.sort(
    (left, right) =>
      Number(right.connected) - Number(left.connected) ||
      left.name.localeCompare(right.name) ||
      left.deviceId.localeCompare(right.deviceId),
  );

  return rows;
}

// Firmware badge model. States map onto the .device-badge CSS variants.
function firmwareStatus(row) {
  if (!row.connected) {
    return {
      state: 'unknown',
      label: row.latestVersion
        ? `Latest ${row.latestVersion}`
        : 'Firmware unknown',
    };
  }

  if (!row.latestVersion) {
    return {
      state: 'unknown',
      label: `Firmware ${row.firmwareVersion ?? 'unknown'}`,
    };
  }

  if (row.updateAvailable) {
    return {
      state: 'update',
      label: `Update available · ${row.firmwareVersion} → ${row.latestVersion}`,
    };
  }

  return { state: 'current', label: `Up to date · ${row.firmwareVersion}` };
}

function deviceMetaText(row) {
  const parts = [row.boardName, `#${row.deviceId.slice(-4)}`];

  if (row.connected && row.firmwareVersion) {
    parts.push(`firmware ${row.firmwareVersion}`);
  } else if (!row.connected) {
    parts.push('offline');
  }

  return parts.join(' · ');
}

function summarizeInventory(rows) {
  if (rows.length === 0) {
    return { label: '', state: 'idle' };
  }

  const connected = rows.filter((row) => row.connected).length;
  const updates = rows.filter((row) => row.updateAvailable).length;
  const parts = [
    `${rows.length} board${rows.length === 1 ? '' : 's'}`,
    `${connected} connected`,
  ];

  if (updates > 0) {
    parts.push(`${updates} update${updates === 1 ? '' : 's'} available`);
  }

  return {
    label: parts.join(' · '),
    state: updates > 0 ? 'working' : connected > 0 ? 'ready' : 'idle',
  };
}

class DeviceManager {
  constructor({ deck, deviceController, document, showView }) {
    this.deck = deck;
    this.deviceController = deviceController;
    this.document = document;
    this.showView = showView;

    this.list = document.querySelector('#device-manager-list');
    this.empty = document.querySelector('#device-manager-empty');
    this.status = document.querySelector('#device-manager-status');
    this.scanButton = document.querySelector('#device-manager-scan');
  }

  initialize() {
    this.scanButton?.addEventListener('click', () => this.scan());
    this.render();
  }

  setStatus(message, state = 'idle') {
    if (!this.status) {
      return;
    }

    this.status.textContent = message;
    this.status.dataset.state = state;
  }

  render() {
    const rows = deviceInventory({
      devices: this.deck.devices,
      sessions: this.deck.runtime.sessions,
      boards: this.deviceController.boards,
    });

    this.list.replaceChildren();

    for (const row of rows) {
      this.list.append(this.renderCard(row));
    }

    if (this.empty) {
      this.empty.hidden = rows.length > 0;
    }

    const summary = summarizeInventory(rows);
    this.setStatus(summary.label, summary.state);
  }

  createButton(label, className) {
    const button = this.document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    return button;
  }

  renderCard(row) {
    const document = this.document;
    const card = document.createElement('article');
    card.className = 'device-card';

    const head = document.createElement('div');
    head.className = 'device-card-head';

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'device-name';
    name.value = row.name;
    name.maxLength = MAX_NAME_LENGTH;
    name.setAttribute('aria-label', `Name for ${row.boardName}`);
    name.addEventListener('change', () => this.renameDevice(row.deviceId, name));

    const connection = document.createElement('span');
    connection.className = 'deck-badge';
    connection.dataset.state = row.connected ? 'ready' : 'idle';
    connection.textContent = row.connected ? 'Connected' : 'Offline';

    head.append(name, connection);

    const meta = document.createElement('p');
    meta.className = 'device-card-meta';
    meta.textContent = deviceMetaText(row);

    const firmware = document.createElement('span');
    const status = firmwareStatus(row);
    firmware.className = 'device-badge';
    firmware.dataset.state = status.state;
    firmware.textContent = status.label;

    const actions = document.createElement('div');
    actions.className = 'device-card-actions';

    const open = this.createButton('Open in Deck', 'button button-secondary');
    open.addEventListener('click', () => {
      if (this.deck.selectDevice(row.deviceId)) {
        this.showView('deck');
      }
    });
    actions.append(open);

    if (row.hasCatalogBoard && row.boardCompatible) {
      const update = this.createButton(
        row.updateAvailable
          ? `Update to ${row.latestVersion}`
          : 'Reflash firmware',
        row.updateAvailable ? 'button button-primary' : 'button button-quiet',
      );
      update.addEventListener('click', () => this.startUpdate(row));
      actions.append(update);
    }

    const toggle = this.createButton(
      row.connected ? 'Disconnect' : 'Reconnect',
      'button button-quiet',
    );
    toggle.addEventListener('click', () => this.toggleConnection(row, toggle));
    actions.append(toggle);

    card.append(head, meta, firmware, actions);
    return card;
  }

  startUpdate(row) {
    if (this.deviceController.prepareFirmwareUpdate(row.boardId)) {
      this.showView('flash');
      return;
    }

    this.setStatus(
      'Board support is still loading, or a flash is already running.',
      'error',
    );
  }

  async renameDevice(deviceId, input) {
    const name = (input.value || '').trim() || 'Stream32 deck';

    try {
      const device = await this.deck.api.renameDeck(deviceId, name);
      this.deck.devices[deviceId] = device;
      this.deck.renderDevicePicker();
      this.render();
    } catch (error) {
      this.setStatus(`Could not rename the device: ${error.message}`, 'error');
    }
  }

  async toggleConnection(row, control) {
    control.disabled = true;

    try {
      if (row.connected) {
        await this.deviceController.disconnectDevice(row.deviceId);
      } else {
        this.setStatus('Looking for plugged-in Stream32 boards…', 'working');
        await this.deviceController.reconnectAuthorizedDevice(false);
      }
    } catch (error) {
      this.setStatus(
        `Could not update the connection: ${error.message}`,
        'error',
      );
    } finally {
      this.render();
    }
  }

  async scan() {
    if (!this.scanButton) {
      return;
    }

    this.scanButton.disabled = true;
    this.setStatus('Scanning for Stream32 boards…', 'working');

    try {
      await this.deviceController.reconnectAuthorizedDevice(false);
    } catch (error) {
      this.setStatus(`Scan failed: ${error.message}`, 'error');
    } finally {
      this.scanButton.disabled = false;
      this.render();
    }
  }
}

module.exports = {
  DeviceManager,
  deviceInventory,
  deviceMetaText,
  firmwareStatus,
  summarizeInventory,
};
