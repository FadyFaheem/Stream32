const ICON_NAMES = require('./icon-names.json');
const { ActionEditor } = require('./action-editor');
const { DeckRuntime } = require('./deck-runtime');
const {
  isEditableTarget,
  keyPayload,
  moveKey,
  pasteKey,
} = require('./key-clipboard');
const { remapActionAfterPageDeletion } = require('../action-model');
const { MAX_NAME_LENGTH } = require('../deck-model');
const {
  mergeKeyOverlay,
} = require('../dynamic-state');
const {
  MAX_DECK_COLS,
  MAX_DECK_KEYS,
  MAX_DECK_PAGES,
  MAX_DECK_ROWS,
  MAX_KEY_LABEL_LENGTH,
  crc32,
} = require('./protocol');
const {
  parseManualAppMatch,
  preferredRuleForSnapshot,
  selectPageForSnapshot,
  selectProfileForSnapshot,
} = require('../profile-rules');

const STORED_IMAGE_PIXELS = 192;
const DEFAULT_KEY_COLOR = '#172630';
const ICON_FONT = 'Material Symbols Rounded';
const MAX_ICON_RESULTS = 96;
const MAX_NAMED_PROFILES = 16;
const KEY_DRAG_TYPE = 'application/x-stream32-key';

function deviceLabel(deviceId, device) {
  return `${device.name} · ${deviceId.slice(-4)}`;
}

function appMatchText(platform, rule) {
  if (!rule) {
    return '';
  }

  if (platform === 'darwin' && rule.kind === 'processName') {
    return `process:${rule.value}`;
  }

  if (platform === 'linux') {
    return `${rule.kind === 'processName' ? 'process' : 'class'}:${rule.value}`;
  }

  return rule.value;
}

function pageIndexAfterDeletion(index, removed, pageCount) {
  if (index > removed) {
    return index - 1;
  }

  return index === removed ? Math.min(removed, pageCount - 1) : index;
}

