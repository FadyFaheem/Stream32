// Pure update-channel rules shared by the main-process updater and its tests.
// Kept free of Node and Electron imports, like semver.js, so the rules can run
// under `node --test`.
const { parseVersion } = require('./semver');

const NIGHTLY_CHANNEL = 'nightly';
const STABLE_CHANNEL = 'stable';
// electron-updater reads a release's channel from the first SemVer prerelease
// identifier of its tag, so channel names must be valid identifiers there.
const PULL_REQUEST_CHANNEL_PATTERN = /^pr[1-9][0-9]{0,6}$/;
const PRERELEASE_TAG_PATTERN = /^v(\d+\.\d+\.\d+-[0-9A-Za-z.-]+)$/;
const MAX_LABEL_LENGTH = 80;

function channelOfVersion(version) {
  try {
    return parseVersion(version).prerelease?.[0] ?? STABLE_CHANNEL;
  } catch {
    return STABLE_CHANNEL;
  }
}

// Pull request channels are developer-only, so leaving developer mode has to
// strand the app on a channel it can no longer choose.
function normalizeChannel(value, developerMode = false) {
  if (value === NIGHTLY_CHANNEL) {
    return NIGHTLY_CHANNEL;
  }

  if (
    developerMode &&
    typeof value === 'string' &&
    PULL_REQUEST_CHANNEL_PATTERN.test(value)
  ) {
    return value;
  }

  return STABLE_CHANNEL;
}

// Stable releases are found through /releases/latest, which skips prereleases
// entirely; every other channel needs the prerelease scan. Leaving a preview
// channel usually means installing an older version, so downgrades are allowed
// only while the running build and the chosen channel disagree.
function resolveChannel(channel, runningVersion) {
  const stable = channel === STABLE_CHANNEL;

  return {
    allowDowngrade: channelOfVersion(runningVersion) !== channel,
    allowPrerelease: !stable,
    channel: stable ? 'latest' : channel,
  };
}

// GitHub lists releases newest first, so the first hit for a channel is the
// build electron-updater would install from it.
function listPullRequestChannels(releases) {
  const channels = new Map();

  for (const release of Array.isArray(releases) ? releases : []) {
    const tag = PRERELEASE_TAG_PATTERN.exec(release?.tag_name ?? '');

    if (!tag || release.draft) {
      continue;
    }

    const version = tag[1];
    const channel = channelOfVersion(version);

    if (
      channels.has(channel) ||
      !PULL_REQUEST_CHANNEL_PATTERN.test(channel)
    ) {
      continue;
    }

    const name = typeof release.name === 'string' ? release.name.trim() : '';

    channels.set(channel, {
      channel,
      label: name ? name.slice(0, MAX_LABEL_LENGTH) : channel,
      version,
    });
  }

  return [...channels.values()];
}

module.exports = {
  NIGHTLY_CHANNEL,
  PULL_REQUEST_CHANNEL_PATTERN,
  STABLE_CHANNEL,
  channelOfVersion,
  listPullRequestChannels,
  normalizeChannel,
  resolveChannel,
};
