const ICON_NAMES = require('./icon-names.json');
const { ActionEditor } = require('./action-editor');
const {
  MAX_DECK_COLS,
  MAX_DECK_KEYS,
  MAX_DECK_PAGES,
  MAX_DECK_ROWS,
  MAX_KEY_LABEL_LENGTH,
  crc32,
  encodeImageChunks,
  encodeLayoutMessage,
  encodePageMessage,
  layoutLineLimitFor,
  validateImageAck,
  validateLayoutAck,
  validatePageMessage,
  validatePressMessage,
} = require('./protocol');

const ACK_TIMEOUT_MS = 5000;
const SYNC_DEBOUNCE_MS = 600;
const STORED_IMAGE_PIXELS = 192;
const DEFAULT_KEY_COLOR = '#172630';
const ICON_FONT = 'Material Symbols Rounded';
const MAX_ICON_RESULTS = 96;

function deviceLabel(deviceId, profile) {
  return `${profile.name} · ${deviceId.slice(-4)}`;
}

function gridKey(page) {
  return `${page.rows}x${page.cols}`;
}

async function loadImage(dataUrl) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return image;
}

function toRgb565(imageData) {
  const { data } = imageData;
  const pixels = new Uint8Array((data.length / 4) * 2);

  for (let source = 0, target = 0; source < data.length; source += 4, target += 2) {
    const value =
      ((data[source] >> 3) << 11) |
      ((data[source + 1] >> 2) << 5) |
      (data[source + 2] >> 3);
    pixels[target] = value & 0xff;
    pixels[target + 1] = value >> 8;
  }

  return pixels;
}

class DeckController {
  constructor({ api, document }) {
    this.api = api;
    this.document = document;
    this.devices = {};
    this.boardLimits = new Map();
    this.sessions = new Map();
    this.pending = new Map();
    this.syncTimers = new Map();
    this.syncRunning = new Map();
    this.selectedDeviceId = null;
    this.selectedPage = 0;
    this.selectedKey = null;

    this.deviceSelect = document.querySelector('#deck-device');
    this.deviceStatus = document.querySelector('#deck-device-status');
    this.deviceName = document.querySelector('#deck-device-name');
    this.exportButton = document.querySelector('#deck-export');
    this.importButton = document.querySelector('#deck-import');
    this.syncStatus = document.querySelector('#deck-sync-status');
    this.pageTabs = document.querySelector('#deck-page-tabs');
    this.addPageButton = document.querySelector('#deck-add-page');
    this.removePageButton = document.querySelector('#deck-remove-page');
    this.pageName = document.querySelector('#deck-page-name');
    this.rowsSelect = document.querySelector('#deck-rows');
    this.colsSelect = document.querySelector('#deck-cols');
    this.grid = document.querySelector('#deck-grid');
    this.emptyState = document.querySelector('#deck-empty');
    this.editorPanel = document.querySelector('#deck-editor');
    this.keyEditor = document.querySelector('#deck-key-editor');
    this.keyTitle = document.querySelector('#deck-key-title');
    this.keyLabel = document.querySelector('#deck-key-label');
    this.keyColor = document.querySelector('#deck-key-color');
    this.keyLabelColor = document.querySelector('#deck-key-label-color');
    this.keyImage = document.querySelector('#deck-key-image');
    this.keyImageClear = document.querySelector('#deck-key-image-clear');
    this.iconOpen = document.querySelector('#deck-icon-open');
    this.iconDialog = document.querySelector('#deck-icon-dialog');
    this.iconSearch = document.querySelector('#deck-icon-search');
    this.iconGrid = document.querySelector('#deck-icon-grid');
    this.iconClose = document.querySelector('#deck-icon-close');
    this.keyTest = document.querySelector('#deck-key-test');
    this.keyClear = document.querySelector('#deck-key-clear');
    this.actionEditor = new ActionEditor({
      document,
      onChange: (action, appearance) => {
        this.applyActionSelection(action, appearance);
      },
      onReload: () => this.api.listPlugins(true),
    });
  }

