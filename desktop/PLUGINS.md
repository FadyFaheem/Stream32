# Stream32 action plugins

Stream32 action plugins are declarative JSON manifests. They add searchable
actions and generated configuration fields without loading third-party code
into Electron or the ESP32 firmware.

Live key-state providers (`toggle`, `clock`, and `focused-app`) are first-party
desktop features. Plugin manifests cannot add provider code, polling,
WebSockets, native modules, or evaluated scripts.

The desktop app executes plugins. Current boards continue to send generic
`page` and `index` press events over protocol 1, so a plugin works with every
supported board without reflashing. Plugins do not run while the desktop app is
closed.

## Install a plugin

Open **Settings > Action plugins** to browse the curated catalog. Stream32
downloads only the selected versioned JSON manifest from the fixed
`plugins-current` GitHub Release, verifies its declared byte size and SHA-256,
validates it with the same manifest validator used at startup, and then writes
it atomically to the user plugin directory. Updates and removal happen in the
same panel. Removing a plugin preserves its saved deck references so
reinstalling the same ID restores them.

For a manual manifest:

1. Open **Settings > Action plugins**.
2. Copy the trusted `.json` file into the user plugin directory shown under
   **Manual manifests**.
3. Select **Reload manual plugins**. Invalid manifests are skipped and reported
   in Settings and the action picker.

The app accepts at most 64 plugins. Each manifest is limited to 256 KiB.
Bundled Stream32 plugin IDs cannot be overridden by user files.

Project contributors can bundle a plugin by adding its manifest to
`desktop/src/plugins/`. Bundled and user manifests use the same schema.
Bundled plugins are displayed separately as built in and cannot be updated or
removed through the catalog.

## Curated catalog publishing

Curated source manifests live under the repository-root `plugins/manifests/`
directory, which is intentionally separate from bundled manifests in
`desktop/src/plugins/`. Add the versioned manifest path and minimum compatible
desktop version to `plugins/catalog.json`, then run:

```sh
node --test plugins/tools/*.test.js
node plugins/tools/build-catalog.js --validate-only
```

The generated `plugins/dist/` directory is ignored and must not be committed.
After a plugin change reaches `main`, the **Publish Curated Plugins** workflow
validates every manifest, builds immutable versioned JSON assets, rejects reuse
of an asset name with different bytes, and updates the non-latest
`plugins-current` release. It uploads `catalog-v1.json` only after all
versioned assets succeed.

Catalog schema 1 records each plugin's stable ID, name, description, SemVer,
immutable asset name, byte size, SHA-256, and minimum desktop version. Catalog
and manifest limits are enforced both by publication tooling and by the
desktop client. Catalog assets remain JSON data: executable capabilities,
JavaScript, WebAssembly, native code, launch commands, eval, and shell access
are not supported.

## Minimal manifest

```json
{
  "stream32Plugin": 1,
  "id": "example-search",
  "name": "Example Search",
  "version": "1.0.0",
  "description": "Search example.com from a deck key.",
  "actions": [
    {
      "id": "search",
      "name": "Search Example",
      "description": "Open a search for the configured text.",
      "category": "Web",
      "icon": "search",
      "keywords": ["find", "query"],
      "fields": [
        {
          "id": "query",
          "type": "text",
          "label": "Search text",
          "required": true,
          "maxLength": 80,
          "placeholder": "ESP32"
        }
      ],
      "platforms": {
        "win32": {
          "type": "url",
          "url": "https://example.com/search",
          "query": {
            "q": { "setting": "query" }
          }
        },
        "darwin": {
          "type": "url",
          "url": "https://example.com/search",
          "query": {
            "q": { "setting": "query" }
          }
        },
        "linux": {
          "type": "url",
          "url": "https://example.com/search",
          "query": {
            "q": { "setting": "query" }
          }
        }
      },
      "appearance": {
        "label": "Search",
        "icon": "search",
        "color": "#172630",
        "labelColor": "#f3f7f9"
      }
    }
  ]
}
```

