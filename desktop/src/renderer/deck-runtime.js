const {
  ActionSequenceCancelledError,
  runActionSequence,
} = require('./action-sequence');
const { CompanionSurfaces } = require('./companion-surface');
const {
  focusedAppTitle,
  formatClock,
  millisecondsUntilNextMinute,
} = require('../dynamic-state');
const { ProfileSwitcher } = require('./profile-switcher');
const {
  encodeCleanMessage,
  encodeDisplayBlankMessage,
  encodeImageChunks,
  encodeKeyUpdateMessage,
  encodeLayoutMessage,
  encodePageMessage,
  layoutLineLimitFor,
  validateCleanMessage,
  validateImageAck,
  validateKeyUpdateAck,
  validateLayoutAck,
  validatePageMessage,
  validatePressMessage,
} = require('./protocol');

const ACK_TIMEOUT_MS = 5000;
const SYNC_DEBOUNCE_MS = 600;
const LIVE_UPDATE_DEBOUNCE_MS = 100;
const LIVE_LEASE_REFRESH_MS = 10000;

function gridKey(page) {
  return `${page.rows}x${page.cols}`;
}

// Sync the visible page first so a cold deck becomes usable in seconds
// instead of only after every page has streamed its artwork.
function syncOrder(pageCount, activePage) {
  const order = [activePage];

  for (let index = 0; index < pageCount; index++) {
    if (index !== activePage) {
      order.push(index);
    }
  }

  return order;
}

class DeckRuntime {
  constructor({
    api,
    document,
    getDevices,
    getProfile,
    getSelectedProfileId,
    setDevice,
    persistProfile,
    renderPageImages,
    limitsFor,
    resolveProfileForSnapshot,
    resolvePageForSnapshot,
    getFocusStatus,
    getFocusSnapshot,
    onDeviceRegistered,
    onSelectedPage,
    onRenderAll,
    onRenderSelectedLive,
    onStatus,
    onProfileStatus,
    onRenderSyncStatus,
  }) {
    this.api = api;
    this.getDevices = getDevices;
    this.getProfile = getProfile;
    this.getSelectedProfileId = getSelectedProfileId;
    this.setDevice = setDevice;
    this.persistProfile = persistProfile;
    this.renderPageImages = renderPageImages;
    this.limitsFor = limitsFor;
    this.getFocusStatus = getFocusStatus;
    this.getFocusSnapshot = getFocusSnapshot;
    this.onDeviceRegistered = onDeviceRegistered;
    this.onSelectedPage = onSelectedPage;
    this.onRenderAll = onRenderAll;
    this.onRenderSelectedLive = onRenderSelectedLive;
    this.onStatus = onStatus;
    this.onRenderSyncStatus = onRenderSyncStatus;

    this.sessions = new Map();
    this.pending = new Map();
    this.syncTimers = new Map();
    this.syncRunning = new Map();
    this.multiRuns = new Set();
    this.cleaning = new Set();
    this.liveValues = new Map();
    this.liveQueues = new Map();
    this.liveTimers = new Map();
    this.liveRunning = new Set();
    this.clockTimer = null;
    this.liveLeaseTimer = null;
    this.companion = new CompanionSurfaces({
      api,
      document,
      runtime: this,
      onStatus,
    });
    this.profileSwitcher = new ProfileSwitcher({
      api,
      getDevices,
      getProfile,
      resolveProfile: resolveProfileForSnapshot,
      resolvePage: resolvePageForSnapshot,
      getFocusStatus,
      setDevice,
      scheduleSync: (deviceId, delay) => this.scheduleSync(deviceId, delay),
      sendPage: (deviceId, profileId, page) =>
        this.sendFocusedPage(deviceId, profileId, page),
      onSelectedPage,
      onRender: onRenderAll,
      onStatus: onProfileStatus,
    });
  }

  hasSession(deviceId) {
    return this.sessions.has(deviceId);
  }

  // While Companion drives a board it owns the whole surface: local profile
  // sync, live state, focused-app switching, and key actions all stand down.
  companionEnabled(deviceId) {
    return this.getDevices()[deviceId]?.companion?.enabled === true;
  }