  async initialize() {
    this.populateStaticControls();
    this.bindEvents();

    try {
      this.actionEditor.setCatalog(await this.api.listPlugins());
    } catch (error) {
      this.actionEditor.setCatalogError(error.message);
    }

    try {
      const registry = await this.api.listDecks();
      this.devices = registry.devices;
    } catch (error) {
      this.setSyncStatus(`Could not load deck profiles: ${error.message}`, 'error');
    }

    this.selectedDeviceId = Object.keys(this.devices)[0] || null;
    this.renderAll();
  }

  setBoards(boards) {
    this.boardLimits = new Map(
      boards.map((board) => [board.id, board.deck]),
    );
    this.renderAll();
  }

  populateStaticControls() {
    for (let size = 1; size <= MAX_DECK_ROWS; size++) {
      const option = this.document.createElement('option');
      option.value = String(size);
      option.textContent = String(size);
      this.rowsSelect.append(option);
    }

    for (let size = 1; size <= MAX_DECK_COLS; size++) {
      const option = this.document.createElement('option');
      option.value = String(size);
      option.textContent = String(size);
      this.colsSelect.append(option);
    }
  }

  bindEvents() {
    this.deviceSelect.addEventListener('change', () => {
      this.selectedDeviceId = this.deviceSelect.value || null;
      this.selectedPage = this.selectedProfile()?.activePage ?? 0;
      this.selectedKey = null;
      this.renderAll();
    });
    this.deviceName.addEventListener('change', () => {
      this.updateProfile((profile) => {
        profile.name = this.deviceName.value.trim() || 'Stream32 deck';
      }, false);
      this.renderDevicePicker();
    });
    this.exportButton.addEventListener('click', async () => {
      try {
        const result = await this.api.exportDeck(this.selectedDeviceId);
        this.setSyncStatus(
          result.saved ? 'Deck profile exported.' : 'Export cancelled.',
          'ready',
        );
      } catch (error) {
        this.setSyncStatus(`Export failed: ${error.message}`, 'error');
      }
    });
    this.importButton.addEventListener('click', async () => {
      await this.importProfile();
    });
    this.addPageButton.addEventListener('click', () => {
      this.updateProfile((profile) => {
        profile.pages.push({
          name: `Page ${profile.pages.length + 1}`,
          rows: 3,
          cols: 3,
          keys: [],
        });
        this.selectedPage = profile.pages.length - 1;
        this.selectedKey = null;
      });
    });
    this.removePageButton.addEventListener('click', () => {
      this.updateProfile((profile) => {
        if (profile.pages.length <= 1) {
          return;
        }

        const removed = this.selectedPage;
        profile.pages.splice(removed, 1);
        this.selectedPage = Math.min(
          this.selectedPage,
          profile.pages.length - 1,
        );
        this.selectedKey = null;
        profile.activePage = Math.min(
          profile.activePage,
          profile.pages.length - 1,
        );

        // Page actions and goPage targets pointing at or past the removed
        // page are remapped so the profile stays valid.
        for (const page of profile.pages) {
          for (const key of page.keys) {
            if (key.action?.type !== 'page') {
              continue;
            }

            if (key.action.page === removed) {
              delete key.action;
            } else if (key.action?.page > removed) {
              key.action.page -= 1;
            }
          }
        }
      });
    });
    this.pageName.addEventListener('change', () => {
      this.updateProfile((page) => {
        page.name = this.pageName.value.trim() || 'Page';
      }, true, true);
    });
    this.rowsSelect.addEventListener('change', () => {
      this.resizeSelectedPage();
    });
    this.colsSelect.addEventListener('change', () => {
      this.resizeSelectedPage();
    });
    this.keyLabel.addEventListener('change', () => {
      this.updateSelectedKey((key) => {
        const label = this.keyLabel.value.trim().slice(0, MAX_KEY_LABEL_LENGTH);

        if (label) {
          key.label = label;
        } else {
          delete key.label;
        }
      });
    });
    this.keyColor.addEventListener('change', () => {
      this.updateSelectedKey((key) => {
        key.color = this.keyColor.value;
      });
    });
    this.keyLabelColor.addEventListener('change', () => {
      this.updateSelectedKey((key) => {
        key.labelColor = this.keyLabelColor.value;
      });
    });
    this.keyImage.addEventListener('change', async () => {
      const file = this.keyImage.files?.[0];
      this.keyImage.value = '';

      if (!file) {
        return;
      }

      try {
        const dataUrl = await this.readImageFile(file);
        this.updateSelectedKey((key) => {
          key.image = dataUrl;
        });
      } catch (error) {
        this.setSyncStatus(`Could not read image: ${error.message}`, 'error');
      }
    });
    this.keyImageClear.addEventListener('click', () => {
      this.updateSelectedKey((key) => {
        delete key.image;
      });
    });
    this.iconOpen.addEventListener('click', () => {
      this.iconSearch.value = '';
      this.renderIconGrid('');
      this.iconDialog.showModal();
      this.iconSearch.focus();
    });
    this.iconSearch.addEventListener('input', () => {
      this.renderIconGrid(this.iconSearch.value);
    });
    this.iconClose.addEventListener('click', () => {
      this.iconDialog.close();
    });
    this.iconDialog.addEventListener('click', (event) => {
      // A click on the backdrop targets the dialog element itself.
      if (event.target === this.iconDialog) {
        this.iconDialog.close();
      }
    });
    this.keyTest.addEventListener('click', () => {
      const key = this.selectedKeyData();

      if (key?.action) {
        this.runKeyAction(this.selectedDeviceId, key.action);
      }
    });
    this.keyClear.addEventListener('click', () => {
      this.updateProfile((profile) => {
        const page = profile.pages[this.selectedPage];
        page.keys = page.keys.filter(
          (key) => key.index !== this.selectedKey,
        );
      });
    });
  }

