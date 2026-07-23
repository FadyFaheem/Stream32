const { sanitizeLogText } = require('./diagnostic-log');
const { providerNames } = require('./dynamic-state');

function summarizeDecks(decks) {
  const devices = Object.values(decks?.devices || {});
  const profiles = devices.flatMap((device) =>
    device.profiles ? Object.values(device.profiles) : [device],
  );
  let pages = 0;
  let keys = 0;
  const appMatches = { win32: 0, darwin: 0, linux: 0 };

  for (const profile of profiles) {
    pages += profile.pages.length;

    for (const platform of Object.keys(appMatches)) {
      if (profile.appMatches?.[platform]) {
        appMatches[platform]++;
      }
    }

    for (const page of profile.pages) {
      keys += page.keys.length;
    }
  }

  return {
    devices: devices.length,
    profiles: profiles.length,
    defaultProfiles: devices.filter(
      (device) => Boolean(device.profiles?.[device.defaultProfileId]),
    ).length,
    appMatches,
    pages,
    keys,
  };
}

function createDiagnostics({
  arch = process.arch,
  createdAt = new Date().toISOString(),
  decks,
  homeDirectory,
  platform = process.platform,
  pluginCatalog,
  settings,
  userDataDirectory,
  version,
}) {
  const sanitize = (value) =>
    sanitizeLogText(value, { homeDirectory, userDataDirectory });
  const plugins = (pluginCatalog?.plugins || []).map((plugin) => ({
    id: plugin.id,
    version: plugin.version,
  }));
  const pluginErrors = (pluginCatalog?.errors || []).map((error) => ({
    file: sanitize(error.file),
    message: sanitize(error.message),
  }));

  return {
    stream32Diagnostics: 1,
    createdAt,
    application: {
      version,
      platform,
      arch,
    },
    display: {
      brightnessPercent: Number.isSafeInteger(
        settings?.displayBrightnessPercent,
      )
        ? settings.displayBrightnessPercent
        : 100,
      idleTimeoutMinutes: Number.isSafeInteger(
        settings?.displayIdleTimeoutMinutes,
      )
        ? settings.displayIdleTimeoutMinutes
        : 10,
      sleepWhenLocked:
        typeof settings?.sleepDisplaysWhenLocked === 'boolean'
          ? settings.sleepDisplaysWhenLocked
          : true,
    },
    decks: summarizeDecks(decks),
    liveStateProviders: providerNames(decks),
    plugins: {
      installed: plugins,
      errors: pluginErrors,
    },
  };
}

module.exports = {
  createDiagnostics,
  summarizeDecks,
};