  async setCompanionSurface(deviceId, companion) {
    const device = await this.api.setDeckCompanion(deviceId, companion);
    this.setDevice(deviceId, device);
    await this.companion.detach(deviceId);
    const session = this.sessions.get(deviceId);

    if (!session) {
      this.onRenderAll();
      return device;
    }

    if (device.companion.enabled) {
      this.clearLiveRuntime(deviceId);
      await this.companion.attach(deviceId, session);
    } else {
      this.scheduleSync(deviceId, 0);
    }

    this.onRenderAll();
    return device;
  }

  sessionFor(deviceId) {
    return this.sessions.get(deviceId);
  }

  queueAutoSwitch(snapshot) {
    return this.profileSwitcher.enqueue(snapshot);
  }

  liveKey(deviceId, profileId, page, index) {
    return `${deviceId}:${profileId}:${page}:${index}`;
  }

  clearLiveRuntime(deviceId) {
    const prefix = `${deviceId}:`;

    for (const key of [...this.liveValues.keys()]) {
      if (key.startsWith(prefix)) {
        this.liveValues.delete(key);
      }
    }

    this.liveQueues.delete(deviceId);
    clearTimeout(this.liveTimers.get(deviceId));
    this.liveTimers.delete(deviceId);
  }

  liveOverlayFor(deviceId, profileId, page, key, now = new Date()) {
    const config = key.liveState;

    if (!config) {
      return null;
    }

    switch (config.provider) {
      case 'toggle': {
        const enabled = this.liveValues.get(
          this.liveKey(deviceId, profileId, page, key.index),
        ) === true;
        return enabled
          ? { ...config.on, state: 'on' }
          : { state: 'off' };
      }
      case 'clock':
        return {
          label: formatClock(now, config.hour12),
          state: 'unknown',
        };
      case 'focused-app': {
        const label = this.getFocusStatus()?.state === 'watching'
          ? focusedAppTitle(this.getFocusSnapshot())
          : '';
        return {
          ...(label ? { label } : {}),
          state: 'unknown',
        };
      }
      default:
        return null;
    }
  }

  refreshLiveStates(deviceId = null) {
    const ids = deviceId ? [deviceId] : Object.keys(this.getDevices());

    for (const currentDeviceId of ids) {
      const profileId = this.getSelectedProfileId(currentDeviceId);
      const profile = this.getProfile(currentDeviceId, profileId);

      if (!profile || !profileId) {
        continue;
      }

      const configured = new Set();

      for (const [pageIndex, page] of profile.pages.entries()) {
        for (const key of page.keys) {
          if (!key.liveState) {
            continue;
          }

          const id = this.liveKey(
            currentDeviceId,
            profileId,
            pageIndex,
            key.index,
          );
          configured.add(id);
          this.queueLiveUpdate(currentDeviceId, {
            profileId,
            page: pageIndex,
            index: key.index,
            overlay: this.liveOverlayFor(
              currentDeviceId,
              profileId,
              pageIndex,
              key,
            ),
          });
        }
      }

      const prefix = `${currentDeviceId}:${profileId}:`;

      for (const key of [...this.liveValues.keys()]) {
        if (key.startsWith(prefix) && !configured.has(key)) {
          this.liveValues.delete(key);
        }
      }
    }
  }

  queueLiveUpdate(deviceId, update) {
    if (
      !deviceId ||
      !this.sessions.has(deviceId) ||
      this.companionEnabled(deviceId)
    ) {
      return;
    }

    let queue = this.liveQueues.get(deviceId);

    if (!queue) {
      queue = new Map();
      this.liveQueues.set(deviceId, queue);
    }

    queue.set(`${update.page}:${update.index}`, update);
    clearTimeout(this.liveTimers.get(deviceId));
    this.liveTimers.set(
      deviceId,
      setTimeout(() => {
        this.liveTimers.delete(deviceId);
        this.flushLiveUpdates(deviceId);
      }, LIVE_UPDATE_DEBOUNCE_MS),
    );
  }

