const {
  ActionSequenceCancelledError,
  runActionSequence,
} = require('./action-sequence');
const {
  focusedAppTitle,
  formatClock,
  millisecondsUntilNextMinute,
} = require('../dynamic-state');
const { ProfileSwitcher } = require('./profile-switcher');
const {
  encodeImageChunks,
  encodeKeyUpdateMessage,
  encodeLayoutMessage,
  encodePageMessage,
  layoutLineLimitFor,
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

class DeckRuntime {
  constructor({
    api,
    getDevices,
    getProfile,
    getSelectedProfileId,
    setDevice,
    persistProfile,
    renderPageImages,
    limitsFor,
    resolveProfileForSnapshot,
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
    this.liveValues = new Map();
    this.liveQueues = new Map();
    this.liveTimers = new Map();
    this.liveRunning = new Set();
    this.clockTimer = null;
    this.liveLeaseTimer = null;
    this.profileSwitcher = new ProfileSwitcher({
      api,
      getDevices,
      getProfile,
      resolveProfile: resolveProfileForSnapshot,
      getFocusStatus,
      setDevice,
      scheduleSync: (deviceId, delay) => this.scheduleSync(deviceId, delay),
      onSelectedPage,
      onRender: onRenderAll,
      onStatus: onProfileStatus,
    });
  }

  hasSession(deviceId) {
    return this.sessions.has(deviceId);
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
    if (!deviceId || !this.sessions.has(deviceId)) {
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
    this.scheduleSync(deviceId, 0);
  }

  detachSession(session) {
    const deviceId = session.hello?.deviceId;

    if (deviceId && this.sessions.get(deviceId) === session) {
      this.sessions.delete(deviceId);
      this.rejectPending(deviceId, new Error('The device disconnected.'));
      clearTimeout(this.syncTimers.get(deviceId));
      this.syncTimers.delete(deviceId);
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

  async switchDevicePage(
    deviceId,
    page,
    profileId =
      this.sessions.get(deviceId)?.committedProfileId ||
      this.getSelectedProfileId(deviceId),
  ) {
    const profile = this.getProfile(deviceId, profileId);

    if (!profileId || !profile || page >= profile.pages.length) {
      throw new RangeError('The target page no longer exists.');
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
    this.persistProfile(deviceId, profileId);
    this.onSelectedPage(deviceId, page);
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
    if (!deviceId || !this.sessions.has(deviceId)) {
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

    try {
      for (const [pageIndex, page] of profile.pages.entries()) {
        await this.syncPage(
          deviceId,
          session,
          profileId,
          profile,
          pageIndex,
          page,
        );
      }

      await session.send(encodePageMessage(profile.activePage));

      if (this.sessions.get(deviceId) !== session) {
        throw new Error('The device disconnected during profile sync.');
      }

      if (this.getSelectedProfileId(deviceId) !== profileId) {
        this.syncRunning.set(deviceId, 'again');
        return;
      }

      session.committedProfileId = profileId;
      session.profileInputBlocked = false;
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
