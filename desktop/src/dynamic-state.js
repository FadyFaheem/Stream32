const MAX_LABEL_LENGTH = 32;
const MAX_IMAGE_DATA_URL_LENGTH = 256 * 1024;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/;
const IMAGE_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const PROVIDERS = new Set(['toggle', 'clock', 'focused-app']);

function optionalAppearanceString(value, field, maximumLength, pattern = null) {
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    (pattern && !pattern.test(value))
  ) {
    throw new TypeError(`${field} is invalid.`);
  }

  return value;
}

function validateAppearance(appearance) {
  if (!appearance || typeof appearance !== 'object' || Array.isArray(appearance)) {
    throw new TypeError('Toggle on appearance is invalid.');
  }

  const validated = {};
  const label = optionalAppearanceString(
    appearance.label,
    'Toggle on label',
    MAX_LABEL_LENGTH,
  );
  const color = optionalAppearanceString(
    appearance.color,
    'Toggle on color',
    7,
    COLOR_PATTERN,
  );
  const labelColor = optionalAppearanceString(
    appearance.labelColor,
    'Toggle on label color',
    7,
    COLOR_PATTERN,
  );
  const image = optionalAppearanceString(
    appearance.image,
    'Toggle on image',
    MAX_IMAGE_DATA_URL_LENGTH,
    IMAGE_DATA_URL_PATTERN,
  );

  if (label !== undefined) validated.label = label;
  if (color !== undefined) validated.color = color;
  if (labelColor !== undefined) validated.labelColor = labelColor;
  if (image !== undefined) validated.image = image;
  return validated;
}

function validateLiveState(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Live state configuration is invalid.');
  }

  if (!PROVIDERS.has(config.provider)) {
    throw new TypeError('Live state provider is invalid.');
  }

  switch (config.provider) {
    case 'toggle':
      return {
        provider: 'toggle',
        on: validateAppearance(config.on || {}),
      };
    case 'clock':
      if (config.hour12 !== undefined && typeof config.hour12 !== 'boolean') {
        throw new TypeError('Clock format is invalid.');
      }
      return { provider: 'clock', hour12: Boolean(config.hour12) };
    case 'focused-app':
      return { provider: 'focused-app' };
    default:
      throw new TypeError(`Unknown live state provider: ${config.provider}`);
  }
}

function mergeKeyOverlay(base, overlay) {
  const merged = { ...(base || {}) };

  if (!overlay) {
    return merged;
  }

  for (const field of ['label', 'color', 'labelColor', 'image']) {
    if (overlay[field] !== undefined) {
      merged[field] = overlay[field];
    }
  }

  if (overlay.state !== undefined) {
    merged.state = overlay.state;
  }

  return merged;
}

function formatClock(date, hour12 = false) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12,
  }).format(date);
}

function millisecondsUntilNextMinute(date = new Date()) {
  return 60_000 - (date.getSeconds() * 1000 + date.getMilliseconds());
}

function focusedAppTitle(snapshot) {
  const identity = snapshot?.identities?.find((entry) =>
    ['processName', 'executable', 'bundleId', 'wmClass'].includes(entry?.kind),
  );

  if (!identity || typeof identity.value !== 'string') {
    return '';
  }

  const leaf = identity.value.replaceAll('\\', '/').split('/').at(-1);
  return leaf.replace(/\.(?:exe|app)$/i, '').slice(0, MAX_LABEL_LENGTH);
}

function providerNames(registry) {
  const names = new Set();

  for (const device of Object.values(registry?.devices || {})) {
    for (const profile of Object.values(device.profiles || {})) {
      for (const page of profile.pages || []) {
        for (const key of page.keys || []) {
          if (PROVIDERS.has(key.liveState?.provider)) {
            names.add(key.liveState.provider);
          }
        }
      }
    }
  }

  return [...names].sort();
}

module.exports = {
  MAX_LABEL_LENGTH,
  PROVIDERS,
  focusedAppTitle,
  formatClock,
  mergeKeyOverlay,
  millisecondsUntilNextMinute,
  providerNames,
  validateLiveState,
};
