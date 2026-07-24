# Getting started with Stream32

This guide takes you from an unopened display to a working deck. It should take
about 20 minutes, most of which is downloading and flashing.

You will need:

- A [supported display](../boards/BUYING.md).
- A known-good USB **data** cable (many cheap cables are charge-only).
- A computer running Windows, macOS, or Linux.

## 1. Choose and connect your hardware

Stream32 supports two off-the-shelf displays. Confirm you have the right one
before flashing, because look-alike products are not interchangeable.

| Display | Confirm before you flash | Power and data |
| --- | --- | --- |
| Waveshare `ESP32-S3-Touch-LCD-4` | Silkscreen reads **Rev 3.0** (not Rev 4, and not the 4.3" board) | Single USB-C carries data and power |
| Elecrow `CrowPanel Advanced 10.1"` ESP32-P4 | It is the **10.1" ESP32-P4** model, not a 5"/7"/9" or ESP32-S3 variant | **UART0** carries data; the **USB 2.0** port must also be connected for power |

See [Buying a display](../boards/BUYING.md) for exactly what to look for on each
product page.

## 2. Install the desktop app

Download the latest build for your operating system from the
[releases page](https://github.com/FadyFaheem/Stream32/releases/latest).

| Operating system | Download | Notes |
| --- | --- | --- |
| Windows | NSIS installer or portable `.exe` | The installer registers auto-update; the portable build runs without installing |
| macOS | `.dmg` or `.zip` | Builds are currently **unsigned**: right-click the app and choose **Open** the first time, and expect to install updates manually |
| Linux | `.AppImage` or `.deb` | Mark the AppImage executable, or install the `.deb` with your package manager |

The app runs from the system tray. It can start quietly at login and checks
GitHub Releases for updates shortly after launch (also available from the tray
menu).

## 3. Flash the firmware

Firmware is downloaded on demand, not bundled with the app. The app fetches the
small board catalog, downloads only the firmware you select, verifies its size
and SHA-256 hash, and caches it for offline reflashing.

1. Connect the board over USB as described in step 1.
2. Open the desktop app and start flashing when it detects the board.
3. **Confirm the on-screen board revision matches your silkscreen.** The chip
   family is verified automatically, but only you can confirm the display and
   PCB revision, so this is the final safety check before erasing.
4. Let the flash complete, then press **RESET** or reconnect power when prompted.

Normal flashing rewrites only the firmware image and **preserves your saved
decks and artwork**. The advanced **Full erase (slow troubleshooting)** option
is off by default and deliberately destroys every saved layout and image; use it
only for recovery.

> [!TIP]
> The CrowPanel prefers a fast 921600 baud link and automatically restarts once
> at 460800 baud if that is unstable. If it still fails, install the current WCH
> CH340 driver, close any serial monitors, and try a shorter cable or a
> different direct USB port. Full BOOT-mode recovery steps are in
> [`boards/README.md`](../boards/README.md#flash-recovery).

## 4. Build your first deck

Once the board reconnects running Stream32 firmware:

1. Add a page, then add a key to it.
2. Assign an action to the key, such as launching an app, sending a hotkey,
   typing text, or opening a website.
3. Edits save automatically and sync to the device. Offline edits are kept and
   sync on the next connection.

A device can hold up to 16 named profiles, and profiles can switch
automatically based on the focused application. For copy/paste, drag-to-move,
live key state, and multi-step actions, see
[Decks and profiles](../desktop/DECKS.md).

## 5. Go further

- [Decks and profiles](../desktop/DECKS.md) covers profiles, focused-app
  switching, key editing shortcuts, live key state, and Multi Actions.
- [Action plugins](../desktop/PLUGINS.md) covers installing curated plugins and
  authoring your own declarative actions.
- [Board support](../boards/README.md) covers building firmware locally, the USB
  protocol, and flash recovery.

## Troubleshooting

- **The board does not appear.** Use a data cable, close other serial monitors,
  and on Windows install the WCH CH340 driver for the CrowPanel. Reconnect and
  retry.
- **The CrowPanel screen is dim or resets during flashing.** Connect the USB 2.0
  power port in addition to UART0; the 10.1" panel draws more power than UART0
  alone can supply.
- **Flashing fails repeatedly.** Enter BOOT mode manually: disconnect power,
  hold **BOOT** while reconnecting USB, release **BOOT**, then flash again. See
  [flash recovery](../boards/README.md#flash-recovery).
- **macOS says the app is damaged or cannot be opened.** The build is unsigned;
  right-click the app and choose **Open**, then confirm.
