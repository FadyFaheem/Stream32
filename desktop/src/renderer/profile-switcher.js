class ProfileSwitcher {
  constructor({
    api,
    getDevices,
    getProfile,
    resolveProfile,
    resolvePage,
    getFocusStatus,
    setDevice,
    scheduleSync,
    sendPage,
    onSelectedPage,
    onRender,
    onStatus,
  }) {
    this.api = api;
    this.getDevices = getDevices;
    this.getProfile = getProfile;
    this.resolveProfile = resolveProfile;
    this.resolvePage = resolvePage;
    this.getFocusStatus = getFocusStatus;
    this.setDevice = setDevice;
    this.scheduleSync = scheduleSync;
    this.sendPage = sendPage;
    this.onSelectedPage = onSelectedPage;
    this.onRender = onRender;
    this.onStatus = onStatus;
    this.latest = null;
    this.revision = 0;
    this.running = null;
    this.unsynced = new Map();
  }

  enqueue(snapshot) {
    if (!snapshot) {
      return Promise.resolve();
    }

    this.latest = snapshot;
    this.revision++;
    this.running ||= this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async drain() {
    while (this.latest !== null) {
      const snapshot = this.latest;
      const revision = this.revision;
      this.latest = null;

      try {
        await this.switchProfiles(
          snapshot,
          () => revision !== this.revision,
        );
      } catch (error) {
        this.onStatus(
          `Automatic profile switch failed: ${error.message}`,
          'error',
        );
      }
    }
  }

  async switchProfiles(snapshot, isStale = () => false) {
    const focusStatus = this.getFocusStatus();

    if (
      !snapshot ||
      snapshot.platform !== focusStatus?.platform ||
      focusStatus.editorFocused
    ) {
      return [];
    }

    const changed = [];

    for (const deviceId of Object.keys(this.getDevices()).sort()) {
      if (isStale()) {
        break;
      }

      const device = this.getDevices()[deviceId];
      const profileId = this.resolveProfile(device, snapshot);
      const profile = this.getProfile(deviceId, profileId);
      const page = this.resolvePage(profile, snapshot);
      const profileChanged = profileId !== device.activeProfileId;
      const pageChanged = page !== profile.activePage;

      if (!profileChanged && !pageChanged) {
        const unsynced = this.unsynced.get(deviceId);

        if (unsynced) {
          this.unsynced.delete(deviceId);
          changed.push(deviceId);

          if (unsynced === 'profile') {
            this.scheduleSync(deviceId, 0);
          } else {
            await this.sendPage(deviceId, profileId, page);
          }

          this.onSelectedPage(deviceId, page);
        }
        continue;
      }

      try {
        const updated = await this.api.runProfileOperation(
          deviceId,
          profileChanged
            ? { type: 'focus-select', profileId, page }
            : { type: 'set-active-page', profileId, page },
        );
        this.setDevice(deviceId, updated);
      } catch (error) {
        this.onStatus(
          `Could not switch ${device.name}: ${error.message}`,
          'error',
        );
        continue;
      }

      if (isStale()) {
        this.unsynced.set(deviceId, profileChanged ? 'profile' : 'page');
        break;
      }

      this.unsynced.delete(deviceId);
      changed.push(deviceId);

      if (profileChanged) {
        this.scheduleSync(deviceId, 0);
      } else {
        await this.sendPage(deviceId, profileId, page);
      }

      this.onSelectedPage(deviceId, page);
    }

    if (changed.length > 0) {
      this.onRender();
    }

    return changed;
  }
}

module.exports = { ProfileSwitcher };
