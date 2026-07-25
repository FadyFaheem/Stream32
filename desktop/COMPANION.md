# Bitfocus Companion surfaces

[Bitfocus Companion](https://bitfocus.io/companion) is free, open-source
control software for broadcast and AV gear: video switchers, OBS, ProPresenter,
lighting consoles, and hundreds more. Stream32 can register a connected board
with Companion as a **Satellite surface**, so Companion draws the buttons and
receives the presses instead of Stream32's own profiles.

Stream32 keeps the USB connection to the board. Companion never talks to the
hardware directly, so the Stream32 desktop app has to stay running.

```
Companion  <-- TCP 16622 -->  Stream32 desktop  <-- USB serial -->  board
```

## Turn it on

1. Install and start Companion, then enable **Satellite API** in its settings.
   Note the address of the machine running it; the default port is `16622`.
2. In Stream32, open the **Devices** view.
3. Under **Bitfocus Companion**, set **Host** and **Port** to the Companion
   machine. Both are application-wide: every Companion-mode deck uses the same
   instance.
4. On the board's card, choose the **Rows** and **Columns** of the surface you
   want Companion to see. The board's key budget bounds these the same way deck
   pages are bounded, so a 40-key board accepts up to 8x5.
5. Tick **Companion surface** on that card.

The deck appears in Companion's **Surfaces** table as `Stream32 <nickname>`,
with the serial `stream32:<device id>`, and follows Companion's page model.

## What changes while it is on

Companion owns the board completely for as long as the toggle is on:

- Local profiles, pages, key actions, and live key state are paused for that
  device. Nothing is deleted; everything resumes when you switch the mode off.
- Focused-app profile and page switching skips that device.
- Companion's paging replaces Stream32's pages, so the board shows one grid.

Other decks are unaffected. Companion mode is per device.

## Requirements and limits

- The board must run firmware that advertises the `key-update` feature.
  Companion changes button artwork constantly, so the surface is drawn with
  RAM-only live updates rather than writes to flash. Reflash from **Flash
  board** if Stream32 reports that the firmware is too old.
- Button bitmaps are requested at the board's key size, capped at 128 px, and
  streamed over the 115200-baud link. Solid-colour Companion buttons compress
  well; photographic artwork does not, and updates it slower.
- Encoders, the pincode lock screen, brightness control from Companion, and
  Companion-initiated page changes from the board are not implemented.

## Troubleshooting

The line under the Companion address reports the connection, and each board's
card reports what that surface is doing.

| Message | Meaning |
| --- | --- |
| `Connecting to <host>:<port>…` | No answer yet. Check that Companion is running and its Satellite API is enabled. |
| `Companion connection failed: …` | The address is wrong, or a firewall is blocking TCP 16622. |
| `Companion rejected the surface: …` | Companion refused the registration, usually because the same surface id is already connected. |
| `Companion mode needs firmware with live key updates.` | Reflash the board. |

Stream32 reconnects on its own with a backoff, and re-registers every
Companion-mode surface once the connection is back.
