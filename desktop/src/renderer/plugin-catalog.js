function pluginUiState(plugin, offline = false) {
  let state;
  let label;

  if (!plugin.compatible) {
    state = 'incompatible';
    label = `Incompatible · requires Stream32 ${plugin.minimumDesktopVersion}`;
  } else if (plugin.updateAvailable) {
    state = 'update-available';
    label = `Update available · ${plugin.installedVersion} → ${plugin.version}`;
  } else if (plugin.installedVersion) {
    state = 'installed';
    label = `Installed · ${plugin.installedVersion}`;
  } else if (offline) {
    state = 'offline';
    label = 'Offline';
  } else {
    state = 'available';
    label = `Available · ${plugin.version}`;
  }

  if (offline && state !== 'offline') {
    label += ' · Offline';
  }

  return {
    state,
    label,
    installAction: plugin.updateAvailable ? 'update' : 'install',
    installLabel: plugin.updateAvailable ? 'Update' : 'Install',
    installDisabled:
      offline || !plugin.compatible || Boolean(
        plugin.installedVersion && !plugin.updateAvailable,
      ),
    removable: Boolean(plugin.installedVersion),
  };
}

function catalogViewModel(listing) {
  const offline = Boolean(listing.warning);

  return {
    ...listing,
    offline,
    plugins: listing.plugins.map((plugin) => ({
      ...plugin,
      ui: pluginUiState(plugin, offline),
    })),
  };
}

module.exports = {
  catalogViewModel,
  pluginUiState,
};
