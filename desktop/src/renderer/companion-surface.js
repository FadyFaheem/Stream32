const {
  crc32,
  encodeKeyUpdateMessage,
  encodeLayoutMessage,
  encodePageMessage,
  toRgb565,
  validateKeyUpdateAck,
  validateLayoutAck,
} = require('./protocol');

// Companion owns a single page while the surface is registered.
const SURFACE_PAGE = 0;
// Mirrors MAX_BITMAP_PIXELS in src/companion-protocol.js, which validates the
// requested size again in the main process. Larger buttons cost wire time on
// the 115200-baud link without looking better on these panels.
const MAX_BITMAP_PIXELS = 128;
const COMPANION_BACKGROUND = '#000000';
// The firmware frees every live overlay 30s after the last key-update, and
// one update refreshes the whole lease, so a single key is enough to hold it.
const LEASE_REFRESH_MS = 10000;
const FLUSH_DEBOUNCE_MS = 30;

function rgbToImageData(bitmap, size) {
  const rgba = new Uint8ClampedArray(size * size * 4);

  for (let source = 0, target = 0; source < bitmap.length; source += 3) {
    rgba[target++] = bitmap[source];
    rgba[target++] = bitmap[source + 1];
    rgba[target++] = bitmap[source + 2];
    rgba[target++] = 255;
  }

  return new ImageData(rgba, size, size);
}

// A Companion button already has its text and icon baked into the bitmap, so
// it is drawn as the key's artwork and only the background colour is reused.
function renderKey(document, state, keyPx) {
  const canvas = document.createElement('canvas');
  canvas.width = keyPx;
  canvas.height = keyPx;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = state.color || COMPANION_BACKGROUND;
  context.fillRect(0, 0, keyPx, keyPx);

  const source = rgbToImageData(state.bitmap, state.bitmapSize);

  if (state.bitmapSize === keyPx) {
    context.putImageData(source, 0, 0);
  } else {
    const scratch = document.createElement('canvas');
    scratch.width = state.bitmapSize;
    scratch.height = state.bitmapSize;
    scratch.getContext('2d').putImageData(source, 0, 0);
    context.drawImage(scratch, 0, 0, keyPx, keyPx);
  }

  const pixels = toRgb565(context.getImageData(0, 0, keyPx, keyPx));
  return { crc: crc32(pixels), pixels };
}

function signatureOf(state, render) {
  if (!state) {
    return 'clear';
  }

  return render
    ? `image:${render.crc}:${state.color || ''}`
    : `text:${state.label}:${state.color || ''}:${state.labelColor || ''}`;
}

// Bridges one connected board to a Companion Satellite surface: Companion
// streams button state in, board presses go back out, and the local deck
// profile stays untouched until the mode is switched off again.
class CompanionSurfaces {
  constructor({ api, document, runtime, onStatus }) {
    this.api = api;
    this.document = document;
    this.runtime = runtime;
    this.onStatus = onStatus;
    this.surfaces = new Map();
    this.leaseTimer = null;
  }

  surfaceFor(deviceId) {
    return this.surfaces.get(deviceId) || null;
  }

  start() {
    this.api.onCompanionKeyState((state) => this.handleKeyState(state));
    this.api.onCompanionKeysClear((deviceId) => this.handleKeysClear(deviceId));
    clearInterval(this.leaseTimer);
    this.leaseTimer = setInterval(() => this.refreshLeases(), LEASE_REFRESH_MS);
    this.leaseTimer?.unref?.();
  }

  // One key-update renews the firmware's overlay lease for the whole page.
  refreshLeases() {
    for (const [deviceId, surface] of this.surfaces) {
      if (surface.keyPx && surface.pending.size === 0 && !surface.flushing) {
        surface.signatures.delete(0);
        surface.pending.add(0);
        this.scheduleFlush(deviceId);
      }
    }
  }