  async flushLiveUpdates(deviceId) {
    const session = this.sessions.get(deviceId);

    if (!session || !session.hello?.features?.includes('key-update')) {
      this.liveQueues.delete(deviceId);
      this.onRenderSyncStatus();
      return;
    }

    if (
      this.syncRunning.has(deviceId) ||
      this.pending.has(deviceId) ||
      this.liveRunning.has(deviceId)
    ) {
      const first = this.liveQueues.get(deviceId)?.values().next().value;

      if (first) {
        this.queueLiveUpdate(deviceId, first);
      }
      return;
    }

    this.liveRunning.add(deviceId);

    try {
      const updates = [...(this.liveQueues.get(deviceId)?.values() || [])];
      this.liveQueues.delete(deviceId);

      for (const update of updates) {
        if (
          this.sessions.get(deviceId) !== session ||
          this.getSelectedProfileId(deviceId) !== update.profileId
        ) {
          continue;
        }

        try {
          await this.sendLiveUpdate(deviceId, session, update);
        } catch (error) {
          this.onStatus(`Live state failed: ${error.message}`, 'error');
          break;
        }
      }
    } finally {
      this.liveRunning.delete(deviceId);

      const queued = this.liveQueues.get(deviceId)?.values().next().value;

      if (queued && this.sessions.get(deviceId) === session) {
        this.queueLiveUpdate(deviceId, queued);
      }
    }
  }

  async sendLiveUpdate(deviceId, session, update) {
    const profile = this.getProfile(deviceId, update.profileId);
    const page = profile?.pages[update.page];

    if (!page || update.index >= page.rows * page.cols) {
      return;
    }

    if (!update.overlay) {
      validateKeyUpdateAck(await this.sendWithReply(
        deviceId,
        session,
        encodeKeyUpdateMessage({
          page: update.page,
          index: update.index,
          clear: true,
        }),
        {
          type: 'key-update-ack',
          identity: { page: update.page, index: update.index },
          errorCodes: ['display-busy', 'key-update-invalid', 'unknown-type'],
        },
      ));
      return;
    }

    let render = null;
    const keyPx = profile.keyPx[gridKey(page)];

    if (update.overlay.image && keyPx) {
      const renders = await this.renderPageImages(
        { keys: [{ index: update.index, ...update.overlay }] },
        keyPx,
      );
      render = renders.get(update.index);
    }

    const ack = validateKeyUpdateAck(await this.sendWithReply(
      deviceId,
      session,
      encodeKeyUpdateMessage({
        page: update.page,
        index: update.index,
        label: update.overlay.label,
        color: update.overlay.color,
        labelColor: update.overlay.labelColor,
        state: update.overlay.state,
        ...(render ? { imageCrc: render.crc } : {}),
      }),
      {
        type: 'key-update-ack',
        identity: { page: update.page, index: update.index },
        errorCodes: ['display-busy', 'key-update-invalid', 'unknown-type'],
      },
    ));

    if (ack.page !== update.page || ack.index !== update.index) {
      throw new Error('The device acknowledged the wrong live key.');
    }

    if (ack.needImage) {
      if (!render) {
        throw new Error('The device requested unavailable live artwork.');
      }

      await this.streamImage(
        deviceId,
        session,
        update.page,
        update.index,
        keyPx,
        render,
        'ephemeral',
      );
    }
  }

  startLiveTimers() {
    this.companion.start();
    this.scheduleClockTick();
    clearInterval(this.liveLeaseTimer);
    this.liveLeaseTimer = setInterval(
      () => this.refreshLiveStates(),
      LIVE_LEASE_REFRESH_MS,
    );
    this.liveLeaseTimer?.unref?.();
  }

  scheduleClockTick() {
    clearTimeout(this.clockTimer);
    this.clockTimer = setTimeout(() => {
      this.refreshLiveStates();
      this.scheduleClockTick();
    }, millisecondsUntilNextMinute());
    this.clockTimer?.unref?.();
  }

  async attachSession(session, board) {
    const { deviceId, boardId } = session.hello;
    session.committedProfileId = null;
    session.profileInputBlocked = true;
    session.profileSyncInProgress = false;
    this.sessions.set(deviceId, session);

    if (!this.getDevices()[deviceId]) {
      try {
        this.setDevice(
          deviceId,
          await this.api.registerDeck(
            deviceId,
            boardId,
            `${board?.name || 'Stream32'} deck`,
          ),
        );
      } catch (error) {
        this.onStatus(
          `Could not register the device: ${error.message}`,
          'error',
        );
        return;
      }

      this.onDeviceRegistered(deviceId);
    }

    this.onRenderAll();

    if (this.companionEnabled(deviceId)) {
      await this.companion.attach(deviceId, session);
      return;
    }

    this.scheduleSync(deviceId, 0);
  }

