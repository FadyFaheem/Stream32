const { MAX_COLS, MAX_NAME_LENGTH, MAX_ROWS } = require('../deck-model');
const { isVersionNewer } = require('../semver');

// Companion surface state is per device; the address it dials is per app.
function companionStatusText(row, link) {
  if (!row.companion.enabled) {
    return { text: 'Off. This deck runs from its own profiles.', state: 'idle' };
  }

  if (!row.connected) {
    return {
      text: 'On. Registers with Companion once this deck connects.',
      state: 'idle',
    };
  }

  return {
    text: `${link?.message || 'Connecting to Companion…'} ` +
      'Local profiles and actions are paused.',
    state: link?.state === 'connected'
      ? 'ready'
      : link?.state === 'error'
        ? 'error'
        : 'working',
  };
}

// Joins the persisted device registry, the live runtime sessions, and the
// board catalog into one inventory. Pure so the view model is unit-testable
// without a DOM.
function deviceInventory({
  devices = {},
  sessions,
  boards,
  cleaning,
  calibrating,
  inverted,
  rotation,
  flipX,
  flipY,
  iconSize,
  labelLines,
} = {}) {
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
      companion: device.companion ?? { enabled: false, rows: 3, cols: 3 },
      brightness: device.brightness ?? null,
      supportsBrightness: connected
        ? (session.hello?.features ?? []).includes('display-brightness')
        : false,
      supportsClean: connected
        ? (session.hello?.features ?? []).includes('clean-mode')
        : false,
      cleaning: connected && cleaning ? cleaning.has(deviceId) : false,
      supportsCalibration: connected
        ? (session.hello?.features ?? []).includes('touch-calibration')
        : false,
      calibrating:
        connected && calibrating ? calibrating.has(deviceId) : false,
      supportsInvert: connected
        ? (session.hello?.features ?? []).includes('display-invert')
        : false,
      // The board announces these after every hello, so an unknown value
      // only means the announcement has not landed yet.
      inverted: connected && inverted ? inverted.get(deviceId) === true : false,
      supportsRotation: connected
        ? (session.hello?.features ?? []).includes('display-rotation')
        : false,
      rotation: connected && rotation ? rotation.get(deviceId) ?? 0 : 0,
      supportsFlip: connected
        ? (session.hello?.features ?? []).includes('display-flip')
        : false,
      flipX: connected && flipX ? flipX.get(deviceId) === true : false,
      flipY: connected && flipY ? flipY.get(deviceId) === true : false,
      supportsIconSize: connected
        ? (session.hello?.features ?? []).includes('display-icon-size')
        : false,
      iconSize: connected && iconSize ? iconSize.get(deviceId) ?? 100 : 100,
      supportsLabelLines: connected
        ? (session.hello?.features ?? []).includes('display-label-lines')
        : false,
      labelLines:
        connected && labelLines ? labelLines.get(deviceId) ?? 1 : 1,
      deckLimits: board?.deck ?? {
        maxRows: MAX_ROWS,
        maxCols: MAX_COLS,
        maxKeys: 30,
      },
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

// A settling count rather than a spinner, so a long re-flow visibly gets
// somewhere. Artwork is the slow part, which is why icons are what it counts.
function syncProgressText({ page, pages, sent, images }) {
  const parts = [];

  if (pages > 1) {
    parts.push(`page ${page} of ${pages}`);
  }

  // sent is what has landed, so the count names the one in flight and stops
  // at the total rather than reading "icon 7 of 6" as the last one lands.
  if (images > 0) {
    parts.push(`icon ${Math.min(sent + 1, images)} of ${images}`);
  }

  return `Resyncing${parts.length > 0 ? ` ${parts.join(' \u00b7 ')}` : ''}\u2026`;
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
    // The wizard runs on the board, so its result arrives unsolicited.
    this.deck.runtime.onCalibrateOutcome = (deviceId, outcome) =>
      this.showCalibrateOutcome(deviceId, outcome);
    this.scanButton = document.querySelector('#device-manager-scan');
    this.cleanAllButton = document.querySelector('#device-manager-clean-all');
    this.companionEnabledControl = document.querySelector('#companion-enabled');
    this.companionSection = document.querySelector('#companion-link');
    this.companionHost = document.querySelector('#companion-host');
    this.companionPort = document.querySelector('#companion-port');
    this.companionLinkStatus = document.querySelector('#companion-link-status');
    this.companionSettings = { enabled: false, host: '127.0.0.1', port: 16622 };
    this.companionLink = null;
    this.defaultBrightness = 100;
    // Device ids whose settings panel the person left open.
    this.expanded = new Set();
    // Each card's progress line, kept by device id so a sync can tick it
    // without rebuilding the list under the person's cursor.
    this.syncNodes = new Map();
  }

  async initialize() {
    this.scanButton?.addEventListener('click', () => this.scan());
    this.cleanAllButton?.addEventListener('click', () => this.cleanAll());

    for (const control of [
      this.companionEnabledControl,
      this.companionHost,
      this.companionPort,
    ]) {
      control.addEventListener('change', () => this.saveCompanionSettings());
    }

    this.deck.api.onCompanionStatus((status) => {
      this.companionLink = status;
      this.companionSettings = {
        ...this.companionSettings,
        host: status.host,
        port: status.port,
      };
      this.renderCompanionLink();
      this.render();
    });

    try {
      this.companionSettings = await this.deck.api.getCompanionSettings();
      this.companionLink = this.companionSettings;
      await this.deck.runtime.setCompanionAvailable(
        this.companionSettings.enabled,
      );
    } catch (error) {
      this.setCompanionLinkStatus(
        `Could not read Companion settings: ${error.message}`,
        'error',
      );
    }

    this.renderCompanionLink();
    this.render();
  }

  setCompanionLinkStatus(message, state) {
    this.companionLinkStatus.textContent = message;
    this.companionLinkStatus.dataset.state = state;
  }

  renderCompanionLink() {
    this.companionEnabledControl.checked = this.companionSettings.enabled;
    this.companionEnabledControl.disabled = false;
    this.companionSection.hidden = !this.companionSettings.enabled;

    if (this.document.activeElement !== this.companionHost) {
      this.companionHost.value = this.companionSettings.host;
    }

    if (this.document.activeElement !== this.companionPort) {
      this.companionPort.value = String(this.companionSettings.port);
    }

    const link = this.companionLink;
    this.setCompanionLinkStatus(
      link?.message || 'No deck is handed to Companion yet.',
      link?.state === 'connected'
        ? 'ready'
        : link?.state === 'error'
          ? 'error'
          : 'idle',
    );
  }

  async saveCompanionSettings() {
    try {
      this.companionSettings = await this.deck.api.setCompanionSettings({
        enabled: this.companionEnabledControl.checked,
        host: this.companionHost.value.trim(),
        port: Number(this.companionPort.value),
      });
      this.companionLink = this.companionSettings;
      this.renderCompanionLink();
      await this.deck.runtime.setCompanionAvailable(
        this.companionSettings.enabled,
      );
      this.render();
    } catch (error) {
      this.renderCompanionLink();
      this.setCompanionLinkStatus(
        `Could not save the Companion settings: ${error.message}`,
        'error',
      );
    }
  }

  // The app-wide brightness is the fallback shown as a placeholder on every
  // board that has not been given its own value.
  setDefaultBrightness(brightnessPercent) {
    this.defaultBrightness = brightnessPercent;
    this.render();
  }

  setStatus(message, state = 'idle') {
    if (!this.status) {
      return;
    }

    this.status.textContent = message;
    this.status.dataset.state = state;
  }

  inventory() {
    return deviceInventory({
      devices: this.deck.devices,
      sessions: this.deck.runtime.sessions,
      boards: this.deviceController.boards,
      cleaning: this.deck.runtime.cleaning,
      calibrating: this.deck.runtime.calibrating,
      inverted: this.deck.runtime.inverted,
      rotation: this.deck.runtime.rotation,
      flipX: this.deck.runtime.flipX,
      flipY: this.deck.runtime.flipY,
      iconSize: this.deck.runtime.iconSize,
      labelLines: this.deck.runtime.labelLines,
    });
  }

  render() {
    const rows = this.inventory();

    this.list.replaceChildren();
    this.syncNodes.clear();

    for (const row of rows) {
      this.list.append(this.renderCard(row));
    }

    // A card rebuilt mid-sync has to pick the count back up.
    this.renderSyncProgress();

    if (this.empty) {
      this.empty.hidden = rows.length > 0;
    }

    if (this.cleanAllButton) {
      const capable = rows.filter((row) => row.supportsClean);
      this.cleanAllButton.hidden = capable.length < 2;
      this.cleanAllButton.textContent = capable.every((row) => row.cleaning)
        ? 'Unlock all screens'
        : 'Clean all screens';
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

    if (row.supportsClean) {
      const clean = this.createButton(
        row.cleaning ? 'Stop cleaning' : 'Clean screen',
        row.cleaning ? 'button button-primary' : 'button button-quiet',
      );
      clean.addEventListener('click', () => this.toggleCleaning(row, clean));
      actions.append(clean);
    }

    if (row.supportsCalibration) {
      const calibrate = this.createButton(
        row.calibrating ? 'Cancel calibration' : 'Calibrate touch',
        row.calibrating ? 'button button-primary' : 'button button-quiet',
      );
      calibrate.addEventListener('click', () =>
        this.toggleCalibration(row, calibrate));
      actions.append(calibrate);
    }

    const toggle = this.createButton(
      row.connected ? 'Disconnect' : 'Reconnect',
      'button button-quiet',
    );
    toggle.addEventListener('click', () => this.toggleConnection(row, toggle));
    actions.append(toggle);

    const sync = document.createElement('p');
    sync.className = 'device-sync';
    this.syncNodes.set(row.deviceId, sync);

    card.append(head, meta, firmware, sync);

    const settings = [
      row.supportsBrightness && this.renderBrightness(row),
      row.supportsInvert && this.renderInvert(row),
      row.supportsRotation && this.renderRotation(row),
      row.supportsFlip && this.renderFlip(row),
      row.supportsIconSize && this.renderIconSize(row),
      row.supportsLabelLines && this.renderLabelLines(row),
      this.companionSettings.enabled && this.renderCompanion(row),
    ].filter(Boolean);

    if (settings.length > 0) {
      card.append(this.renderSettings(row, settings));
    }

    card.append(actions);
    return card;
  }

  // Ticks once per streamed icon, so it only touches the text it changes
  // rather than going through render().
  renderSyncProgress() {
    for (const [deviceId, node] of this.syncNodes) {
      const progress = this.deck.runtime.syncProgress.get(deviceId);
      node.hidden = !progress;
      node.textContent = progress ? syncProgressText(progress) : '';
    }
  }

  // Most of a card is settings a board is set up with once, so they stay
  // folded away and the everyday actions stay in reach.
  renderSettings(row, sections) {
    const { document } = this;
    const details = document.createElement('details');
    const summary = document.createElement('summary');

    details.className = 'device-settings';
    summary.textContent = `Settings (${sections.length})`;
    // Every card has one, so the board's name is what tells them apart.
    summary.setAttribute('aria-label', `Settings for ${row.name}`);
    // Every change re-renders the whole list, so the panel has to be told
    // again that it was open.
    details.open = this.expanded.has(row.deviceId);
    details.addEventListener('toggle', () => {
      this.expanded[details.open ? 'add' : 'delete'](row.deviceId);
    });

    details.append(summary, ...sections);
    return details;
  }

  renderBrightness(row) {
    const document = this.document;
    const section = document.createElement('div');
    section.className = 'device-brightness';

    const label = document.createElement('label');
    label.className = 'field-label';
    label.htmlFor = `device-brightness-${row.deviceId}`;
    label.textContent = 'Display brightness';

    const input = document.createElement('input');
    input.id = label.htmlFor;
    input.type = 'number';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.placeholder = String(this.defaultBrightness);
    input.value = row.brightness === null ? '' : String(row.brightness);
    input.addEventListener('change', () => this.saveBrightness(row, input));

    const unit = document.createElement('span');
    unit.textContent = '%';

    const helper = document.createElement('p');
    helper.className = 'helper';
    helper.textContent = row.brightness === null
      ? `Using the app default of ${this.defaultBrightness}%.`
      : 'Clear the box to follow the app default again.';

    section.append(label, input, unit, helper);
    return section;
  }

  renderCompanion(row) {
    const document = this.document;
    const section = document.createElement('div');
    section.className = 'device-companion';

    const toggleLabel = document.createElement('label');
    const toggleText = document.createElement('span');
    toggleLabel.className = 'device-companion-toggle';
    toggleText.textContent = 'Companion surface';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = row.companion.enabled;
    toggleLabel.append(toggle, toggleText);

    const grid = document.createElement('div');
    grid.className = 'device-companion-grid';
    const selects = {};

    for (const [axis, caption, limit, maximum] of [
      ['rows', 'Rows', 'maxRows', MAX_ROWS],
      ['cols', 'Columns', 'maxCols', MAX_COLS],
    ]) {
      const captionLabel = document.createElement('label');
      captionLabel.textContent = caption;
      captionLabel.htmlFor = `device-companion-${axis}-${row.deviceId}`;

      const select = document.createElement('select');
      const options = [];
      select.id = captionLabel.htmlFor;

      for (let size = 1; size <= maximum; size++) {
        const option = document.createElement('option');
        option.value = String(size);
        option.textContent = String(size);
        options.push(option);
        select.append(option);
      }

      select.value = String(row.companion[axis]);
      select.addEventListener('change', () =>
        this.saveCompanionSurface(row, toggle, selects));
      selects[axis] = { select, options, limit };
      grid.append(captionLabel, select);
    }

    // Each axis is bounded by the board's per-page key budget given the other.
    for (const [axis, { options, limit }] of Object.entries(selects)) {
      const other = Number(
        selects[axis === 'rows' ? 'cols' : 'rows'].select.value,
      );

      for (const option of options) {
        const size = Number(option.value);
        option.disabled =
          size > row.deckLimits[limit] ||
          size * other > row.deckLimits.maxKeys;
      }
    }

    toggle.addEventListener('change', () =>
      this.saveCompanionSurface(row, toggle, selects));

    const status = document.createElement('p');
    const summary = companionStatusText(row, this.companionLink);
    status.className = 'helper device-companion-status';
    status.dataset.state = summary.state;
    status.textContent = summary.text;

    section.append(toggleLabel, grid, status);
    return section;
  }

  // Same board model can ship panels that disagree about inversion, so this
  // is the fix for a screen that looks like a photographic negative.
  renderInvert(row) {
    const { document } = this;
    const section = document.createElement('div');
    const label = document.createElement('label');
    const toggle = document.createElement('input');
    const caption = document.createElement('span');

    section.className = 'device-invert';
    label.className = 'device-companion-toggle';
    toggle.type = 'checkbox';
    toggle.checked = row.inverted;
    caption.textContent = 'Invert display colours';
    toggle.addEventListener('change', () => this.saveInvert(row, toggle));
    label.append(toggle, caption);

    const helper = document.createElement('p');
    helper.className = 'helper';
    helper.textContent =
      'Turn this on if the screen looks like a photographic negative. ' +
      'The board remembers it.';

    section.append(label, helper);
    return section;
  }

  // A panel mounted sideways or upside down still reads correctly, and the
  // board keeps the choice so it survives being unplugged.
  renderRotation(row) {
    const { document } = this;
    const section = document.createElement('div');
    const label = document.createElement('label');
    const select = document.createElement('select');

    section.className = 'device-rotation';
    label.className = 'field-label';
    label.textContent = 'Screen rotation';
    label.htmlFor = `rotation-${row.deviceId}`;
    select.id = label.htmlFor;

    for (const degrees of [0, 90, 180, 270]) {
      const option = document.createElement('option');
      option.value = String(degrees);
      option.textContent = `${degrees}\u00b0`;
      select.append(option);
    }

    select.value = String(row.rotation);
    select.addEventListener('change', () => this.saveRotation(row, select));

    const helper = document.createElement('p');
    helper.className = 'helper';
    helper.textContent =
      'Turning the screen re-sizes the keys, so every icon is sent again.';

    section.append(label, select, helper);
    return section;
  }

  // Rotation reaches four of the eight ways a panel can be wired, and these
  // two reach the other four. Together they cannot fail to get a picture the
  // right way up, which is the point: some boards ship mirrored.
  renderFlip(row) {
    const { document } = this;
    const section = document.createElement('div');
    const toggles = {};

    section.className = 'device-flip';

    for (const axis of ['flipX', 'flipY']) {
      const label = document.createElement('label');
      const toggle = document.createElement('input');
      const caption = document.createElement('span');

      label.className = 'device-companion-toggle';
      toggle.type = 'checkbox';
      toggle.checked = row[axis];
      caption.textContent = `Mirror the ${axis === 'flipX' ? 'X' : 'Y'} axis`;
      toggle.addEventListener('change', () => this.saveFlip(row, toggles));
      label.append(toggle, caption);
      toggles[axis] = toggle;
      section.append(label);
    }

    const helper = document.createElement('p');
    helper.className = 'helper';
    helper.textContent =
      'Try these with the rotation above if the screen reads backwards or ' +
      'upside down. Touch follows, and the board remembers the answer.';

    section.append(helper);
    return section;
  }

  async saveFlip(row, toggles) {
    for (const toggle of Object.values(toggles)) {
      toggle.disabled = true;
    }

    try {
      await this.deviceController.setDisplayFlip(
        row.deviceId,
        toggles.flipX.checked,
        toggles.flipY.checked,
      );
    } catch (error) {
      this.setStatus(`Could not mirror the screen: ${error.message}`, 'error');
    }

    this.render();
  }

  // Small panels give every key a large tile, and artwork drawn to fill it
  // looks oversized. Only the picture shrinks; the tile and label stay put.
  renderIconSize(row) {
    const { document } = this;
    const section = document.createElement('div');
    const label = document.createElement('label');
    const select = document.createElement('select');

    section.className = 'device-icon-size';
    label.className = 'field-label';
    label.textContent = 'Icon size';
    label.htmlFor = `icon-size-${row.deviceId}`;
    select.id = label.htmlFor;

    for (const percent of [100, 85, 70, 55, 40]) {
      const option = document.createElement('option');
      option.value = String(percent);
      option.textContent = percent === 100 ? 'Fill the key' : `${percent}%`;
      select.append(option);
    }

    select.value = String(row.iconSize);
    select.addEventListener('change', () => this.saveIconSize(row, select));

    const helper = document.createElement('p');
    helper.className = 'helper';
    helper.textContent =
      'Artwork is re-sent at the new size. Keys and labels do not move.';

    section.append(label, select, helper);
    return section;
  }

  // A one-line label ellipsizes anything longer than the key. Allowing it to
  // wrap costs tile height, which the artwork gives up.
  renderLabelLines(row) {
    const { document } = this;
    const section = document.createElement('div');
    const label = document.createElement('label');
    const select = document.createElement('select');

    section.className = 'device-label-lines';
    label.className = 'field-label';
    label.textContent = 'Label lines';
    label.htmlFor = `label-lines-${row.deviceId}`;
    select.id = label.htmlFor;

    for (const lines of [1, 2, 3]) {
      const option = document.createElement('option');
      option.value = String(lines);
      option.textContent = lines === 1 ? 'One line' : `${lines} lines`;
      select.append(option);
    }

    select.value = String(row.labelLines);
    select.addEventListener('change', () => this.saveLabelLines(row, select));

    const helper = document.createElement('p');
    helper.className = 'helper';
    helper.textContent =
      'Longer labels wrap instead of being cut short. Icons shrink to fit.';

    section.append(label, select, helper);
    return section;
  }

  async saveLabelLines(row, select) {
    const lines = Number(select.value);
    let status;

    select.disabled = true;

    try {
      await this.deviceController.setDisplayLabelLines(row.deviceId, lines);
      status = [
        `${row.name} labels set to ${lines} line${lines === 1 ? '' : 's'}. ` +
          'The artwork is on its way again at the new size.',
        'working',
      ];
    } catch (error) {
      status = [`Could not change the label lines: ${error.message}`, 'error'];
    }

    // render() rewrites the status line, so the outcome has to follow it.
    this.render();
    this.setStatus(...status);
  }

  async saveIconSize(row, select) {
    const percent = Number(select.value);
    let status;

    select.disabled = true;

    try {
      await this.deviceController.setDisplayIconSize(row.deviceId, percent);
      status = [
        `${row.name} icons set to ${percent}%. The artwork is on its way ` +
          'again at the new size.',
        'working',
      ];
    } catch (error) {
      status = [`Could not change the icon size: ${error.message}`, 'error'];
    }

    // render() rewrites the status line, so the outcome has to follow it.
    this.render();
    this.setStatus(...status);
  }

  async saveRotation(row, select) {
    const degrees = Number(select.value);
    let status;

    select.disabled = true;

    try {
      await this.deviceController.setDisplayRotation(row.deviceId, degrees);
      status = [
        `${row.name} rotated to ${degrees}\u00b0. The keys change size, so ` +
          'the artwork is on its way again.',
        'working',
      ];
    } catch (error) {
      status = [`Could not rotate the screen: ${error.message}`, 'error'];
    }

    // render() rewrites the status line, so the outcome has to follow it.
    this.render();
    this.setStatus(...status);
  }

  async saveInvert(row, toggle) {
    toggle.disabled = true;

    try {
      await this.deviceController.setDisplayInvert(row.deviceId, toggle.checked);
    } catch (error) {
      this.setStatus(`Could not change colours: ${error.message}`, 'error');
    }

    this.render();
  }

  showCalibrateOutcome(deviceId, outcome) {
    if (!outcome) {
      return;
    }

    const name = this.deck.devices[deviceId]?.name ?? 'The deck';
    const messages = {
      done: [`${name} touch calibration saved.`, 'ready'],
      failed: [
        `${name} calibration did not check out. The taps were too close ` +
          'together or one missed its marker. The previous calibration is ' +
          'still in use.',
        'error',
      ],
      cancelled: [`${name} calibration timed out.`, 'idle'],
    };

    this.setStatus(...(messages[outcome] ?? messages.cancelled));
  }

  async toggleCalibration(row, control) {
    control.disabled = true;
    let status;

    try {
      await this.deck.runtime.setCalibrating(row.deviceId, !row.calibrating);
      status = row.calibrating
        ? [`${row.name} calibration cancelled.`, 'idle']
        : [
          `Follow the markers on ${row.name}. Tap the centre of each one; ` +
            'the board saves the result itself.',
          'working',
        ];
    } catch (error) {
      status = [`Could not start calibration: ${error.message}`, 'error'];
    }

    // render() rewrites the status line, so the outcome has to follow it.
    this.render();
    this.setStatus(...status);
  }

  async saveBrightness(row, input) {
    const raw = input.value.trim();

    try {
      const device = await this.deck.api.setDeckBrightness(
        row.deviceId,
        raw === '' ? null : Number(raw),
      );
      this.deck.devices[row.deviceId] = device;
      await this.deviceController.applyDisplayPolicyToDevice(row.deviceId);
    } catch (error) {
      this.setStatus(`Could not set brightness: ${error.message}`, 'error');
    }

    this.render();
  }

  async saveCompanionSurface(row, toggle, selects) {
    try {
      await this.deck.runtime.setCompanionSurface(row.deviceId, {
        enabled: toggle.checked,
        rows: Number(selects.rows.select.value),
        cols: Number(selects.cols.select.value),
      });
    } catch (error) {
      this.setStatus(`Could not change Companion mode: ${error.message}`, 'error');
      this.render();
    }
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

  async toggleCleaning(row, control) {
    control.disabled = true;
    let status;

    try {
      await this.deck.runtime.setCleanMode(row.deviceId, !row.cleaning);
      status = row.cleaning
        ? [`${row.name} is unlocked.`, 'idle']
        : [
          `${row.name} is locked for cleaning. Hold the circle on the deck ` +
            'for five seconds, or switch it off here.',
          'ready',
        ];
    } catch (error) {
      status = [`Could not change cleaning mode: ${error.message}`, 'error'];
    }

    // render() rewrites the status line, so the outcome has to follow it.
    this.render();
    this.setStatus(...status);
  }

  // Each board acknowledges on its own link, so a board that refuses must not
  // leave the rest of them unlocked.
  async cleanAll() {
    const rows = this.inventory().filter((row) => row.supportsClean);
    const active = !rows.every((row) => row.cleaning);

    this.cleanAllButton.disabled = true;

    const results = await Promise.allSettled(
      rows.map((row) => this.deck.runtime.setCleanMode(row.deviceId, active)),
    );
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [`${rows[index].name}: ${result.reason.message}`]
        : []);

    this.cleanAllButton.disabled = false;
    this.render();
    this.setStatus(
      failures.length > 0
        ? `Could not change cleaning mode — ${failures.join('; ')}`
        : active
          ? `${rows.length} screens locked for cleaning. Hold the circle on ` +
            'a deck for five seconds to unlock it.'
          : `${rows.length} screens unlocked.`,
      failures.length > 0 ? 'error' : active ? 'ready' : 'idle',
    );
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
  syncProgressText,
};
