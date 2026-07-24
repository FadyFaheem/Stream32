# Stream32 board support

Board profiles and firmware source live here independently from the Electron
application. The desktop app downloads the small `catalog-v1.json` file from
the rolling `boards-current` GitHub Release, then downloads only the firmware
selected by the user. Verified firmware is cached locally for offline
reflashing.

Compiled firmware does not belong in Git. The board release workflow builds
each project with its pinned ESP-IDF version, uploads version-named images,
publishes the generated dependency lock beside each image, and publishes the
catalog last with the final file sizes and SHA-256 hashes.

## Supported hardware

Looking to buy a board? See [Buying a display](./BUYING.md) for purchase links
and the exact model and revision to choose. For a first-time setup walkthrough,
see the [Getting started guide](../docs/GETTING_STARTED.md).

Waveshare `ESP32-S3-Touch-LCD-4` (profile
`waveshare-esp32-s3-touch-lcd-4-v3`):

- Silkscreen hardware revision `3.0`
- ESP32-S3 N16R8, ST7701 480×480 LCD, GT911 touch, and TCA9554 I/O expander
- The native USB Serial/JTAG connection (`303a:1001`)

The similarly named 4.3-inch board and hardware Rev 4 are different devices.
Do not select the Rev3 profile for either one.

Elecrow `CrowPanel Advanced 10.1"` (profile
`elecrow-crowpanel-advanced-10-1-esp32-p4`, model `DHE04310D`):

- Hardware revisions `1.0`–`1.2` (they differ only in wireless-module pins
  this firmware never touches)
- ESP32-P4NRW32 (16 MB flash, 32 MB PSRAM), EK79007 1024×600 MIPI-DSI IPS
  panel, GT911 touch
- Flashing and the Stream32 protocol both run through the on-board CH340K
  USB-UART bridge on the port labeled `UART0`. Shipping hardware has been
  observed as `USB-SERIAL CH340K` (`1a86:7522`, for example COM6); the profile
  also retains `1a86:7523` for earlier documented CH340 variants. The USB 2.0
  port must also be connected for power: the display draws roughly 8–10 W,
  more than UART0 alone can supply. The pre-installed ESP32-C6 radio module
  is not used.

The Espressif ROM reports the chip family, which the desktop verifies
before erasing. The ROM cannot identify the attached display or PCB
revision, so the user-visible silkscreen confirmation is the final
board-revision safety check.

## Build firmware locally

Install ESP-IDF 5.4.4, activate its environment, then run the helper from
the firmware directory of the board you are building, for example:

```sh
cd boards/waveshare-esp32-s3-touch-lcd-4-v3/firmware
bash ../../tools/build-firmware.sh
```

The helper reads the versioned image name from `board.json` and writes the
merged factory image to `boards/dist/`. Merged images are flashed at
offset `0x0`; on the ESP32-P4 the bootloader (and its `0xE9` magic byte)
sits at `0x2000` inside that image.

### Desktop flashing behavior

The CrowPanel profile prefers 921600 baud. If that attempt fails, the desktop
disconnects the failed loader and restarts the complete image write once at
460800 baud; other boards default to 460800. Normal flashing sector-erases
only the verified merged-image range, preserving the CrowPanel's dedicated
11.94 MB `deck` partition. The advanced **Full erase (slow troubleshooting)**
option is off by default and deliberately erases the entire chip, including
saved layouts and artwork.

For the CrowPanel, connect both UART0 with a known-good USB data cable and
USB 2.0 for power. Close serial monitors, install the current WCH CH340 driver
if Windows does not expose the COM port reliably, and try a shorter cable or
different direct USB port if the automatic 460800 fallback also fails.

### Deck sync performance

The runtime protocol stays at 115200 baud for compatibility. The previous slow
path sent every rendered key as raw RGB565, base64-expanded and
stop-and-wait, so a fully decorated 40-key CrowPanel page was dominated by
image wire bytes. Firmware now advertises the additive `image-rle` feature.
The desktop still computes layout CRCs over raw RGB565 and chooses RLE only
when the encoded payload is smaller.

Run `node desktop/tools/image-rle-benchmark.js` for the deterministic synthetic
wire-byte benchmark. At 180×180 it currently reports 88,365 raw JSON-line bytes
per key versus 105 for a flat key (99.9% less), and 2,749 for the striped/icon
sample (96.9% less). These are byte counts, not timing promises; ACK latency,
rendering, persistence, drivers, and cabling still matter. Photographic or
noisy artwork often does not compress and automatically uses the unchanged raw
format.