  async attach(deviceId, session) {
    const device = this.runtime.getDevices()[deviceId];
    const { rows, cols } = device.companion;

    // Companion replaces button artwork constantly, so the surface is drawn
    // entirely with RAM-only live key updates rather than flashed layouts.
    if (!session.hello?.features?.includes('key-update')) {
      this.onStatus(
        'Companion mode needs firmware with live key updates. ' +
          'Reflash this board from the Flash board section.',
        'error',
      );
      return;
    }

    const surface = {
      session,
      rows,
      cols,
      keyPx: 0,
      states: new Map(),
      signatures: new Map(),
      pending: new Set(),
      flushing: false,
      flushTimer: null,
    };
    this.surfaces.set(deviceId, surface);
    // No local profile is on this board any more, which also stops presses
    // and device page reports from reaching the local action path.
    session.committedProfileId = null;
    session.profileInputBlocked = true;
    this.onStatus('Preparing the Companion surface…', 'working');

    try {
      const ack = validateLayoutAck(await this.runtime.sendWithReply(
        deviceId,
        session,
        encodeLayoutMessage({
          page: SURFACE_PAGE,
          of: 1,
          rows,
          cols,
          keys: [],
        }),
        {
          type: 'layout-ack',
          identity: { page: SURFACE_PAGE, rows, cols },
          errorCodes: [
            'display-busy',
            'layout-invalid',
            'layout-too-large',
            'storage-failed',
            'unknown-type',
          ],
        },
      ));

      if (this.surfaces.get(deviceId) !== surface) {
        return;
      }

      await session.send(encodePageMessage(SURFACE_PAGE));
      surface.keyPx = ack.keyPx;
      await this.api.addCompanionSurface({
        deviceId,
        productName: device.name,
        rows,
        cols,
        bitmapSize: Math.min(ack.keyPx, MAX_BITMAP_PIXELS),
      });
      this.onStatus(
        `Companion owns this deck as a ${rows}x${cols} surface.`,
        'ready',
      );
    } catch (error) {
      this.surfaces.delete(deviceId);
      this.onStatus(`Companion surface failed: ${error.message}`, 'error');
    }
  }

  async detach(deviceId) {
    const surface = this.surfaces.get(deviceId);

    if (!surface) {
      return;
    }

    clearTimeout(surface.flushTimer);
    this.surfaces.delete(deviceId);
    await this.api.removeCompanionSurface(deviceId).catch(() => {
      // Losing the surface registration only matters while connected.
    });
  }

  handleKeyState(state) {
    const surface = this.surfaces.get(state.deviceId);

    if (!surface || state.index >= surface.rows * surface.cols) {
      return;
    }

    surface.states.set(state.index, state);
    surface.pending.add(state.index);
    this.scheduleFlush(state.deviceId);
  }

  handleKeysClear(deviceId) {
    const surface = this.surfaces.get(deviceId);

    if (!surface) {
      return;
    }

    for (let index = 0; index < surface.rows * surface.cols; index++) {
      surface.states.delete(index);
      surface.pending.add(index);
    }

    this.scheduleFlush(deviceId);
  }

  handlePress(deviceId, press) {
    if (press.page !== SURFACE_PAGE) {
      return;
    }

    this.api.sendCompanionKeyPress(deviceId, press.index, press.phase === 'down');
  }

  scheduleFlush(deviceId) {
    const surface = this.surfaces.get(deviceId);

    if (!surface || surface.flushing || !surface.keyPx) {
      return;
    }

    clearTimeout(surface.flushTimer);
    surface.flushTimer = setTimeout(() => {
      surface.flushTimer = null;
      this.flush(deviceId);
    }, FLUSH_DEBOUNCE_MS);
  }

  async flush(deviceId) {
    const surface = this.surfaces.get(deviceId);

    if (!surface || surface.flushing) {
      return;
    }

    surface.flushing = true;

    try {
      while (surface.pending.size > 0) {
        const index = surface.pending.values().next().value;
        surface.pending.delete(index);
        await this.sendKey(deviceId, surface, index);

        if (this.surfaces.get(deviceId) !== surface) {
          return;
        }
      }
    } catch (error) {
      surface.pending.clear();
      this.onStatus(`Companion update failed: ${error.message}`, 'error');
    } finally {
      surface.flushing = false;
    }
  }

  async sendKey(deviceId, surface, index) {
    const { session } = surface;
    const state = surface.states.get(index) || null;
    const render = state?.bitmap
      ? renderKey(this.document, state, surface.keyPx)
      : null;
    const signature = signatureOf(state, render);

    if (surface.signatures.get(index) === signature) {
      return;
    }

    const patch = state
      ? {
          page: SURFACE_PAGE,
          index,
          color: state.color || COMPANION_BACKGROUND,
          ...(render
            ? { imageCrc: render.crc }
            : {
                ...(state.label ? { label: state.label } : {}),
                ...(state.labelColor ? { labelColor: state.labelColor } : {}),
              }),
        }
      : { page: SURFACE_PAGE, index, clear: true };
    const ack = validateKeyUpdateAck(await this.runtime.sendWithReply(
      deviceId,
      session,
      encodeKeyUpdateMessage(patch),
      {
        type: 'key-update-ack',
        identity: { page: SURFACE_PAGE, index },
        errorCodes: ['display-busy', 'key-update-invalid', 'unknown-type'],
      },
    ));

    if (ack.needImage && render) {
      await this.runtime.streamImage(
        deviceId,
        session,
        SURFACE_PAGE,
        index,
        surface.keyPx,
        render,
        'ephemeral',
      );
    }

    surface.signatures.set(index, signature);
  }
}

module.exports = { CompanionSurfaces, renderKey };