function removeProfilePage(profile, removed) {
  profile.pages.splice(removed, 1);
  profile.activePage = pageIndexAfterDeletion(
    profile.activePage,
    removed,
    profile.pages.length,
  );
  profile.defaultPage = pageIndexAfterDeletion(
    profile.defaultPage,
    removed,
    profile.pages.length,
  );

  // Page targets pointing at or past the removed page are remapped so
  // top-level and multi actions remain valid.
  for (const page of profile.pages) {
    for (const key of page.keys) {
      const action = remapActionAfterPageDeletion(key.action, removed);

      if (!action) {
        delete key.action;
      } else {
        key.action = action;
      }
    }
  }
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
    this.selectedDeviceId = null;
    this.selectedPage = 0;
    this.selectedKey = null;
    this.clipboard = null;
    this.dragSource = null;
    this.focusSnapshot = null;
    this.focusStatus = null;
    this.storageErrors = [];
    this.profileDialogMode = null;
    this.profileDialogProfileId = null;
    this.profileDialogReturnFocus = null;

    this.connectPanel = document.querySelector('#deck-connect');
    this.deviceSelect = document.querySelector('#deck-device');
    this.deviceStatus = document.querySelector('#deck-device-status');
    this.deviceName = document.querySelector('#deck-device-name');
    this.profileTabs = document.querySelector('#deck-profile-tabs');
    this.profileCreate = document.querySelector('#deck-profile-create');
    this.profileDuplicate = document.querySelector('#deck-profile-duplicate');
    this.profileRename = document.querySelector('#deck-profile-rename');
    this.profileDelete = document.querySelector('#deck-profile-delete');
    this.profileDialog = document.querySelector('#deck-profile-dialog');
    this.profileForm = document.querySelector('#deck-profile-form');
    this.profileDialogTitle =
      document.querySelector('#deck-profile-dialog-title');
    this.profileName = document.querySelector('#deck-profile-name');
    this.profileDialogError =
      document.querySelector('#deck-profile-dialog-error');
    this.profileDialogCancel =
      document.querySelector('#deck-profile-dialog-cancel');
    this.profileDialogSubmit =
      document.querySelector('#deck-profile-dialog-submit');
    this.profileDefault = document.querySelector('#deck-profile-default');
    this.profileMatchInput = document.querySelector('#deck-profile-match');
    this.profileMatchSave = document.querySelector('#deck-profile-match-save');
    this.profileMatchClear = document.querySelector('#deck-profile-match-clear');
    this.profileMatchFocused =
      document.querySelector('#deck-profile-match-focused');
    this.profileMatchStatus =
      document.querySelector('#deck-profile-match-status');
    this.exportButton = document.querySelector('#deck-export');
    this.importButton = document.querySelector('#deck-import');
    this.syncStatus = document.querySelector('#deck-sync-status');
    this.pageTabs = document.querySelector('#deck-page-tabs');
    this.addPageButton = document.querySelector('#deck-add-page');
    this.removePageButton = document.querySelector('#deck-remove-page');
    this.pageDefault = document.querySelector('#deck-page-default');
    this.pageMatchInput = document.querySelector('#deck-page-match');
    this.pageMatchSave = document.querySelector('#deck-page-match-save');
    this.pageMatchClear = document.querySelector('#deck-page-match-clear');
    this.pageMatchFocused =
      document.querySelector('#deck-page-match-focused');
    this.pageMatchStatus =
      document.querySelector('#deck-page-match-status');
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
    this.liveProvider = document.querySelector('#deck-live-provider');
    this.liveToggleFields = document.querySelector('#deck-live-toggle-fields');
    this.liveOnLabel = document.querySelector('#deck-live-on-label');
    this.liveOnColor = document.querySelector('#deck-live-on-color');
    this.liveOnLabelColor = document.querySelector('#deck-live-on-label-color');
    this.liveOnImage = document.querySelector('#deck-live-on-image');
    this.liveOnImageClear = document.querySelector('#deck-live-on-image-clear');
    this.liveClockField = document.querySelector('#deck-live-clock-field');
    this.liveClockFormat = document.querySelector('#deck-live-clock-format');
    this.liveStatus = document.querySelector('#deck-live-status');
    this.iconOpen = document.querySelector('#deck-icon-open');
    this.iconDialog = document.querySelector('#deck-icon-dialog');
    this.iconSearch = document.querySelector('#deck-icon-search');
    this.iconGrid = document.querySelector('#deck-icon-grid');
    this.iconClose = document.querySelector('#deck-icon-close');
    this.keyTest = document.querySelector('#deck-key-test');
    this.keyCopy = document.querySelector('#deck-key-copy');
    this.keyCut = document.querySelector('#deck-key-cut');
    this.keyPaste = document.querySelector('#deck-key-paste');
    this.keyClear = document.querySelector('#deck-key-clear');
    this.actionEditor = new ActionEditor({
      document,
      onChange: (action, appearance) => {
        this.applyActionSelection(action, appearance);
      },
      onReload: () => this.api.listPlugins(true),
    });
    this.runtime = new DeckRuntime({
      api,
      getDevices: () => this.devices,
      getProfile: (deviceId, profileId) =>
        this.profileFor(deviceId, profileId),
      getSelectedProfileId: (deviceId) => this.selectedProfileId(deviceId),
      setDevice: (deviceId, device) => {
        this.devices[deviceId] = device;
      },
      persistProfile: (deviceId, profileId) =>
        this.persistProfile(deviceId, profileId),
      renderPageImages: (page, keyPx) => this.renderPageImages(page, keyPx),
      limitsFor: (profile) => this.limitsFor(profile),
      resolveProfileForSnapshot: selectProfileForSnapshot,
      resolvePageForSnapshot: selectPageForSnapshot,
      getFocusStatus: () => this.focusStatus,
      getFocusSnapshot: () => this.focusSnapshot,
      onDeviceRegistered: (deviceId) => {
        this.selectedDeviceId ||= deviceId;
      },
      onSelectedPage: (deviceId, page) => {
        if (deviceId === this.selectedDeviceId) {
          this.selectedPage = page;
          this.selectedKey = null;
          this.renderAll();
        }
      },
      onRenderAll: () => this.renderAll(),
      onRenderSelectedLive: (deviceId) => {
        if (deviceId === this.selectedDeviceId) {
          this.renderGrid();
          this.renderKeyEditor();
        }
      },
      onStatus: (message, state) => this.setSyncStatus(message, state),
      onProfileStatus: (message, state) =>
        this.setProfileMatchStatus(message, state),
      onRenderSyncStatus: () => this.renderSyncStatus(),
    });
  }

  async initialize() {
    this.populateStaticControls();
    this.bindEvents();
    this.api.onFocusChange((snapshot) => {
      this.focusSnapshot = snapshot;
      this.renderFocusRules();
      this.runtime.queueAutoSwitch(snapshot);
      this.runtime.refreshLiveStates();
    });
    this.api.onFocusStatus((status) => {
      this.focusStatus = status;
      this.renderFocusRules();
      this.runtime.refreshLiveStates();
    });

    try {
      await this.reloadPlugins(false);
    } catch (error) {
      this.actionEditor.setCatalogError(error.message);
    }

    try {
      if (typeof this.api.getActionCapabilities === 'function') {
        this.actionEditor.setCapabilities(
          await this.api.getActionCapabilities(),
        );
      }
    } catch (error) {
      this.actionEditor.setCapabilities({
        text: { available: false, reason: error.message },
        mouse: { available: false, reason: error.message },
      });
    }

    try {
      const registry = await this.api.listDecks();
      this.devices = registry.devices;
      this.storageErrors = Array.isArray(registry.errors)
        ? registry.errors
        : [];
    } catch (error) {
      this.setSyncStatus(`Could not load deck profiles: ${error.message}`, 'error');
    }

    try {
      [this.focusStatus, this.focusSnapshot] = await Promise.all([
        this.api.getFocusStatus(),
        this.api.getFocusSnapshot(),
      ]);
    } catch (error) {
      this.focusStatus = {
        platform: null,
        supported: false,
        state: 'error',
        reason: `Could not start focused-app switching: ${error.message}`,
      };
    }

    this.selectedDeviceId = Object.keys(this.devices)[0] || null;
    this.renderAll();
    this.runtime.startLiveTimers();

    if (this.focusSnapshot) {
      await this.runtime.queueAutoSwitch(this.focusSnapshot);
    }
  }

  async reloadPlugins(force = true) {
    const catalog = await this.api.listPlugins(force);
    this.actionEditor.setCatalog(catalog);
    return catalog;
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
    this.deviceName.addEventListener('change', async () => {
      if (!this.selectedDeviceId) {
        return;
      }

      try {
        this.devices[this.selectedDeviceId] = await this.api.renameDeck(
          this.selectedDeviceId,
          this.deviceName.value.trim() || 'Stream32 deck',
        );
        this.renderDevicePicker();
      } catch (error) {
        this.setSyncStatus(`Could not rename the device: ${error.message}`, 'error');
        this.renderDevicePicker();
      }
    });
    this.profileCreate.addEventListener('click', () => {
      this.openProfileDialog('create', this.profileCreate);
    });
    this.profileDuplicate.addEventListener('click', () => {
      const profileId = this.selectedProfileId();

      if (profileId) {
        this.runProfileOperation({ type: 'duplicate', profileId });
      }
    });
    this.profileRename.addEventListener('click', () => {
      this.openProfileDialog('rename', this.profileRename);
    });
    this.profileForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submitProfileDialog();
    });
    this.profileDialogCancel.addEventListener('click', () => {
      this.profileDialog.close();
    });
    this.profileDialog.addEventListener('click', (event) => {
      if (event.target === this.profileDialog) {
        this.profileDialog.close();
      }
    });
    this.profileDialog.addEventListener('close', () => {
      const target = this.profileDialogReturnFocus;
      this.profileDialogMode = null;
      this.profileDialogProfileId = null;
      this.profileDialogReturnFocus = null;
      target?.focus();
    });
    this.profileDelete.addEventListener('click', () => {
      const profileId = this.selectedProfileId();
      const profile = this.selectedProfile();

      if (
        profileId &&
        profile &&
        window.confirm(
          `Delete profile “${profile.name}”? Keys and pages in it cannot be recovered.`,
        )
      ) {
        this.runProfileOperation({ type: 'delete', profileId });
      }
    });
    this.profileDefault.addEventListener('click', async () => {
      const profileId = this.selectedProfileId();

      if (profileId) {
        await this.runProfileOperation({ type: 'set-default', profileId });
        this.runtime.queueAutoSwitch(this.focusSnapshot);
      }
    });
    this.profileMatchFocused.addEventListener('click', async () => {
      const profileId = this.selectedProfileId();
      const platform = this.focusStatus?.platform;

      if (!profileId || !platform || !this.focusSnapshot) {
        return;
      }

      try {
        const rule = preferredRuleForSnapshot(this.focusSnapshot);
        await this.runProfileOperation({
          type: 'set-app-match',
          profileId,
          platform,
          rule,
        });
        this.runtime.queueAutoSwitch(this.focusSnapshot);
      } catch (error) {
        this.setProfileMatchStatus(error.message, 'error');
      }
    });
    this.profileMatchSave.addEventListener('click', async () => {
      const profileId = this.selectedProfileId();
      const platform = this.focusStatus?.platform;

      if (!profileId || !platform) {
        return;
      }

      try {
        const rule = parseManualAppMatch(
          platform,
          this.profileMatchInput.value,
        );
        await this.runProfileOperation({
          type: 'set-app-match',
          profileId,
          platform,
          rule,
        });
        this.runtime.queueAutoSwitch(this.focusSnapshot);
      } catch (error) {
        this.setProfileMatchStatus(error.message, 'error');
      }
    });
    this.profileMatchClear.addEventListener('click', async () => {
      const profileId = this.selectedProfileId();
      const platform = this.focusStatus?.platform;

      if (!profileId || !platform) {
        return;
      }

      await this.runProfileOperation({
        type: 'set-app-match',
        profileId,
        platform,
        rule: null,
      });
      this.runtime.queueAutoSwitch(this.focusSnapshot);
    });
    this.pageDefault.addEventListener('click', async () => {
      const profileId = this.selectedProfileId();

      if (profileId) {
        await this.runProfileOperation({
          type: 'set-default-page',
          profileId,
          page: this.selectedPage,
        });
        this.runtime.queueAutoSwitch(this.focusSnapshot);
      }
    });
    this.pageMatchFocused.addEventListener('click', async () => {
      const profileId = this.selectedProfileId();
      const platform = this.focusStatus?.platform;

      if (!profileId || !platform || !this.focusSnapshot) {
        return;
      }

      try {
        await this.runProfileOperation({
          type: 'set-page-app-match',
          profileId,
          page: this.selectedPage,
          platform,
          rule: preferredRuleForSnapshot(this.focusSnapshot),
        });
        this.runtime.queueAutoSwitch(this.focusSnapshot);
      } catch (error) {
        this.setPageMatchStatus(error.message, 'error');
      }
    });
    this.pageMatchSave.addEventListener('click', async () => {
      const profileId = this.selectedProfileId();
      const platform = this.focusStatus?.platform;

      if (!profileId || !platform) {
        return;
      }

      try {
        await this.runProfileOperation({
          type: 'set-page-app-match',
          profileId,
          page: this.selectedPage,
          platform,
          rule: parseManualAppMatch(platform, this.pageMatchInput.value),
        });
        this.runtime.queueAutoSwitch(this.focusSnapshot);
      } catch (error) {
        this.setPageMatchStatus(error.message, 'error');
      }
    });
    this.pageMatchClear.addEventListener('click', async () => {
      const profileId = this.selectedProfileId();
      const platform = this.focusStatus?.platform;

      if (!profileId || !platform) {
        return;
      }

      await this.runProfileOperation({
        type: 'set-page-app-match',
        profileId,
        page: this.selectedPage,
        platform,
        rule: null,
      });
      this.runtime.queueAutoSwitch(this.focusSnapshot);
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
          appMatches: {},
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
        removeProfilePage(profile, removed);
        this.selectedPage = Math.min(
          this.selectedPage,
          profile.pages.length - 1,
        );
        this.selectedKey = null;
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
    this.liveProvider.addEventListener('change', () => {
      this.runtime.clearLiveRuntime(this.selectedDeviceId);
      this.updateSelectedKey((key) => {
        const provider = this.liveProvider.value;

        if (!provider) {
          delete key.liveState;
        } else if (provider === 'toggle') {
          key.liveState = {
            provider,
            on: {
              color: '#2f8f5b',
              labelColor: '#ffffff',
            },
          };
        } else if (provider === 'clock') {
          key.liveState = { provider, hour12: false };
        } else {
          key.liveState = { provider: 'focused-app' };
        }
      });
      this.runtime.refreshLiveStates(this.selectedDeviceId);
    });
    for (const control of [
      this.liveOnLabel,
      this.liveOnColor,
      this.liveOnLabelColor,
      this.liveClockFormat,
    ]) {
      control.addEventListener('change', () => this.saveLiveConfigFromEditor());
    }
    this.liveOnImage.addEventListener('change', async () => {
      const file = this.liveOnImage.files?.[0];
      this.liveOnImage.value = '';

      if (!file) {
        return;
      }

      try {
        const image = await this.readImageFile(file);
        this.updateSelectedKey((key) => {
          if (key.liveState?.provider === 'toggle') {
            key.liveState.on.image = image;
          }
        });
        this.runtime.refreshLiveStates(this.selectedDeviceId);
      } catch (error) {
        this.setSyncStatus(`Could not read live image: ${error.message}`, 'error');
      }
    });
    this.liveOnImageClear.addEventListener('click', () => {
      this.updateSelectedKey((key) => {
        if (key.liveState?.provider === 'toggle') {
          delete key.liveState.on.image;
        }
      });
      this.runtime.refreshLiveStates(this.selectedDeviceId);
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
        this.runtime.runKeyAction(this.selectedDeviceId, key.action, {
          profileId: this.selectedProfileId(),
          page: this.selectedPage,
          index: this.selectedKey,
        });
      }
    });
    this.keyCopy.addEventListener('click', () => this.copySelectedKey());
    this.keyCut.addEventListener('click', () => this.copySelectedKey(true));
    this.keyPaste.addEventListener('click', () => this.pasteSelectedKey());
    this.keyClear.addEventListener('click', () => {
      this.updateProfile((profile) => {
        const page = profile.pages[this.selectedPage];
        page.keys = page.keys.filter(
          (key) => key.index !== this.selectedKey,
        );
      });
    });
    this.document.addEventListener('keydown', (event) => {
      if (
        event.altKey ||
        (!event.ctrlKey && !event.metaKey) ||
        isEditableTarget(event.target) ||
        !this.document.activeElement?.classList?.contains('deck-key')
      ) {
        return;
      }

      const operation = event.key.toLowerCase();

      if (!['c', 'v', 'x'].includes(operation)) {
        return;
      }

      event.preventDefault();

      if (operation === 'c') {
        this.copySelectedKey();
      } else if (operation === 'x') {
        this.copySelectedKey(true);
      } else {
        this.pasteSelectedKey();
      }
    });
  }

  setProfileDialogError(message) {
    this.profileDialogError.textContent = message;
    this.profileName.setAttribute('aria-invalid', String(Boolean(message)));
  }

  openProfileDialog(mode, returnFocus) {
    const profileId = this.selectedProfileId();
    const profile = this.selectedProfile();

    if (mode === 'rename' && (!profileId || !profile)) {
      return;
    }

    this.profileDialogMode = mode;
    this.profileDialogProfileId = mode === 'rename' ? profileId : null;
    this.profileDialogReturnFocus = returnFocus || this.document.activeElement;
    this.profileDialogTitle.textContent =
      mode === 'rename' ? 'Rename profile' : 'Add profile';
    this.profileDialogSubmit.textContent =
      mode === 'rename' ? 'Rename profile' : 'Add profile';
    this.profileDialogSubmit.disabled = false;
    this.profileName.maxLength = MAX_NAME_LENGTH;
    this.profileName.value = mode === 'rename' ? profile.name : 'Profile';
    this.setProfileDialogError('');
    this.profileDialog.showModal();
    this.profileName.focus();
    this.profileName.select();
  }

  profileNameError(name) {
    if (!name) {
      return 'Enter a profile name.';
    }

    if (name.length > MAX_NAME_LENGTH) {
      return `Profile names can be at most ${MAX_NAME_LENGTH} characters.`;
    }

    const duplicate = Object.entries(this.selectedDevice()?.profiles || {})
      .some(([profileId, profile]) =>
        profileId !== this.profileDialogProfileId &&
        profile.name.toLowerCase() === name.toLowerCase());
    return duplicate ? 'Profile names must be unique per device.' : '';
  }

  async submitProfileDialog() {
    const name = this.profileName.value.trim();
    const validationError = this.profileNameError(name);

    if (validationError) {
      this.setProfileDialogError(validationError);
      this.profileName.focus();
      return false;
    }

    const mode = this.profileDialogMode;

    if (!mode) {
      return false;
    }

    this.profileDialogSubmit.disabled = true;
    this.setProfileDialogError('');
    const operation = mode === 'rename'
      ? {
          type: 'rename',
          profileId: this.profileDialogProfileId,
          name,
        }
      : { type: 'create', name };
    const succeeded = await this.runProfileOperation(operation, {
      onError: (error) => this.setProfileDialogError(error.message),
    });
    this.profileDialogSubmit.disabled = false;

    if (succeeded) {
      this.profileDialog.close();
    } else {
      this.profileName.focus();
    }

    return succeeded;
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

  selectedDevice() {
    return this.selectedDeviceId
      ? this.devices[this.selectedDeviceId] || null
      : null;
  }

  selectedProfileId(deviceId = this.selectedDeviceId) {
    return deviceId
      ? this.devices[deviceId]?.activeProfileId || null
      : null;
  }

  profileFor(deviceId, profileId = this.selectedProfileId(deviceId)) {
    return profileId
      ? this.devices[deviceId]?.profiles[profileId] || null
      : null;
  }

  selectedProfile() {
    return this.profileFor(
      this.selectedDeviceId,
      this.selectedProfileId(),
    );
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

  isKeyDrag(event) {
    return Boolean(
      this.dragSource ||
      Array.from(event.dataTransfer?.types || []).includes(KEY_DRAG_TYPE),
    );
  }

  focusKey(index) {
    this.grid
      .querySelector(`[data-key-index="${index}"]`)
      ?.focus();
  }

  async runProfileOperation(operation, { onError } = {}) {
    if (!this.selectedDeviceId) {
      return false;
    }

    const deviceId = this.selectedDeviceId;
    const previousProfileId = this.selectedProfileId();

    try {
      this.devices[deviceId] = await this.api.runProfileOperation(
        deviceId,
        operation,
      );
      const activeProfileChanged =
        this.selectedProfileId() !== previousProfileId;

      if (activeProfileChanged || operation.type === 'delete') {
        this.runtime.clearLiveRuntime(deviceId);
      }

      if (activeProfileChanged) {
        this.selectedPage = this.selectedProfile()?.activePage ?? 0;
        this.selectedKey = null;
      }

      this.renderAll();

      if (activeProfileChanged) {
        this.runtime.scheduleSync(deviceId, 0);
      }
      return true;
    } catch (error) {
      onError?.(error);
      this.setSyncStatus(`Profile change failed: ${error.message}`, 'error');
      return false;
    }
  }

  copySelectedKey(cut = false) {
    const key = this.selectedKeyData();

    if (!key) {
      this.setSyncStatus('This key is empty.', 'idle');
      return;
    }

    this.clipboard = keyPayload(key);

    if (cut) {
      this.updateProfile((profile) => {
        const page = profile.pages[this.selectedPage];
        page.keys = page.keys.filter(
          (entry) => entry.index !== this.selectedKey,
        );
      });
      this.focusKey(this.selectedKey);
    }

    this.setSyncStatus(
      cut ? 'Key cut. Choose a destination and paste.' : 'Key copied.',
      'ready',
    );
  }

  pasteSelectedKey() {
    const profile = this.selectedProfile();

    if (!profile || this.selectedKey === null || !this.clipboard) {
      this.setSyncStatus('Copy or cut a key before pasting.', 'idle');
      return;
    }

    const page = profile.pages[this.selectedPage];
    const occupied = page.keys.some((key) => key.index === this.selectedKey);

    if (
      occupied &&
      !window.confirm('Replace the key already in this position?')
    ) {
      return;
    }

    try {
      page.keys = pasteKey(
        page.keys,
        this.selectedKey,
        this.clipboard,
        profile.pages.length,
      );
      this.persistProfile(
        this.selectedDeviceId,
        this.selectedProfileId(),
      );
      this.renderAll();
      this.focusKey(this.selectedKey);
      this.runtime.scheduleSync(this.selectedDeviceId);
      this.setSyncStatus('Key pasted.', 'ready');
    } catch (error) {
      this.setSyncStatus(`Could not paste key: ${error.message}`, 'error');
    }
  }

  async dropKey(destinationIndex) {
    const source = this.dragSource;

    if (!source || source.deviceId !== this.selectedDeviceId) {
      this.setSyncStatus(
        'Keys can only be dragged between profiles on the same device.',
        'error',
      );
      return;
    }

    const destinationProfileId = this.selectedProfileId();
    const destinationPage = this.selectedPage;
    const sourceProfile = this.profileFor(source.deviceId, source.profileId);
    const destinationProfile = this.selectedProfile();

    if (!sourceProfile || !destinationProfile) {
      return;
    }

    const samePage =
      source.profileId === destinationProfileId &&
      source.page === destinationPage;

    if (samePage && source.index === destinationIndex) {
      return;
    }

    try {
      const sourceCandidate = structuredClone(sourceProfile);
      const destinationCandidate =
        source.profileId === destinationProfileId
          ? sourceCandidate
          : structuredClone(destinationProfile);
      const sourcePage = sourceCandidate.pages[source.page];
      const targetPage = destinationCandidate.pages[destinationPage];

      if (!sourcePage || !targetPage) {
        throw new Error('The drag destination is no longer available.');
      }

      const moved = moveKey({
        sourceKeys: sourcePage.keys,
        sourceIndex: source.index,
        sourcePageCount: sourceProfile.pages.length,
        destinationKeys: targetPage.keys,
        destinationIndex,
        destinationPageCount: destinationProfile.pages.length,
        samePage,
      });
      sourcePage.keys = moved.sourceKeys;
      targetPage.keys = moved.destinationKeys;

      const profileIds = [...new Set([
        source.profileId,
        destinationProfileId,
      ])];
      const candidates = {
        [source.profileId]: sourceCandidate,
        [destinationProfileId]: destinationCandidate,
      };
      const saved = await this.api.saveDeckProfiles(
        source.deviceId,
        profileIds.map((profileId) => ({
          profileId,
          profile: candidates[profileId],
        })),
      );

      for (const [profileId, profile] of Object.entries(saved)) {
        this.devices[source.deviceId].profiles[profileId] = profile;
      }

      this.selectedKey = destinationIndex;
      this.renderAll();
      this.focusKey(destinationIndex);
      this.runtime.scheduleSync(source.deviceId);
      this.setSyncStatus('Key moved.', 'ready');
    } catch (error) {
      this.setSyncStatus(`Could not move key: ${error.message}`, 'error');
    }
  }

  updateProfile(mutate, render = true, pageScope = false) {
    const profile = this.selectedProfile();

    if (!profile) {
      return;
    }

    mutate(pageScope ? profile.pages[this.selectedPage] : profile);
    this.persistProfile(
      this.selectedDeviceId,
      this.selectedProfileId(),
    );

    if (render) {
      this.renderAll();
    }

    this.runtime.scheduleSync(this.selectedDeviceId);
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
      !key.action &&
      !key.liveState
    ) {
      page.keys = page.keys.filter((entry) => entry !== key);
    }

    this.persistProfile(
      this.selectedDeviceId,
      this.selectedProfileId(),
    );
    this.renderAll();
    this.runtime.scheduleSync(this.selectedDeviceId);
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

  saveLiveConfigFromEditor() {
    this.updateSelectedKey((key) => {
      if (key.liveState?.provider === 'toggle') {
        const label = this.liveOnLabel.value.trim().slice(0, MAX_KEY_LABEL_LENGTH);
        key.liveState.on = {
          ...(label ? { label } : {}),
          color: this.liveOnColor.value,
          labelColor: this.liveOnLabelColor.value,
          ...(key.liveState.on.image ? { image: key.liveState.on.image } : {}),
        };
      } else if (key.liveState?.provider === 'clock') {
        key.liveState.hour12 = this.liveClockFormat.value === '12';
      }
    });
    this.runtime.refreshLiveStates(this.selectedDeviceId);
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

  async persistProfile(deviceId, profileId = this.selectedProfileId(deviceId)) {
    const profile = this.profileFor(deviceId, profileId);

    if (!profile || !profileId) {
      return;
    }

    try {
      this.devices[deviceId].profiles[profileId] =
        await this.api.saveDeck(deviceId, profileId, profile);
    } catch (error) {
      this.setSyncStatus(`Could not save the deck: ${error.message}`, 'error');
    }
  }

  async importProfile() {
    if (!this.selectedDeviceId) {
      return;
    }

    try {
      const { device } = await this.api.importDeck(this.selectedDeviceId);

      if (!device) {
        return;
      }

      this.devices[this.selectedDeviceId] = device;
      this.runtime.clearLiveRuntime(this.selectedDeviceId);
      this.selectedPage = this.selectedProfile().activePage;
      this.selectedKey = null;
      this.renderAll();
      this.runtime.scheduleSync(this.selectedDeviceId, 0);
      this.setSyncStatus('Profile imported and selected.', 'ready');
    } catch (error) {
      this.setSyncStatus(`Import failed: ${error.message}`, 'error');
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

  setProfileMatchStatus(message, state) {
    this.profileMatchStatus.textContent = message;
    this.profileMatchStatus.dataset.state = state;
  }

  setPageMatchStatus(message, state) {
    this.pageMatchStatus.textContent = message;
    this.pageMatchStatus.dataset.state = state;
  }

  renderSyncStatus() {
    if (this.storageErrors.length > 0) {
      this.setSyncStatus(
        `Deck storage contains ${this.storageErrors.length} preserved corrupt ` +
          `entr${this.storageErrors.length === 1 ? 'y' : 'ies'}. ` +
          'Restore a backup or repair decks.json before removing data.',
        'error',
      );
      return;
    }

    if (!this.selectedDeviceId) {
      this.setSyncStatus('', 'idle');
      return;
    }

    if (!this.runtime.hasSession(this.selectedDeviceId)) {
      this.setSyncStatus(
        'Device offline — changes sync automatically on its next connection.',
        'idle',
      );
      return;
    }

    const session = this.runtime.sessionFor(this.selectedDeviceId);
    const hasLiveState = this.selectedProfile()?.pages.some((page) =>
      page.keys.some((key) => Boolean(key.liveState)),
    );

    if (hasLiveState && !session.hello?.features?.includes('key-update')) {
      this.setSyncStatus(
        'Base deck synced; connected firmware does not support live key state. Reflash to enable it.',
        'idle',
      );
    }
  }

  renderAll() {
    this.renderDevicePicker();
    this.renderProfiles();
    this.renderFocusRules();
    this.renderPages();
    this.renderGrid();
    this.renderKeyEditor();
    this.renderSyncStatus();
  }

  setManualConnectionHidden(hidden) {
    this.connectPanel.dataset.hidden = String(hidden);
    this.connectPanel.inert = hidden;
    this.connectPanel.setAttribute('aria-hidden', String(hidden));
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
      this.setManualConnectionHidden(false);
      return;
    }

    if (!deviceIds.includes(this.selectedDeviceId)) {
      this.selectedDeviceId = deviceIds[0];
    }

    this.deviceSelect.value = this.selectedDeviceId;

    const device = this.selectedDevice();
    this.deviceName.value = device.name;
    const connected = this.runtime.hasSession(this.selectedDeviceId);
    this.deviceStatus.textContent = connected
      ? 'Connected'
      : 'Offline';
    this.deviceStatus.dataset.state = connected ? 'ready' : 'idle';
    this.setManualConnectionHidden(connected);
  }

  renderProfiles() {
    const device = this.selectedDevice();
    this.profileTabs.replaceChildren();

    if (!device) {
      return;
    }

    for (const [profileId, profile] of Object.entries(device.profiles)) {
      const tab = this.document.createElement('button');
      tab.type = 'button';
      tab.className = 'deck-profile-tab';
      tab.textContent =
        `${profile.name}${profileId === device.defaultProfileId ? ' · Default' : ''}`;
      tab.dataset.active = String(profileId === device.activeProfileId);
      tab.setAttribute('role', 'tab');
      tab.setAttribute(
        'aria-selected',
        String(profileId === device.activeProfileId),
      );
      tab.addEventListener('click', () => {
        if (profileId !== device.activeProfileId) {
          this.runProfileOperation({ type: 'select', profileId });
        }
      });
      tab.addEventListener('dragover', (event) => {
        if (this.isKeyDrag(event) && profileId !== device.activeProfileId) {
          event.preventDefault();
        }
      });
      tab.addEventListener('dragenter', (event) => {
        if (this.isKeyDrag(event) && profileId !== device.activeProfileId) {
          this.runProfileOperation({ type: 'select', profileId });
        }
      });
      this.profileTabs.append(tab);
    }

    const profileCount = Object.keys(device.profiles).length;
    this.profileCreate.disabled = profileCount >= MAX_NAMED_PROFILES;
    this.profileDuplicate.disabled = profileCount >= MAX_NAMED_PROFILES;
    this.profileRename.disabled = false;
    this.profileDelete.disabled = profileCount <= 1;
  }

  renderFocusRules() {
    const device = this.selectedDevice();
    const profileId = this.selectedProfileId();
    const profile = this.selectedProfile();
    const page = profile?.pages[this.selectedPage];
    const platform = this.focusStatus?.platform;
    const profileRule = platform ? profile?.appMatches?.[platform] : null;
    const pageRule = platform ? page?.appMatches?.[platform] : null;
    const hasProfile = Boolean(device && profileId && profile);
    const hasPage = Boolean(hasProfile && page);

    this.profileDefault.disabled =
      !hasProfile || profileId === device.defaultProfileId;
    this.profileDefault.textContent =
      hasProfile && profileId === device.defaultProfileId
        ? 'Default profile'
        : 'Make profile default';
    this.profileMatchFocused.disabled =
      !hasProfile ||
      !this.focusStatus?.supported ||
      this.focusStatus.state !== 'watching' ||
      !this.focusSnapshot;
    this.profileMatchSave.disabled = !hasProfile || !platform;
    this.profileMatchClear.disabled = !profileRule;
    this.pageDefault.disabled =
      !hasPage || this.selectedPage === profile.defaultPage;
    this.pageDefault.textContent =
      hasPage && this.selectedPage === profile.defaultPage
        ? 'Default page'
        : 'Make page default';
    this.pageMatchFocused.disabled =
      !hasPage ||
      !this.focusStatus?.supported ||
      this.focusStatus.state !== 'watching' ||
      !this.focusSnapshot;
    this.pageMatchSave.disabled = !hasPage || !platform;
    this.pageMatchClear.disabled = !pageRule;

    if (this.document.activeElement !== this.profileMatchInput) {
      this.profileMatchInput.value = appMatchText(platform, profileRule);
    }

    if (this.document.activeElement !== this.pageMatchInput) {
      this.pageMatchInput.value = appMatchText(platform, pageRule);
    }

    this.profileMatchInput.disabled = !hasProfile || !platform;
    this.pageMatchInput.disabled = !hasPage || !platform;

    if (platform === 'win32') {
      this.profileMatchInput.placeholder = 'obs64.exe or folder/obs64.exe';
      this.pageMatchInput.placeholder = 'obs64.exe or folder/obs64.exe';
    } else if (platform === 'darwin') {
      this.profileMatchInput.placeholder =
        'com.vendor.app or process:App Name';
      this.pageMatchInput.placeholder =
        'com.vendor.app or process:App Name';
    } else if (platform === 'linux') {
      this.profileMatchInput.placeholder =
        'class:obs or process:obs';
      this.pageMatchInput.placeholder =
        'class:obs or process:obs';
    } else {
      this.profileMatchInput.placeholder = 'Focused app unavailable';
      this.pageMatchInput.placeholder = 'Focused app unavailable';
    }

    if (this.focusStatus?.reason) {
      const state = this.focusStatus.state === 'error' ? 'error' : 'idle';
      this.setProfileMatchStatus(this.focusStatus.reason, state);
      this.setPageMatchStatus(this.focusStatus.reason, state);
      return;
    }

    if (this.focusSnapshot) {
      try {
        const focused = preferredRuleForSnapshot(this.focusSnapshot);
        const message = `Focused app: ${focused.value}`;
        this.setProfileMatchStatus(message, 'ready');
        this.setPageMatchStatus(message, 'ready');
      } catch {
        const message = 'The focused app has no supported stable identity.';
        this.setProfileMatchStatus(message, 'idle');
        this.setPageMatchStatus(message, 'idle');
      }
      return;
    }

    const message =
      'Focus another app, then return and choose “Use focused app”.';
    this.setProfileMatchStatus(message, 'idle');
    this.setPageMatchStatus(message, 'idle');
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
      tab.textContent =
        `${page.name}${index === profile.defaultPage ? ' · Default' : ''}`;
      tab.dataset.active = String(index === this.selectedPage);
      tab.setAttribute('role', 'tab');
      tab.setAttribute(
        'aria-selected',
        String(index === this.selectedPage),
      );
      tab.addEventListener('click', () => {
        this.runtime.switchDevicePage(
          this.selectedDeviceId,
          index,
          this.selectedProfileId(),
        ).catch((error) => {
          this.setSyncStatus(`Could not select the page: ${error.message}`, 'error');
        });
      });
      tab.addEventListener('dragover', (event) => {
        if (this.isKeyDrag(event) && index !== this.selectedPage) {
          event.preventDefault();
        }
      });
      tab.addEventListener('dragenter', (event) => {
        if (this.isKeyDrag(event) && index !== this.selectedPage) {
          this.selectedPage = index;
          this.selectedKey = null;
          this.renderAll();
        }
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
    const profileId = this.selectedProfileId();
    this.grid.replaceChildren();

    if (!profile) {
      return;
    }

    const page = profile.pages[this.selectedPage];
    this.grid.style.setProperty('--deck-cols', String(page.cols));
    this.grid.style.setProperty('--deck-rows', String(page.rows));

    for (let index = 0; index < page.rows * page.cols; index++) {
      const baseKey = page.keys.find((entry) => entry.index === index);
      const key = mergeKeyOverlay(
        baseKey,
        baseKey
          ? this.runtime.liveOverlayFor(
              this.selectedDeviceId,
              profileId,
              this.selectedPage,
              baseKey,
            )
          : null,
      );
      const cell = this.document.createElement('button');
      cell.type = 'button';
      cell.className = 'deck-key';
      cell.dataset.selected = String(index === this.selectedKey);
      cell.dataset.keyIndex = String(index);
      cell.setAttribute(
        'aria-label',
        `${key.label || `Key ${index + 1}`}${baseKey ? ', configured' : ', empty'}`,
      );
      cell.title = baseKey
        ? 'Click to edit. Drag to move or swap. Ctrl/Cmd+C or X to copy or cut.'
        : 'Click to edit. Drop or press Ctrl/Cmd+V to paste.';
      cell.draggable = Boolean(baseKey);

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
        !baseKey ||
          (!key.label && !key.color && !key.image && !key.action && !baseKey.liveState),
      );

      if (key?.action?.type === 'page') {
        cell.dataset.badge = '⇒';
      } else if (key?.action?.type === 'profile') {
        cell.dataset.badge = '⇥';
      }

      cell.addEventListener('click', () => {
        this.selectedKey = index;
        this.renderAll();
        this.focusKey(index);
      });
      cell.addEventListener('focus', () => {
        this.selectedKey = index;
      });
      cell.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.selectedKey = index;
        this.renderAll();
        this.focusKey(index);
      });
      cell.addEventListener('dragstart', (event) => {
        if (!baseKey) {
          event.preventDefault();
          return;
        }

        this.dragSource = {
          deviceId: this.selectedDeviceId,
          profileId: this.selectedProfileId(),
          page: this.selectedPage,
          index,
        };
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(
          KEY_DRAG_TYPE,
          JSON.stringify(this.dragSource),
        );
      });
      cell.addEventListener('dragend', () => {
        this.dragSource = null;
      });
      cell.addEventListener('dragover', (event) => {
        if (this.isKeyDrag(event)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }
      });
      cell.addEventListener('drop', (event) => {
        event.preventDefault();

        if (!this.dragSource) {
          try {
            this.dragSource = JSON.parse(
              event.dataTransfer.getData(KEY_DRAG_TYPE),
            );
          } catch {
            return;
          }
        }

        this.dropKey(index);
        this.dragSource = null;
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
    const live = key.liveState || null;
    this.liveProvider.value = live?.provider || '';
    this.liveToggleFields.hidden = live?.provider !== 'toggle';
    this.liveClockField.hidden = live?.provider !== 'clock';
    this.liveOnLabel.value = live?.provider === 'toggle'
      ? live.on.label || ''
      : '';
    this.liveOnColor.value = live?.provider === 'toggle'
      ? live.on.color || '#2f8f5b'
      : '#2f8f5b';
    this.liveOnLabelColor.value = live?.provider === 'toggle'
      ? live.on.labelColor || '#ffffff'
      : '#ffffff';
    this.liveOnImageClear.disabled =
      live?.provider !== 'toggle' || !live.on.image;
    this.liveClockFormat.value =
      live?.provider === 'clock' && live.hour12 ? '12' : '24';
    const session = this.runtime.sessionFor(this.selectedDeviceId);
    this.liveStatus.textContent = live
      ? session && !session.hello?.features?.includes('key-update')
        ? 'Connected firmware does not support live state. Reflash this board to enable it.'
        : live.provider === 'toggle'
          ? 'Local toggle changes only after its complete action succeeds.'
          : 'Live appearance is ephemeral and never changes the saved base key.'
      : '';

    const action = key.action || null;
    this.actionEditor.render({
      action,
      context:
        `${this.selectedDeviceId}:${this.selectedProfileId()}:` +
        `${this.selectedPage}:${this.selectedKey}`,
      pages: profile.pages,
      profiles: Object.entries(this.selectedDevice().profiles).map(
        ([id, entry]) => ({ id, name: entry.name }),
      ),
    });

    this.keyTest.disabled = !action;
    const configured = Boolean(this.selectedKeyData());
    this.keyCopy.disabled = !configured;
    this.keyCut.disabled = !configured;
    this.keyPaste.disabled = !this.clipboard;
  }
}

module.exports = { DeckController, removeProfilePage };