## Add or update a board

1. Create a lowercase, stable board directory containing `board.json` and an
   ESP-IDF project. The board-independent protocol decoder, deck UI, and
   flash persistence live in the shared
   `boards/common/components/stream32_deck` component:
   point `EXTRA_COMPONENT_DIRS` at `boards/common/components`, set the
   `STREAM32_DECK_*` screen and grid options in `sdkconfig.defaults`, and
   provide `bsp_display_lock`/`bsp_display_unlock` from the board's BSP.
   Only the BSP and the transport `main.c` are board-specific.
2. Add the profile path to `boards/catalog.json`.
3. Keep the profile firmware version, image filename, and CMake
   `PROJECT_VER` aligned.
4. Use USB filters that are specific enough to avoid selecting unrelated
   serial devices.
5. Run `node boards/tools/build-catalog.js --validate-only`.
6. Open a pull request. Board CI validates every profile and compiles every
   listed firmware project.

Merging a `boards/**` change to `main` updates the non-latest
`boards-current` release. A profile using catalog schema 1, protocol 1, and
the already-supported flashing transport appears without a desktop release.
New protocols, chips, or transports require corresponding desktop support.

## USB protocol v1

Firmware and desktop exchange bounded newline-delimited JSON over the
board's serial link (the ESP32-S3's native USB Serial/JTAG port, or the
CrowPanel's CH340 UART0 bridge at a fixed 115200 baud). Image lines remain
below 4096 bytes; the 40-key CrowPanel accepts up to 8192 bytes for its larger
single-line layouts.

Desktop messages:

```json
{"type":"hello","protocol":1,"features":["key-update"]}
{"type":"ping","id":1}
{"type":"layout","page":0,"of":2,"rows":3,"cols":3,"keys":[{"index":0,"label":"OBS","color":"#ff5533","labelColor":"#ffffff","imageCrc":"9a3f11d2","goPage":1}]}
{"type":"image","page":0,"index":0,"seq":0,"of":13,"w":150,"h":150,"data":"<base64 RGB565>"}
{"type":"image","page":0,"index":0,"seq":0,"of":2,"w":150,"h":150,"encoding":"rle565","data":"<base64 RLE tuples>"}
{"type":"key-update","page":0,"index":0,"label":"LIVE","color":"#b71c1c","state":"on","imageCrc":"1a2b3c4d"}
{"type":"image","mode":"ephemeral","page":0,"index":0,"seq":0,"of":13,"w":150,"h":150,"data":"<base64 RGB565>"}
{"type":"page","index":1}
{"type":"display","awake":false,"idleTimeoutSeconds":600}
```

Firmware messages:

```json
{"type":"hello","protocol":1,"boardId":"waveshare-esp32-s3-touch-lcd-4-v3","firmwareVersion":"0.2.8","deviceId":"aabbccddeeff","features":["display-control","key-update","image-rle"]}
{"type":"pong","id":1}
{"type":"touch","phase":"down","x":120,"y":240}
{"type":"layout-ack","page":0,"rows":3,"cols":3,"keyPx":150,"needImages":[0,4]}
{"type":"image-ack","page":0,"index":0,"seq":0}
{"type":"key-update-ack","page":0,"index":0,"needImage":true}
{"type":"image-ack","page":0,"index":0,"seq":0,"mode":"ephemeral"}
{"type":"page","index":1}
{"type":"press","page":0,"index":4,"phase":"down"}
```

The desktop does not mark a port connected until the hello response has the
expected protocol, a catalog board ID, a semantic firmware version, and a
valid MAC-derived device ID.

### Deck messages

The deck extension is additive to protocol 1; firmware without it answers
`error: unknown-type` and the desktop reports that a reflash is needed.

- `layout` describes one page of the desired deck state. Grids are
  free-form up to 10 rows/columns in either orientation (9×4, 4×9, 10×3,
  …), bounded by the board's per-page key budget in `board.json`
  (`deck.maxKeys`, at most 40). One page still encodes into a single
  line: budgets up to 30 keys fit the baseline 4096-byte line every
  firmware accepts; a larger budget requires firmware built with an 8 KB
  line buffer and two flash sectors per stored page (the shared
  `stream32_deck` component switches automatically above 30 keys). The
  desktop pushes every page in order after each handshake or edit. `imageCrc` is the CRC-32 of the key's rendered RGB565
  pixels; `goPage` marks a navigation key the firmware handles locally so
  page switching works without a host.