  detachSession(session) {
    const deviceId = session.hello?.deviceId;

    if (deviceId && this.sessions.get(deviceId) === session) {
      this.sessions.delete(deviceId);
      this.companion.detach(deviceId);
      this.rejectPending(deviceId, new Error('The device disconnected.'));
      clearTimeout(this.syncTimers.get(deviceId));
      this.syncTimers.delete(deviceId);
      this.cleaning.delete(deviceId);
      this.clearLiveRuntime(deviceId);
      this.onRenderAll();
    }
  }

  handleDeviceMessage(session, message) {
    const deviceId = session.hello?.deviceId;

    if (!deviceId) {
      return;
    }

    const pending = this.pending.get(deviceId);

    if (pending?.matches(message)) {
      this.pending.delete(deviceId);
      pending.resolve(message);
      return;
    }

    if (pending?.matchesError(message)) {
      this.pending.delete(deviceId);
      pending.reject(
        new Error(
          message.code === 'unknown-type'
            ? 'The board firmware is too old for deck layouts. ' +
              'Reflash it from the Flash board section.'
            : `Device error: ${message.code || 'unknown'}`,
        ),
      );
      return;
    }

    if (message.type === 'press') {
      this.handlePress(deviceId, session, message);
    } else if (message.type === 'page') {
      this.handleDevicePage(deviceId, session, message);
    } else if (message.type === 'clean') {
      this.applyCleanState(deviceId, validateCleanMessage(message).active);
    }
  }

