const PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const RULE_KINDS = {
  win32: new Set(['executable']),
  darwin: new Set(['bundleId', 'processName']),
  linux: new Set(['wmClass', 'processName']),
};
const MAX_APP_IDENTITY_LENGTH = 260;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const WINDOWS_WILDCARD_PATTERN = /[*?[\]]/;
const BUNDLE_ID_PATTERN =
  /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/i;

function requirePlatform(platform) {
  if (!PLATFORMS.has(platform)) {
    throw new TypeError('App match platform is invalid.');
  }

  return platform;
}

function normalizeValue(platform, kind, value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_APP_IDENTITY_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new TypeError('App match value is invalid.');
  }

  let normalized = value.normalize('NFKC').trim();

  if (!normalized || normalized.length > MAX_APP_IDENTITY_LENGTH) {
    throw new TypeError('App match value is invalid.');
  }

  if (platform === 'win32') {
    if (
      kind !== 'executable' ||
      WINDOWS_WILDCARD_PATTERN.test(normalized) ||
      normalized.endsWith('/') ||
      normalized.endsWith('\\')
    ) {
      throw new TypeError('Windows app match must be an executable name or path suffix.');
    }

    normalized = normalized.replaceAll('\\', '/').replace(/\/+/g, '/').toLowerCase();
  } else if (platform === 'darwin' && kind === 'bundleId') {
    if (!BUNDLE_ID_PATTERN.test(normalized)) {
      throw new TypeError('macOS bundle id is invalid.');
    }

    normalized = normalized.toLowerCase();
  } else {
    if (normalized.includes('/') || normalized.includes('\\')) {
      throw new TypeError('App process and class names cannot contain paths.');
    }

    normalized = normalized.toLowerCase();
  }

  return normalized;
}

function validateAppMatch(platform, rule) {
  requirePlatform(platform);

  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new TypeError('App match rule is invalid.');
  }

  if (!RULE_KINDS[platform].has(rule.kind)) {
    throw new TypeError('App match identity kind is invalid for this platform.');
  }

  return {
    kind: rule.kind,
    value: normalizeValue(platform, rule.kind, rule.value),
  };
}

function validateAppMatches(matches = {}) {
  if (!matches || typeof matches !== 'object' || Array.isArray(matches)) {
    throw new TypeError('Profile app matches are invalid.');
  }

  const validated = {};

  for (const [platform, rule] of Object.entries(matches)) {
    validated[requirePlatform(platform)] = validateAppMatch(platform, rule);
  }

  return validated;
}

function validateFocusSnapshot(snapshot) {
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    !Array.isArray(snapshot.identities) ||
    snapshot.identities.length === 0 ||
    snapshot.identities.length > 3
  ) {
    throw new TypeError('Focused app snapshot is invalid.');
  }

  const platform = requirePlatform(snapshot.platform);
  const identities = snapshot.identities.map((identity) =>
    validateAppMatch(platform, identity));

  return {
    platform,
    identities,
    processId: Number.isSafeInteger(snapshot.processId) && snapshot.processId > 0
      ? snapshot.processId
      : null,
  };
}

function appMatchEquals(rule, snapshot) {
  const validatedRule = validateAppMatch(snapshot.platform, rule);
  const identities = validateFocusSnapshot(snapshot).identities;

  for (const identity of identities) {
    if (identity.kind !== validatedRule.kind) {
      continue;
    }

    if (snapshot.platform !== 'win32') {
      if (identity.value === validatedRule.value) {
        return true;
      }
      continue;
    }

    const executable = identity.value;
    const suffix = validatedRule.value;

    if (
      executable === suffix ||
      executable.endsWith(`/${suffix}`)
    ) {
      return true;
    }
  }

  return false;
}

function selectProfileForSnapshot(device, snapshot) {
  if (!device?.profiles || !device.profiles[device.activeProfileId]) {
    throw new TypeError('Device active profile is invalid.');
  }

  for (const profileId of Object.keys(device.profiles).sort()) {
    const rule = device.profiles[profileId].appMatches?.[snapshot.platform];

    if (rule && appMatchEquals(rule, snapshot)) {
      return profileId;
    }
  }

  return device.activeProfileId;
}

function selectPageForSnapshot(profile, snapshot) {
  if (
    !Array.isArray(profile?.pages) ||
    !profile.pages[profile.activePage]
  ) {
    throw new TypeError('Profile active page is invalid.');
  }

  for (const [pageIndex, page] of profile.pages.entries()) {
    const rule = page.appMatches?.[snapshot.platform];

    if (rule && appMatchEquals(rule, snapshot)) {
      return pageIndex;
    }
  }

  return profile.activePage;
}

function preferredRuleForSnapshot(snapshot) {
  const validated = validateFocusSnapshot(snapshot);
  const preferredKinds = {
    win32: ['executable'],
    darwin: ['bundleId', 'processName'],
    linux: ['wmClass', 'processName'],
  };

  for (const kind of preferredKinds[validated.platform]) {
    const identity = validated.identities.find((entry) => entry.kind === kind);

    if (!identity) {
      continue;
    }

    if (validated.platform === 'win32') {
      return {
        kind,
        value: identity.value.split('/').at(-1),
      };
    }

    return identity;
  }

  throw new TypeError('Focused app has no supported stable identity.');
}

function parseManualAppMatch(platform, input) {
  requirePlatform(platform);

  if (typeof input !== 'string') {
    throw new TypeError('App match input is invalid.');
  }

  const value = input.trim();

  if (platform === 'win32') {
    return validateAppMatch(platform, { kind: 'executable', value });
  }

  const separator = value.indexOf(':');
  const prefix = separator > 0 ? value.slice(0, separator).toLowerCase() : '';
  const explicitValue = separator > 0 ? value.slice(separator + 1) : value;

  if (platform === 'darwin') {
    const kind = prefix === 'process'
      ? 'processName'
      : prefix === 'bundle'
        ? 'bundleId'
        : BUNDLE_ID_PATTERN.test(value)
          ? 'bundleId'
          : 'processName';
    return validateAppMatch(platform, { kind, value: explicitValue });
  }

  const kind = prefix === 'process' ? 'processName' : 'wmClass';
  const ruleValue = prefix === 'class' || prefix === 'process'
    ? explicitValue
    : value;
  return validateAppMatch(platform, { kind, value: ruleValue });
}

module.exports = {
  MAX_APP_IDENTITY_LENGTH,
  appMatchEquals,
  parseManualAppMatch,
  preferredRuleForSnapshot,
  selectPageForSnapshot,
  selectProfileForSnapshot,
  validateAppMatch,
  validateAppMatches,
  validateFocusSnapshot,
};
