class ProfileSwitcher {
  constructor({
    api,
    getDevices,
    getProfile,
    resolveProfile,
    getFocusStatus,
    setDevice,
    scheduleSync,
    onSelectedPage,
    onRender,
    onStatus,
  }) {
    this.api = api;
    this.getDevices = getDevices;
    this.getProfile = getProfile;
    this.resolveProfile = resolveProfile;
    this.getFocusStatus = getFocusStatus;
    this.setDevice = setDevice;
    this.scheduleSync = scheduleSync;
    this.onSelectedPage = onSelectedPage;
    this.onRender = onRender;
    this.onStatus = onStatus;
    this.latest = null;
    this.revision = 0;
    this.running = null;
    this.unsynced = new Set();
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

      if (profileId === device.activeProfileId) {
        if (this.unsynced.delete(deviceId)) {
          changed.push(deviceId);
          this.scheduleSync(deviceId, 0);
          this.onSelectedPage(
            deviceId,
            this.getProfile(deviceId, profileId)?.activePage ?? 0,
          );
        }
        continue;
      }

      try {
        const updated = await this.api.runProfileOperation(
          deviceId,
          { type: 'select', profileId },
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
        this.unsynced.add(deviceId);
        break;
      }

      this.unsynced.delete(deviceId);
      changed.push(deviceId);
      this.scheduleSync(deviceId, 0);
      this.onSelectedPage(
        deviceId,
        this.getProfile(deviceId, profileId)?.activePage ?? 0,
      );
    }

    if (changed.length > 0) {
      this.onRender();
    }

    return changed;
  }
}

module.exports = { ProfileSwitcher };