  awaitReply(
    deviceId,
    { type, identity = {}, errorCodes = [] },
    timeoutMs = ACK_TIMEOUT_MS,
  ) {
    if (this.pending.has(deviceId)) {
      throw new Error('Another device acknowledgement is already pending.');
    }

    return new Promise((resolve, reject) => {
      const pending = {
        matches: (message) =>
          message.type === type &&
          Object.entries(identity).every(
            ([field, value]) => message[field] === value,
          ),
        matchesError: (message) =>
          message.type === 'error' && errorCodes.includes(message.code),
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        if (this.pending.get(deviceId) !== pending) {
          return;
        }

        this.pending.delete(deviceId);
        reject(new Error('The device did not acknowledge in time.'));
      }, timeoutMs);

      this.pending.set(deviceId, pending);
    });
  }

  async sendWithReply(deviceId, session, bytes, expected) {
    const reply = this.awaitReply(deviceId, expected);

    try {
      await session.send(bytes);
    } catch (error) {
      this.rejectPending(deviceId, error);
      await reply.catch(() => {});
      throw error;
    }

    return reply;
  }

  rejectPending(deviceId, error) {
    const pending = this.pending.get(deviceId);

    if (pending) {
      this.pending.delete(deviceId);
      pending.reject(error);
    }
  }

  handlePress(deviceId, session, message) {
    const press = validatePressMessage(message);

    if (this.companionEnabled(deviceId)) {
      this.companion.handlePress(deviceId, press);
      return;
    }

    if (
      press.phase !== 'down' ||
      session.profileInputBlocked ||
      !session.committedProfileId ||
      this.getSelectedProfileId(deviceId) !== session.committedProfileId
    ) {
      return;
    }

    const profileId = session.committedProfileId;
    const profile = this.getProfile(deviceId, profileId);
    const key = profile?.pages[press.page]?.keys.find(
      (entry) => entry.index === press.index,
    );

    if (key?.action) {
      this.runKeyAction(deviceId, key.action, {
        profileId,
        page: press.page,
        index: press.index,
      });
    }
  }

  handleDevicePage(deviceId, session, message) {
    const { index } = validatePageMessage(message);
    const profileId = session.committedProfileId;

    if (
      session.profileInputBlocked ||
      !profileId ||
      this.getSelectedProfileId(deviceId) !== profileId
    ) {
      return;
    }

    const profile = this.getProfile(deviceId, profileId);

    if (!profile || index >= profile.pages.length) {
      return;
    }

    profile.activePage = index;
    this.persistProfile(deviceId, profileId);
    this.onSelectedPage(deviceId, index);
  }

  async sendFocusedPage(deviceId, profileId, page) {
    const session = this.sessions.get(deviceId);

    if (!session) {
      return;
    }

    if (
      session.profileInputBlocked ||
      session.committedProfileId !== profileId
    ) {
      this.scheduleSync(deviceId, 0);
      return;
    }

    await session.send(encodePageMessage(page));
    this.refreshLiveStates(deviceId);
  }

  async switchDevicePage(
    deviceId,
    page,
    profileId =
      this.sessions.get(deviceId)?.committedProfileId ||
      this.getSelectedProfileId(deviceId),
  ) {
    const profile = this.getProfile(deviceId, profileId);

    if (
      !profileId ||
      !profile ||
      !Number.isInteger(page) ||
      page < 0 ||
      page >= profile.pages.length
    ) {
      throw new RangeError('The target page no longer exists.');
    }

    if (profile.activePage === page) {
      this.onSelectedPage(deviceId, page);
      return false;
    }

    const session = this.sessions.get(deviceId);

    if (
      session &&
      (
        session.profileInputBlocked ||
        session.committedProfileId !== profileId
      )
    ) {
      throw new Error('The device profile is still syncing.');
    }

    await session?.send(encodePageMessage(page));
    profile.activePage = page;
    await this.persistProfile(deviceId, profileId);
    this.onSelectedPage(deviceId, page);
    this.refreshLiveStates(deviceId);
    return true;
  }

  async switchDeviceProfile(deviceId, profileId) {
    const previousProfileId = this.getSelectedProfileId(deviceId);
    const device = await this.api.runProfileOperation(deviceId, {
      type: 'select',
      profileId,
    });
    this.setDevice(deviceId, device);

    if (device.activeProfileId === previousProfileId) {
      return false;
    }

    this.clearLiveRuntime(deviceId);
    const page = this.getProfile(deviceId, device.activeProfileId)?.activePage ?? 0;
    this.onSelectedPage(deviceId, page);
    this.scheduleSync(deviceId, 0);
    return true;
  }

  async blankDeviceDisplay(deviceId) {
    const session = this.sessions.get(deviceId);

    if (!session) {
      throw new Error('The deck is not connected.');
    }

    if (!session.hello?.features?.includes('display-blank')) {
      throw new Error('Sleep requires updated board firmware.');
    }

    await session.send(encodeDisplayBlankMessage());
  }

  // The board is the source of truth: it also reports the five second hold
  // that releases the lock without the desktop.
  applyCleanState(deviceId, active) {
    if (active) {
      this.cleaning.add(deviceId);
    } else {
      this.cleaning.delete(deviceId);
    }

    this.onRenderAll();
  }

  async setCleanMode(deviceId, active) {
    const session = this.sessions.get(deviceId);

    if (!session) {
      throw new Error('The deck is not connected.');
    }

    if (!session.hello?.features?.includes('clean-mode')) {
      throw new Error('Screen cleaning requires updated board firmware.');
    }

    const ack = validateCleanMessage(await this.sendWithReply(
      deviceId,
      session,
      encodeCleanMessage(active),
      {
        type: 'clean-ack',
        identity: { active },
        errorCodes: ['clean-invalid', 'display-busy', 'unknown-type'],
      },
    ));
    this.applyCleanState(deviceId, ack.active);
  }

  async runKeyAction(deviceId, action, origin = {}) {
    try {
      if (action.type === 'page') {
        await this.switchDevicePage(
          deviceId,
          action.page,
          origin.profileId || this.getSelectedProfileId(deviceId),
        );
        this.flipToggleAfterSuccess(deviceId, origin);
        return true;
      }

      if (action.type === 'profile') {
        await this.switchDeviceProfile(deviceId, action.profileId);
        return true;
      }

      if (action.type === 'sleep') {
        await this.blankDeviceDisplay(deviceId);
        this.flipToggleAfterSuccess(deviceId, origin);
        return true;
      }

      if (action.type === 'clean') {
        await this.setCleanMode(deviceId, true);
        return true;
      }

      if (action.type !== 'multi') {
        await this.api.runAction(action);
        this.flipToggleAfterSuccess(deviceId, origin);
        return true;
      }

      const profileId =
        origin.profileId || this.getSelectedProfileId(deviceId);
      const runId =
        `${deviceId}:${profileId}:${origin.page ?? '-'}:${origin.index ?? '-'}`;

      if (this.multiRuns.has(runId)) {
        return false;
      }

      const originatingSession = this.sessions.get(deviceId);
      this.multiRuns.add(runId);

      try {
        await runActionSequence(action.steps, {
          runLeaf: (step) => this.api.runAction(step),
          switchPage: (page) =>
            this.switchDevicePage(deviceId, page, profileId),
          switchProfile: (targetProfileId) =>
            this.switchDeviceProfile(deviceId, targetProfileId),
          blankDisplay: () => this.blankDeviceDisplay(deviceId),
          cleanDisplay: () => this.setCleanMode(deviceId, true),
          isCancelled: () =>
            this.getSelectedProfileId(deviceId) !== profileId ||
            Boolean(
              originatingSession &&
              this.sessions.get(deviceId) !== originatingSession,
            ),
        });
      } finally {
        this.multiRuns.delete(runId);
      }
      this.flipToggleAfterSuccess(deviceId, origin);
      return true;
    } catch (error) {
      if (error instanceof ActionSequenceCancelledError) {
        this.onStatus(error.message, 'idle');
        return false;
      }

      this.onStatus(`Action failed: ${error.message}`, 'error');
      return false;
    }
  }

  flipToggleAfterSuccess(deviceId, origin) {
    const profileId =
      origin.profileId || this.getSelectedProfileId(deviceId);
    const key = this.getProfile(deviceId, profileId)
      ?.pages[origin.page]
      ?.keys.find((entry) => entry.index === origin.index);

    if (key?.liveState?.provider !== 'toggle') {
      return;
    }

    const id = this.liveKey(deviceId, profileId, origin.page, origin.index);
    this.liveValues.set(id, this.liveValues.get(id) !== true);
    this.queueLiveUpdate(deviceId, {
      profileId,
      page: origin.page,
      index: origin.index,
      overlay: this.liveOverlayFor(
        deviceId,
        profileId,
        origin.page,
        key,
      ),
    });
    this.onRenderSelectedLive(deviceId);
  }

  scheduleSync(deviceId, delay = SYNC_DEBOUNCE_MS) {
    if (
      !deviceId ||
      !this.sessions.has(deviceId) ||
      this.companionEnabled(deviceId)
    ) {
      this.onRenderSyncStatus();
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

    if (this.liveRunning.has(deviceId) || this.pending.has(deviceId)) {
      this.scheduleSync(deviceId);
      return;
    }

    const session = this.sessions.get(deviceId);
    const profileId = this.getSelectedProfileId(deviceId);
    const profile = this.getProfile(deviceId, profileId);

    if (!session || !profile || !profileId) {
      return;
    }

    this.syncRunning.set(deviceId, 'running');
    session.profileInputBlocked = true;
    session.profileSyncInProgress = true;
    this.onStatus('Syncing the deck to the device…', 'working');

    const leadPage = profile.activePage;
    let streamedArtwork = false;

    try {
      for (const pageIndex of syncOrder(profile.pages.length, leadPage)) {
        streamedArtwork = await this.syncPage(
          deviceId,
          session,
          profileId,
          profile,
          pageIndex,
          profile.pages[pageIndex],
        ) || streamedArtwork;

        if (this.sessions.get(deviceId) !== session) {
          throw new Error('The device disconnected during profile sync.');
        }

        if (this.getSelectedProfileId(deviceId) !== profileId) {
          this.syncRunning.set(deviceId, 'again');
          return;
        }

        // syncOrder leads with the visible page, so the deck can show it and
        // answer presses while the remaining pages stream in behind it.
        if (session.profileInputBlocked) {
          await session.send(encodePageMessage(leadPage));
          session.committedProfileId = profileId;
          session.profileInputBlocked = false;

          if (profile.pages.length > 1) {
            this.onStatus(
              `Page ${leadPage + 1} is ready. Loading the other pages…`,
              'working',
            );
          }
        }
      }

      // Firmware releases unreferenced artwork when the highest page index
      // arrives, which leading with the visible page can move off the end of
      // the run. Repeat that page only when this sync added artwork.
      if (
        streamedArtwork &&
        profile.pages.length > 1 &&
        leadPage === profile.pages.length - 1
      ) {
        await this.syncPage(
          deviceId,
          session,
          profileId,
          profile,
          leadPage,
          profile.pages[leadPage],
        );
      }

      this.refreshLiveStates(deviceId);
      if (
        profile.pages.some((page) =>
          page.keys.some((key) => Boolean(key.liveState)),
        ) &&
        !session.hello?.features?.includes('key-update')
      ) {
        this.onStatus(
          'Base deck synced; this firmware does not support live key state.',
          'idle',
        );
      } else {
        this.onStatus('Deck synced to the device.', 'ready');
      }
    } catch (error) {
      this.onStatus(error.message, 'error');
    } finally {
      session.profileSyncInProgress = false;
      const runAgain = this.syncRunning.get(deviceId) === 'again';
      this.syncRunning.delete(deviceId);

      if (runAgain) {
        this.scheduleSync(deviceId, 0);
      }
    }
  }

  async syncPage(deviceId, session, profileId, profile, pageIndex, page) {
    let keyPx = profile.keyPx[gridKey(page)];

    if (!keyPx) {
      const ack = await this.sendLayout(
        deviceId,
        session,
        profile,
        pageIndex,
        page,
        new Map(),
      );
      keyPx = ack.keyPx;
      profile.keyPx[gridKey(page)] = keyPx;
      this.persistProfile(deviceId, profileId);
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
      this.persistProfile(deviceId, profileId);
      return this.syncPage(
        deviceId,
        session,
        profileId,
        profile,
        pageIndex,
        page,
      );
    }

    let streamed = false;

    for (const index of ack.needImages) {
      const render = renders.get(index);

      if (render) {
        await this.streamImage(
          deviceId,
          session,
          pageIndex,
          index,
          keyPx,
          render,
        );
        streamed = true;
      }
    }

    return streamed;
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

    return validateLayoutAck(await this.sendWithReply(
      deviceId,
      session,
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
      {
        type: 'layout-ack',
        identity: { page: pageIndex, rows: page.rows, cols: page.cols },
        errorCodes: [
          'display-busy',
          'layout-invalid',
          'layout-too-large',
          'storage-failed',
          'unknown-type',
        ],
      },
    ));
  }

  async streamImage(
    deviceId,
    session,
    pageIndex,
    index,
    keyPx,
    render,
    mode = 'persisted',
  ) {
    const chunks = encodeImageChunks({
      page: pageIndex,
      index,
      width: keyPx,
      height: keyPx,
      pixels: render.pixels,
      mode,
      rleSupported: session.hello?.features?.includes('image-rle') === true,
    });

    for (const [seq, chunk] of chunks.entries()) {
      this.onStatus(
        `Sending key artwork… page ${pageIndex + 1}, key ${index + 1}, ` +
          `${Math.round(((seq + 1) / chunks.length) * 100)}%`,
        'working',
      );

      const ack = validateImageAck(await this.sendWithReply(
        deviceId,
        session,
        chunk,
        {
          type: 'image-ack',
          identity: {
            page: pageIndex,
            index,
            seq,
            mode: mode === 'ephemeral' ? 'ephemeral' : undefined,
          },
          errorCodes: [
            'display-busy',
            'image-crc-mismatch',
            'image-invalid',
            'image-no-memory',
            'image-rle-invalid',
            'image-sequence',
            'image-size-mismatch',
            'storage-failed',
            'unknown-type',
          ],
        },
      ));

      if (
        ack.page !== pageIndex ||
        ack.index !== index ||
        ack.seq !== seq ||
        (mode === 'ephemeral' && ack.mode !== 'ephemeral')
      ) {
        throw new Error('The device acknowledged the wrong image chunk.');
      }
    }
  }
}

module.exports = { DeckRuntime };