- `layout-ack` reports `keyPx`, the on-screen key size in pixels. The host
  renders artwork at exactly that size, which keeps the protocol
  resolution-independent across board types. `needImages` lists only the
  keys whose artwork is missing from the device's flash pool, so a
  steady-state reconnect streams nothing.
- `image` chunks stream RGB565 artwork base64-encoded, stop-and-wait: the
  desktop sends the next chunk only after the matching `image-ack`. The
  final chunk is verified against the raw-pixel `imageCrc` and persisted.
  Firmware advertising `image-rle` may receive `encoding:"rle565"` chunks,
  where each complete four-byte tuple is a little-endian 16-bit run count and
  one RGB565 pixel. The desktop uses RLE only when it is smaller than raw
  pixels, and never splits a tuple between chunks. Old firmware therefore
  still receives raw chunks. Flat colors, borders, text, and many icons shrink
  sharply; photographic or noisy artwork may not compress and stays raw.
- `page` selects the visible page. The firmware also emits it when a
  `goPage` key switches pages locally.
- `press` reports key touches with their page so the desktop can run the
  configured action.
- `key-update` is enabled only when hello advertises `key-update`. It replaces
  one bounded RAM-only overlay (optional label/colors/state/image CRC) without
  changing the persisted layout. `key-update-ack.needImage` gates ephemeral
  stop-and-wait image chunks. Their CRC is checked, but their bytes remain in
  RAM/PSRAM and are freed on replacement, base layout sync, reconnect/hello,
  reboot, or expiry of the desktop-refreshed 30-second overlay lease after a
  physical disconnect. Older protocol-1 firmware simply runs the base deck; the desktop
  does not emulate live state by rewriting layouts or flash artwork.

### Display protection

Firmware turns the display off after 10 minutes without touch activity by
default. The desktop can change that interval with the additive `display`
message when the firmware hello advertises `display-control`. `awake:false`
forces the display to remain off while the host is locked; `awake:true` wakes
it and restores normal idle timing. `idleTimeoutSeconds` is bounded to
0-86400.

Touch stays active while the display is off. The first touch after an idle
timeout only wakes the display and does not press a deck key. Touches remain
consumed during host-forced sleep, so locked computers cannot run key actions.
The optional `brightness` field is bounded to 0-100 and is sent only when hello
also advertises `display-brightness`. The global desktop brightness setting
therefore controls the Elecrow PWM backlight and is restored after idle or lock
sleep. Waveshare Rev 3 does not advertise brightness because its current BSP
has no software-controlled backlight pin; idle and lock still blank its ST7701
image, although the backlight may remain lit.

The firmware persists layouts and artwork to the dedicated `deck` flash
partition (header last, CRC-checked), so a standalone device boots straight
into its deck. Artwork is pooled by CRC and garbage-collected after each
full sync.

The shared component keeps wire decoding, strict bounds/UTF-8/hex checks,
ACK formatting, and image sequencing in `deck_protocol.c`. Its typed calls
leave LVGL objects and locking, the page model, display policy, persistent
storage decisions, and live-overlay pixel ownership in `deck_ui.c`.

## Flash recovery

Use a USB data cable and close other serial monitors before flashing. The
CrowPanel additionally needs USB 2.0 power while UART0 carries data. If
automatic bootloader entry fails:

1. Disconnect power.
2. Hold **BOOT** while reconnecting USB, then release **BOOT**.
3. Flash again.

After a verified CrowPanel write, the desktop keeps UART0 open for 90 seconds
and sends a protocol hello once per second. Press and release **RST** during
that window; do not hold **BOOT**. If the window expires, the firmware is still
written and verified—press **RST** or power-cycle, then use **Reconnect**. The
Waveshare profile uses the normal automatic post-flash reset.

Board profiles declare this behavior with `postFlashReset`, validated as
`automatic` (the default) or `manual`. This is desktop/catalog metadata and
does not change firmware images or versions.

Normal flashing replaces only firmware-image sectors and preserves the
dedicated deck partition. Use **Full erase (slow troubleshooting)** only when
sector rewriting and the automatic lower-baud retry do not recover the board;
full erase destroys every saved layout and artwork image.
