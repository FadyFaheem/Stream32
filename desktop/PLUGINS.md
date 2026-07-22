# Stream32 action plugins

Stream32 action plugins are declarative JSON manifests. They add searchable
actions and generated configuration fields without loading third-party code
into Electron or the ESP32 firmware.

The desktop app executes plugins. Current boards continue to send generic
`page` and `index` press events over protocol 1, so a plugin works with every
supported board without reflashing. Plugins do not run while the desktop app is
closed.

## Install a plugin

1. Open the action picker for any deck key.
2. Copy the plugin's `.json` file into the user plugin directory shown below
   **Reload plugins**.
3. Select **Reload plugins**. Invalid manifests are skipped and reported in the
   picker.

The app accepts at most 64 plugins. Each manifest is limited to 256 KiB.
Bundled Stream32 plugin IDs cannot be overridden by user files.

Project contributors can bundle a plugin by adding its manifest to
`desktop/src/plugins/`. Bundled and user manifests use the same schema.

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
action** instead of deleting the key. Reinstall the same plugin ID and reload
plugins to restore it.

Deck exports now use schema 2. The app still imports schema-1 deck files.

## Microsoft Teams

The bundled Microsoft Teams plugin uses Microsoft's documented Windows
desktop shortcuts. Microphone, camera, and raised-hand controls are toggles:
Teams does not provide Stream32 with dependable live meeting state, so the
deck cannot show whether those controls are currently on or off. The plugin
does not use Microsoft Graph credentials or UI automation.