IDs use lowercase letters, numbers, and hyphens, are at most 64 characters,
and must remain stable. Renaming a plugin or action ID breaks references in
saved decks. Versions use SemVer.

## Action fields

An action can declare up to 16 fields:

- `text`: supports `required`, `maxLength` (up to 512), `placeholder`, and
  `default`.
- `select`: requires `options` containing `value` and `label`; `default` must
  match an option.
- `toggle`: has a boolean `default`.

Use `{ "setting": "field-id" }` in a capability wherever that capability
accepts a field reference. Stream32 validates the configured value again in
the main process before execution.

## Capabilities

Plugins can use only these allowlisted capabilities:

### Hotkey

```json
{
  "type": "hotkey",
  "key": "M",
  "ctrl": true,
  "shift": true,
  "alt": false,
  "meta": false
}
```

`key` can be a fixed Stream32 key name or a reference to a `select` field.
Modifier values can be fixed booleans or references to `toggle` fields.

### Media

```json
{ "type": "media", "command": "play-pause" }
```

Commands are `mute`, `next`, `play-pause`, `previous`, `volume-down`, and
`volume-up`. `command` can instead reference a `select` field whose values are
from that list.

### Type Text

```json
{ "type": "text", "text": { "setting": "message" } }
```

`text` can be a fixed value or reference a `text`/`select` field. Resolved
content uses the same 512-Unicode-character limit as the core Type Text action;
newline and tab are allowed, while NUL and unsafe control characters are
rejected. Mouse remains core-only because safely configurable coordinates and
deltas would require numeric plugin fields, which schema 1 intentionally does
not expose.

### HTTPS URL

```json
{
  "type": "url",
  "url": "https://example.com/search",
  "query": {
    "q": { "setting": "query" }
  }
}
```

The URL must resolve to HTTPS. Query values are encoded with the standard URL
API. A plugin cannot launch commands, read files, access the serial port, or
run JavaScript.

Every action needs at least one binding under `platforms`. Supported keys are
`win32`, `darwin`, and `linux`. An action remains visible but unavailable when
it has no binding for the current platform.

## Saved decks and missing plugins

Decks save only the plugin ID, action ID, and validated settings. If a plugin
is removed, Stream32 preserves that reference and shows **Missing plugin
action** instead of deleting the key. References inside Multi Actions are
preserved the same way. Reinstall the same plugin ID and reload plugins to
restore it.

Deck exports use schema 3. The app still imports schema-1 and schema-2 deck
files.

## Bundled shortcut plugins

The bundled Microsoft Teams plugin uses Microsoft's documented Windows
desktop shortcuts. Microphone, camera, and raised-hand controls are toggles:
Teams does not provide Stream32 with dependable live meeting state, so the
deck cannot show whether those controls are currently on or off. The plugin
does not use Microsoft Graph credentials or UI automation.

The Discord plugin provides mute, deafen, and call shortcuts. Mute and deafen
work while the Discord desktop app is in the background; actions such as
declining a call can still require Discord to be focused.

The Zoom plugin provides common meeting controls on Windows, macOS, and Linux.
Enable individual shortcuts as global shortcuts in Zoom's keyboard settings
when they must work while another application is focused. Zoom's screen-share
shortcut can still require the meeting controls to be focused.

Google Meet shortcuts are handled by the browser, so the browser window and
the meeting tab must be focused. Stream32 does not use a browser extension or
read the meeting's microphone, camera, or hand state.

OBS Studio does not assign dependable default hotkeys. Configure the key and
modifiers on the Stream32 action, then assign the same chord to the matching
operation under **OBS Settings > Hotkeys**. For toggle actions, assign the
same chord to both sides, such as Start Recording and Stop Recording. These
actions send hotkeys only; they do not connect to OBS WebSocket or display
live streaming, recording, scene, or audio state.
