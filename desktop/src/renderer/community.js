// Pure display filtering: the catalog itself is fetched and verified in the
// main process, and this only narrows what the gallery shows.
function searchCatalog(decks, query) {
  const terms = String(query || '').trim().toLowerCase().split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) {
    return [...decks];
  }

  return decks.filter((deck) => {
    const text = [
      deck.name,
      deck.author,
      deck.summary || '',
      deck.board || '',
      ...deck.tags,
    ].join(' ').toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

function describeEntry(entry) {
  const parts = [`by ${entry.author}`];

  if (entry.board) {
    parts.push(entry.board);
  }

  if (entry.tags.length > 0) {
    parts.push(entry.tags.join(', '));
  }

  return parts.join(' · ');
}

// Reads the curated gallery and installs an entry as a new named profile.
// Everything here is display: the download is verified against its published
// hash and validated by the deck importer in the main process, so the renderer
// never decides whether a shared deck is trustworthy.
class CommunityController {
  constructor({ api, document, onInstalled }) {
    this.api = api;
    this.document = document;
    this.onInstalled = onInstalled;
    this.decks = [];
    this.devices = {};
    this.query = '';
    this.loaded = false;
    this.busy = false;

    this.list = document.querySelector('#community-list');
    this.status = document.querySelector('#community-status');
    this.search = document.querySelector('#community-search');
    this.deviceSelect = document.querySelector('#community-device');
    this.refreshButton = document.querySelector('#community-refresh');
    this.shareButton = document.querySelector('#community-share');

    this.search.addEventListener('input', () => {
      this.query = this.search.value;
      this.renderList();
    });
    this.refreshButton.addEventListener('click', () => {
      this.load(true);
    });
    this.shareButton.addEventListener('click', () => {
      this.api.openCommunityShareGuide().catch((error) => {
        this.setStatus(
          `The sharing guide could not be opened: ${error.message}`,
          'error',
        );
      });
    });
  }

  setStatus(message, state = 'idle') {
    this.status.textContent = message;
    this.status.dataset.state = state;
  }

  setDevices(devices) {
    this.devices = devices || {};
    const previous = this.deviceSelect.value;
    this.deviceSelect.replaceChildren();

    for (const [deviceId, device] of Object.entries(this.devices)) {
      const option = this.document.createElement('option');
      option.value = deviceId;
      option.textContent = device.name || deviceId;
      this.deviceSelect.append(option);
    }

    if (previous && this.devices[previous]) {
      this.deviceSelect.value = previous;
    }

    this.deviceSelect.disabled = this.deviceSelect.options.length === 0;
    this.renderList();
  }

  // The catalog is fetched the first time the view is opened rather than at
  // startup, so a user who never opens it makes no network request.
  async show() {
    if (!this.loaded) {
      await this.load(false);
    }
  }

  async load(force) {
    this.refreshButton.disabled = true;
    this.setStatus('Loading shared decks…');

    try {
      const catalog = await this.api.listCommunityDecks(force);
      this.decks = catalog.decks;
      this.loaded = true;
      this.setStatus(
        catalog.stale
          ? `Showing the last downloaded list. ${catalog.reason || ''}`.trim()
          : `${catalog.decks.length} shared deck` +
            `${catalog.decks.length === 1 ? '' : 's'}.`,
        catalog.stale ? 'error' : 'ready',
      );
    } catch (error) {
      this.decks = [];
      this.setStatus(
        `Shared decks could not be loaded: ${error.message}`,
        'error',
      );
    } finally {
      this.refreshButton.disabled = false;
      this.renderList();
    }
  }

  async install(entry) {
    const deviceId = this.deviceSelect.value;

    if (!deviceId) {
      this.setStatus('Connect a device before installing a shared deck.', 'error');
      return;
    }

    this.busy = true;
    this.renderList();
    this.setStatus(`Installing ${entry.name}…`);

    try {
      const result = await this.api.installCommunityDeck(deviceId, entry.id);
      this.setStatus(
        `${entry.name} was added as a profile on ` +
        `${this.devices[deviceId]?.name || deviceId}.`,
        'ready',
      );
      this.onInstalled?.(deviceId, result.device);
    } catch (error) {
      this.setStatus(`${entry.name} was not installed: ${error.message}`, 'error');
    } finally {
      this.busy = false;
      this.renderList();
    }
  }

  renderList() {
    const matches = searchCatalog(this.decks, this.query);
    this.list.replaceChildren();

    if (matches.length === 0) {
      const empty = this.document.createElement('p');
      empty.className = 'helper';
      empty.textContent = this.decks.length === 0
        ? 'No shared decks are available yet.'
        : 'No shared deck matches that search.';
      this.list.append(empty);
      return;
    }

    for (const entry of matches) {
      const card = this.document.createElement('article');
      card.className = 'community-card';
      const heading = this.document.createElement('h3');
      heading.textContent = entry.name;
      const meta = this.document.createElement('p');
      meta.className = 'community-card-meta';
      meta.textContent = describeEntry(entry);
      card.append(heading, meta);

      if (entry.summary) {
        const summary = this.document.createElement('p');
        summary.className = 'community-card-summary';
        summary.textContent = entry.summary;
        card.append(summary);
      }

      const install = this.document.createElement('button');
      install.type = 'button';
      install.className = 'button button-secondary';
      install.textContent = 'Install';
      install.disabled = this.busy || this.deviceSelect.disabled;
      install.addEventListener('click', () => {
        this.install(entry);
      });
      card.append(install);
      this.list.append(card);
    }
  }
}

module.exports = { CommunityController, describeEntry, searchCatalog };