  renderIconGrid(query) {
    const needle = query.trim().toLowerCase().replace(/[\s-]+/g, '_');
    const matches = [];

    for (const name of ICON_NAMES) {
      if (!needle || name.includes(needle)) {
        matches.push(name);

        if (matches.length === MAX_ICON_RESULTS) {
          break;
        }
      }
    }

    this.iconGrid.replaceChildren();

    if (matches.length === 0) {
      const empty = this.document.createElement('p');
      empty.className = 'helper';
      empty.textContent = 'No icons match that search.';
      this.iconGrid.append(empty);
      return;
    }

    for (const name of matches) {
      const button = this.document.createElement('button');
      button.type = 'button';
      button.className = 'deck-icon-choice';
      button.title = name.replaceAll('_', ' ');

      const glyph = this.document.createElement('span');
      glyph.className = 'ms-icon';
      glyph.textContent = name;
      button.append(glyph);
      button.addEventListener('click', () => {
        this.pickIcon(name);
      });
      this.iconGrid.append(button);
    }
  }

  async pickIcon(name) {
    try {
      const dataUrl = await this.renderMaterialIcon(name);
      this.updateSelectedKey((key) => {
        key.image = dataUrl;
      });
      this.iconDialog.close();
    } catch (error) {
      this.setSyncStatus(`Could not render the icon: ${error.message}`, 'error');
    }
  }

  async renderMaterialIcon(name, color = '#f3f7f9') {
    // The glyph draws as its ligature text until the font is ready.
    await this.document.fonts.load(`128px "${ICON_FONT}"`);

    const canvas = this.document.createElement('canvas');
    canvas.width = STORED_IMAGE_PIXELS;
    canvas.height = STORED_IMAGE_PIXELS;

    const context = canvas.getContext('2d');
    context.font = `${Math.round(STORED_IMAGE_PIXELS * 0.78)}px "${ICON_FONT}"`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = color;
    context.fillText(
      name,
      STORED_IMAGE_PIXELS / 2,
      STORED_IMAGE_PIXELS / 2,
    );
    return canvas.toDataURL('image/webp', 0.92);
  }

  async readImageFile(file) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('The file could not be read.'));
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });
    const image = await loadImage(dataUrl);
    const scale = Math.min(
      1,
      STORED_IMAGE_PIXELS / Math.max(image.width, image.height),
    );
    const canvas = this.document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/webp', 0.92);
  }

  selectedProfile() {
    return this.selectedDeviceId
      ? this.devices[this.selectedDeviceId] || null
      : null;
  }

  selectedKeyData() {
    const profile = this.selectedProfile();

    if (!profile || this.selectedKey === null) {
      return null;
    }

    return (
      profile.pages[this.selectedPage]?.keys.find(
        (key) => key.index === this.selectedKey,
      ) || null
    );
  }

  limitsFor(profile) {
    // The fallback (board missing from the catalog) allows any grid shape
    // but keeps the conservative 30-key baseline budget, since only boards
    // listed with a larger maxKeys accept the extended layout line.
    return (
      this.boardLimits.get(profile?.boardId) || {
        maxCols: MAX_DECK_COLS,
        maxKeys: 30,
        maxPages: MAX_DECK_PAGES,
        maxRows: MAX_DECK_ROWS,
      }
    );
  }

  updateProfile(mutate, render = true, pageScope = false) {
    const profile = this.selectedProfile();

    if (!profile) {
      return;
    }

    mutate(pageScope ? profile.pages[this.selectedPage] : profile);
    this.persistProfile(this.selectedDeviceId);

    if (render) {
      this.renderAll();
    }

    this.scheduleSync(this.selectedDeviceId);
  }

  updateSelectedKey(mutate) {
    const profile = this.selectedProfile();

    if (!profile || this.selectedKey === null) {
      return;
    }

    const page = profile.pages[this.selectedPage];
    let key = page.keys.find((entry) => entry.index === this.selectedKey);

    if (!key) {
      key = { index: this.selectedKey };
      page.keys.push(key);
    }

    mutate(key);

    if (
      !key.label &&
      !key.color &&
      !key.labelColor &&
      !key.image &&
      !key.action
    ) {
      page.keys = page.keys.filter((entry) => entry !== key);
    }

    this.persistProfile(this.selectedDeviceId);
    this.renderAll();
    this.scheduleSync(this.selectedDeviceId);
  }

  resizeSelectedPage() {
    this.updateProfile((page) => {
      page.rows = Number(this.rowsSelect.value);
      page.cols = Number(this.colsSelect.value);

      const keyCount = page.rows * page.cols;
      page.keys = page.keys.filter((key) => key.index < keyCount);

      if (this.selectedKey !== null && this.selectedKey >= keyCount) {
        this.selectedKey = null;
      }
    }, true, true);
  }

  applyActionSelection(action, appearance) {
    const deviceId = this.selectedDeviceId;
    const pageIndex = this.selectedPage;
    const keyIndex = this.selectedKey;
    let addSuggestedIcon = false;
    this.updateSelectedKey((key) => {
      if (action) {
        key.action = action;
      } else {
        delete key.action;
      }

      if (!action || !appearance) {
        return;
      }

      if (!key.label && appearance.label) {
        key.label = appearance.label;
      }

      if (!key.color && appearance.color) {
        key.color = appearance.color;
      }

      if (!key.labelColor && appearance.labelColor) {
        key.labelColor = appearance.labelColor;
      }

      addSuggestedIcon = Boolean(!key.image && appearance.icon);
    });

    if (!addSuggestedIcon) {
      return;
    }

    this.renderMaterialIcon(
      appearance.icon,
      appearance.labelColor || '#f3f7f9',
    ).then((dataUrl) => {
      if (
        this.selectedDeviceId !== deviceId ||
        this.selectedPage !== pageIndex ||
        this.selectedKey !== keyIndex
      ) {
        return;
      }

      const key = this.selectedKeyData();

      if (
        key?.image ||
        JSON.stringify(key?.action) !== JSON.stringify(action)
      ) {
        return;
      }

      this.updateSelectedKey((current) => {
        current.image = dataUrl;
      });
    }).catch((error) => {
      this.setSyncStatus(
        `Could not render the action icon: ${error.message}`,
        'error',
      );
    });
  }

  async persistProfile(deviceId) {
    const profile = this.devices[deviceId];

    if (!profile) {
      return;
    }

    try {
      this.devices[deviceId] = await this.api.saveDeck(deviceId, profile);
    } catch (error) {
      this.setSyncStatus(`Could not save the deck: ${error.message}`, 'error');
    }
  }

  async importProfile() {
    if (!this.selectedDeviceId) {
      return;
    }

    try {
      const { profile } = await this.api.importDeck();

      if (!profile) {
        return;
      }

      const confirmed = window.confirm(
        'Importing replaces the entire deck for the selected device. Continue?',
      );

      if (!confirmed) {
        return;
      }

      this.devices[this.selectedDeviceId] = profile;
      this.selectedPage = profile.activePage;
      this.selectedKey = null;
      await this.persistProfile(this.selectedDeviceId);
      this.renderAll();
      this.scheduleSync(this.selectedDeviceId);
      this.setSyncStatus('Deck profile imported.', 'ready');
    } catch (error) {
      this.setSyncStatus(`Import failed: ${error.message}`, 'error');
    }
  }

  // ---- Device sessions -------------------------------------------------

  async attachSession(session, board) {
    const { deviceId, boardId } = session.hello;
    this.sessions.set(deviceId, session);

    if (!this.devices[deviceId]) {
      try {
        this.devices[deviceId] = await this.api.saveDeck(deviceId, {
          name: `${board?.name || 'Stream32'} deck`,
          boardId,
          activePage: 0,
          pages: [{ name: 'Main', rows: 3, cols: 3, keys: [] }],
        });
      } catch (error) {
        this.setSyncStatus(
          `Could not register the device: ${error.message}`,
          'error',
        );
        return;
      }

      if (!this.selectedDeviceId) {
        this.selectedDeviceId = deviceId;
      }
    }

    this.renderAll();
    this.scheduleSync(deviceId, 0);
  }

  detachSession(session) {
    const deviceId = session.hello?.deviceId;

    if (deviceId && this.sessions.get(deviceId) === session) {
      this.sessions.delete(deviceId);
      this.rejectPending(deviceId, new Error('The device disconnected.'));
      this.renderAll();
    }
  }

  handleDeviceMessage(session, message) {
    const deviceId = session.hello?.deviceId;

    if (!deviceId) {
      return;
    }

    const pending = this.pending.get(deviceId);

    if (pending && ['layout-ack', 'image-ack', 'error'].includes(message.type)) {
      this.pending.delete(deviceId);

      if (message.type === 'error') {
        pending.reject(
          new Error(
            message.code === 'unknown-type'
              ? 'The board firmware is too old for deck layouts. ' +
                'Reflash it from the Flash board section.'
              : `Device error: ${message.code || 'unknown'}`,
          ),
        );
      } else {
        pending.resolve(message);
      }

      return;
    }

    if (message.type === 'press') {
      this.handlePress(deviceId, message);
    } else if (message.type === 'page') {
      this.handleDevicePage(deviceId, message);
    }
  }

  awaitReply(deviceId, timeoutMs = ACK_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(deviceId);
        reject(new Error('The device did not acknowledge in time.'));
      }, timeoutMs);

      this.pending.set(deviceId, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  rejectPending(deviceId, error) {
    const pending = this.pending.get(deviceId);

    if (pending) {
      this.pending.delete(deviceId);
      pending.reject(error);
    }
  }

  handlePress(deviceId, message) {
    const press = validatePressMessage(message);

    if (press.phase !== 'down') {
      return;
    }

    const profile = this.devices[deviceId];
    const key = profile?.pages[press.page]?.keys.find(
      (entry) => entry.index === press.index,
    );

    if (key?.action) {
      this.runKeyAction(deviceId, key.action);
    }
  }

  handleDevicePage(deviceId, message) {
    const { index } = validatePageMessage(message);
    const profile = this.devices[deviceId];

    if (!profile || index >= profile.pages.length) {
      return;
    }

    profile.activePage = index;
    this.persistProfile(deviceId);

    if (deviceId === this.selectedDeviceId) {
      this.selectedPage = index;
      this.selectedKey = null;
      this.renderAll();
    }
  }

  async runKeyAction(deviceId, action) {
    try {
      if (action.type === 'page') {
        const session = this.sessions.get(deviceId);
        await session?.send(encodePageMessage(action.page));

        const profile = this.devices[deviceId];

        if (profile && action.page < profile.pages.length) {
          profile.activePage = action.page;
          this.persistProfile(deviceId);

          if (deviceId === this.selectedDeviceId) {
            this.selectedPage = action.page;
            this.selectedKey = null;
            this.renderAll();
          }
        }

        return;
      }

      await this.api.runAction(action);
    } catch (error) {
      this.setSyncStatus(`Action failed: ${error.message}`, 'error');
    }
  }

  // ---- Sync engine -----------------------------------------------------

  scheduleSync(deviceId, delay = SYNC_DEBOUNCE_MS) {
    if (!deviceId || !this.sessions.has(deviceId)) {
      this.renderSyncStatus();
      return;
    }

    clearTimeout(this.syncTimers.get(deviceId));
    this.syncTimers.set(
      deviceId,
      setTimeout(() => {
        this.syncTimers.delete(deviceId);
        this.syncDevice(deviceId);
      }, delay),
    );
  }

  async syncDevice(deviceId) {
    if (this.syncRunning.get(deviceId)) {
      this.syncRunning.set(deviceId, 'again');
      return;
    }

    const session = this.sessions.get(deviceId);
    const profile = this.devices[deviceId];

    if (!session || !profile) {
      return;
    }

    this.syncRunning.set(deviceId, 'running');
    this.setSyncStatus('Syncing the deck to the device…', 'working');

    try {
      for (const [pageIndex, page] of profile.pages.entries()) {
        await this.syncPage(deviceId, session, profile, pageIndex, page);
      }

      await session.send(encodePageMessage(profile.activePage));
      this.setSyncStatus('Deck synced to the device.', 'ready');
    } catch (error) {
      this.setSyncStatus(error.message, 'error');
    } finally {
      const runAgain = this.syncRunning.get(deviceId) === 'again';
      this.syncRunning.delete(deviceId);

      if (runAgain) {
        this.scheduleSync(deviceId, 0);
      }
    }
  }

  async syncPage(deviceId, session, profile, pageIndex, page) {
    let keyPx = profile.keyPx[gridKey(page)];

    if (!keyPx) {
      // First contact with this grid size: one extra round trip teaches us
      // the key size so artwork CRCs can be computed.
      const ack = await this.sendLayout(deviceId, session, profile, pageIndex, page, new Map());
      keyPx = ack.keyPx;
      profile.keyPx[gridKey(page)] = keyPx;
      this.persistProfile(deviceId);
    }

    const renders = await this.renderPageImages(page, keyPx);
    const ack = await this.sendLayout(
      deviceId,
      session,
      profile,
      pageIndex,
      page,
      renders,
    );

    if (ack.keyPx !== keyPx) {
      profile.keyPx[gridKey(page)] = ack.keyPx;
      this.persistProfile(deviceId);
      return this.syncPage(deviceId, session, profile, pageIndex, page);
    }

    for (const index of ack.needImages) {
      const render = renders.get(index);

      if (render) {
        await this.streamImage(deviceId, session, pageIndex, index, keyPx, render);
      }
    }
  }

  async sendLayout(deviceId, session, profile, pageIndex, page, renders) {
    const keys = page.keys.map((key) => {
      const entry = { index: key.index };

      if (key.label) {
        entry.label = key.label;
      }

      if (key.color) {
        entry.color = key.color;
      }

      if (key.labelColor) {
        entry.labelColor = key.labelColor;
      }

      const render = renders.get(key.index);

      if (render) {
        entry.imageCrc = render.crc;
      }

      if (key.action?.type === 'page') {
        entry.goPage = key.action.page;
      }

      return entry;
    });

    const reply = this.awaitReply(deviceId);
    await session.send(
      encodeLayoutMessage(
        {
          page: pageIndex,
          of: profile.pages.length,
          rows: page.rows,
          cols: page.cols,
          keys,
        },
        layoutLineLimitFor(this.limitsFor(profile)),
      ),
    );
    return validateLayoutAck(await reply);
  }

  async streamImage(deviceId, session, pageIndex, index, keyPx, render) {
    const chunks = encodeImageChunks({
      page: pageIndex,
      index,
      width: keyPx,
      height: keyPx,
      pixels: render.pixels,
    });

    for (const [seq, chunk] of chunks.entries()) {
      this.setSyncStatus(
        `Sending key artwork… page ${pageIndex + 1}, key ${index + 1}, ` +
          `${Math.round(((seq + 1) / chunks.length) * 100)}%`,
        'working',
      );

      const reply = this.awaitReply(deviceId);
      await session.send(chunk);
      const ack = validateImageAck(await reply);

      if (ack.page !== pageIndex || ack.index !== index || ack.seq !== seq) {
        throw new Error('The device acknowledged the wrong image chunk.');
      }
    }
  }

  async renderPageImages(page, keyPx) {
    const renders = new Map();

    for (const key of page.keys) {
      if (!key.image) {
        continue;
      }

      const canvas = this.document.createElement('canvas');
      canvas.width = keyPx;
      canvas.height = keyPx;

      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.fillStyle = key.color || DEFAULT_KEY_COLOR;
      context.fillRect(0, 0, keyPx, keyPx);

      try {
        const image = await loadImage(key.image);
        const scale = Math.min(keyPx / image.width, keyPx / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        context.drawImage(
          image,
          (keyPx - width) / 2,
          (keyPx - height) / 2,
          width,
          height,
        );
      } catch {
        // A corrupt stored image falls back to the key color.
      }

      const pixels = toRgb565(context.getImageData(0, 0, keyPx, keyPx));
      renders.set(key.index, { crc: crc32(pixels), pixels });
    }

    return renders;
  }

  // ---- Rendering ---------------------------------------------------------

  setSyncStatus(message, state) {
    this.syncStatus.textContent = message;
    this.syncStatus.dataset.state = state;
  }

  renderSyncStatus() {
    if (!this.selectedDeviceId) {
      this.setSyncStatus('', 'idle');
      return;
    }

    if (!this.sessions.has(this.selectedDeviceId)) {
      this.setSyncStatus(
        'Device offline — changes sync automatically on its next connection.',
        'idle',
      );
    }
  }

  renderAll() {
    this.renderDevicePicker();
    this.renderPages();
    this.renderGrid();
    this.renderKeyEditor();
    this.renderSyncStatus();
  }

  renderDevicePicker() {
    const deviceIds = Object.keys(this.devices);
    this.deviceSelect.replaceChildren();

    for (const deviceId of deviceIds) {
      const option = this.document.createElement('option');
      option.value = deviceId;
      option.textContent = deviceLabel(deviceId, this.devices[deviceId]);
      this.deviceSelect.append(option);
    }

    const hasDevices = deviceIds.length > 0;
    this.emptyState.hidden = hasDevices;
    this.editorPanel.hidden = !hasDevices;

    if (!hasDevices) {
      this.selectedDeviceId = null;
      return;
    }

    if (!deviceIds.includes(this.selectedDeviceId)) {
      this.selectedDeviceId = deviceIds[0];
    }

    this.deviceSelect.value = this.selectedDeviceId;

    const profile = this.selectedProfile();
    this.deviceName.value = profile.name;
    this.deviceStatus.textContent = this.sessions.has(this.selectedDeviceId)
      ? 'Connected'
      : 'Offline';
    this.deviceStatus.dataset.state = this.sessions.has(this.selectedDeviceId)
      ? 'ready'
      : 'idle';
  }

  renderPages() {
    const profile = this.selectedProfile();
    this.pageTabs.replaceChildren();

    if (!profile) {
      return;
    }

    this.selectedPage = Math.min(this.selectedPage, profile.pages.length - 1);

    for (const [index, page] of profile.pages.entries()) {
      const tab = this.document.createElement('button');
      tab.type = 'button';
      tab.className = 'deck-page-tab';
      tab.textContent = page.name;
      tab.dataset.active = String(index === this.selectedPage);
      tab.addEventListener('click', () => {
        this.selectedPage = index;
        this.selectedKey = null;
        this.renderAll();
      });
      this.pageTabs.append(tab);
    }

    const limits = this.limitsFor(profile);
    this.addPageButton.disabled = profile.pages.length >= limits.maxPages;
    this.removePageButton.disabled = profile.pages.length <= 1;

    const page = profile.pages[this.selectedPage];
    this.pageName.value = page.name;

    // Each axis is also bounded by the board's per-page key budget given
    // the current value of the other axis, so shapes like 9x4 are
    // reachable by lowering one side before raising the other.
    for (const option of this.rowsSelect.options) {
      const rows = Number(option.value);
      option.disabled =
        rows > limits.maxRows || rows * page.cols > limits.maxKeys;
    }

    for (const option of this.colsSelect.options) {
      const cols = Number(option.value);
      option.disabled =
        cols > limits.maxCols || page.rows * cols > limits.maxKeys;
    }

    this.rowsSelect.value = String(page.rows);
    this.colsSelect.value = String(page.cols);
  }

  renderGrid() {
    const profile = this.selectedProfile();
    this.grid.replaceChildren();

    if (!profile) {
      return;
    }

    const page = profile.pages[this.selectedPage];
    this.grid.style.setProperty('--deck-cols', String(page.cols));
    this.grid.style.setProperty('--deck-rows', String(page.rows));

    for (let index = 0; index < page.rows * page.cols; index++) {
      const key = page.keys.find((entry) => entry.index === index);
      const cell = this.document.createElement('button');
      cell.type = 'button';
      cell.className = 'deck-key';
      cell.dataset.selected = String(index === this.selectedKey);

      if (key?.color) {
        cell.style.background = key.color;
      }

      if (key?.image) {
        const image = this.document.createElement('img');
        image.src = key.image;
        image.alt = '';
        cell.append(image);
        cell.dataset.hasImage = 'true';
      }

      if (key?.label) {
        const label = this.document.createElement('span');
        label.textContent = key.label;

        if (key.labelColor) {
          label.style.color = key.labelColor;
        }

        cell.append(label);
      }

      cell.dataset.empty = String(
        !key || (!key.label && !key.color && !key.image && !key.action),
      );

      if (key?.action?.type === 'page') {
        cell.dataset.badge = '⇒';
      }

      cell.addEventListener('click', () => {
        this.selectedKey = index;
        this.renderAll();
      });
      this.grid.append(cell);
    }
  }

  renderKeyEditor() {
    const profile = this.selectedProfile();

    if (!profile || this.selectedKey === null) {
      this.keyEditor.hidden = true;
      return;
    }

    this.keyEditor.hidden = false;

    const page = profile.pages[this.selectedPage];
    const key = this.selectedKeyData() || { index: this.selectedKey };
    const row = Math.floor(this.selectedKey / page.cols) + 1;
    const col = (this.selectedKey % page.cols) + 1;

    this.keyTitle.textContent = `Key ${this.selectedKey + 1} (row ${row}, column ${col})`;
    this.keyLabel.value = key.label || '';
    this.keyColor.value = key.color || DEFAULT_KEY_COLOR;
    this.keyLabelColor.value = key.labelColor || '#f3f7f9';
    this.keyImageClear.disabled = !key.image;

    const action = key.action || null;
    this.actionEditor.render({
      action,
      context: `${this.selectedDeviceId}:${this.selectedPage}:${this.selectedKey}`,
      pages: profile.pages,
    });

    this.keyTest.disabled = !action;
  }
}

module.exports = { DeckController };
