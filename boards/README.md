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
- An optional
  [power-button bypass](../docs/WAVESHARE_V3_POWER_BUTTON_BYPASS.md) for
  automatic startup

The similarly named 4.3-inch board and hardware Rev 4 are different devices.
Do not select the Rev3 profile for either one.

Elecrow `CrowPanel Advanced 10.1"` (profile
`elecrow-crowpanel-advanced-10-1-esp32-p4`, model `DHE04310D`):

- Hardware revisions `1.0`–`1.2` (they differ only in wireless-module pins
  this firmware never touches)
- ESP32-P4NRW32 (16 MB flash, 32 MB PSRAM), EK79007 1024×600 MIPI-DSI IPS
  panel, GT911 touch
- Flashing always runs through the on-board CH340K USB-UART bridge on the port
  labeled `UART0`. Shipping hardware has been observed as `USB-SERIAL CH340K`
  (`1a86:7522`, for example COM6); the profile also retains `1a86:7523` for
  earlier documented CH340 variants. One UART0 connection normally supplies
  both power and data. The pre-installed ESP32-C6 radio module is not used.
- The port labeled `USB 2.0` is wired straight to the ESP32-P4's high-speed USB
  PHY, and Elecrow's stock firmware leaves it unused. From firmware `0.2.0`
  Stream32 enables it as a CDC-ACM link, so the same JSON protocol can run at
  USB 2.0 speed instead of 115200 baud. It enumerates as
  `Stream32 CrowPanel 10.1`, and its serial number is the board's device ID.
  Connect both cables and pick that port for the deck; artwork sync is roughly
  two orders of magnitude faster than over the bridge.

`ESP32-2432S028R`, the "Cheap Yellow Display" (profile
`esp32-2432s028r-ili9341`):

- This model number covers several boards whose panels differ, and the
  display controller cannot be detected from the chip ID. Community guidance
  maps a single micro-USB or USB-C board to ILI9341 and a two-connector board
  to ST7789, but that is a rule of thumb rather than a rule: a dual-connector
  board has been confirmed working on this profile. Try it and look at the
  screen. A panel driving with wrong colours is a settings problem, whereas a
  lit but blank panel means the init sequence did not take and the controller
  really is different.
- Colour inversion is off by default and switchable from the Devices page. A
  dark deck rendered as a white wash means inversion is on when this panel
  does not want it, which is the usual first thing to check.
- ESP32-WROOM-32 (4 MB flash, 520 KB SRAM, **no PSRAM**), ILI9341 240x320
  SPI panel rotated to 320x240 landscape, XPT2046 resistive touch, and a PWM
  backlight on GPIO21.
- Flashing and the deck protocol both run over the on-board USB-serial
  bridge. Shipping boards use a CH340 (`1a86:7523`) or a CH9102
  (`1a86:55d4`); the profile accepts either. These are generic bridge chips,
  so an attached CrowPanel can appear in the same port list and the right
  COM port has to be picked by hand.
- This is the smallest board in the fleet by a wide margin. Artwork for the
  visible page lives in internal DRAM instead of PSRAM, so the page budget
  is 12 keys in any shape up to 4 per axis, and the 2.19 MB deck partition
  pools 32 KB artwork slots rather than the 64 KB slots the 16 MB boards use.
- Resistive touch needs per-unit calibration. The self-test screen prints the
  raw ADC pair for each press; put those values in `BSP_TOUCH_RAW_*` in
  `firmware/components/cyd_bsp/cyd_bsp.c`.

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
offset `0x0`, and the bootloader (with its `0xE9` magic byte) sits wherever
the chip's ROM expects it inside that image: `0x0` on the ESP32-S3, `0x1000`
on the classic ESP32, and `0x2000` on the ESP32-P4.

### Desktop flashing behavior

The CrowPanel and Cheap Yellow Display profiles prefer 921600 baud. If that
attempt fails, the desktop disconnects the failed loader and restarts the
complete image write once at 460800 baud, which is also the default for
boards that state no preference. Normal flashing sector-erases
only the verified merged-image range, preserving the CrowPanel's dedicated
11.94 MB `deck` partition. The advanced **Full erase (slow troubleshooting)**
option is off by default and deliberately erases the entire chip, including
saved layouts and artwork.

For the CrowPanel, connect UART0 with a known-good USB data cable. Close serial
monitors, install the current WCH CH340 driver if Windows does not expose the
COM port reliably, and try a shorter cable or different direct USB port if the
automatic 460800 fallback also fails. Flashing never uses the USB 2.0 port: the
P4's USB Serial/JTAG pins are taken by other functions on this board, so the
bootloader is only reachable over UART0. Leaving USB 2.0 connected during a
flash is fine and steadies a power-limited panel.

### Deck sync performance

Over a UART bridge the runtime protocol stays at 115200 baud for
compatibility, which is the dominant cost of a cold sync: one 2688-byte image
chunk needs about 320 ms of wire time, so a single 150 px key runs into
seconds. A CrowPanel synced over its USB 2.0 port instead spends microseconds
per chunk, and the remaining cost is the round trip for each `image-ack`.

The previous slow
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
board's serial link: the ESP32-S3's native USB Serial/JTAG port, the Cheap
Yellow Display's USB-serial bridge at a fixed 115200 baud, or on the
CrowPanel either its CH340 UART0 bridge at that same rate or its native
USB 2.0 CDC link. Image lines remain below 4096 bytes; the 40-key CrowPanel
accepts up to 8192 bytes for its larger single-line layouts.

The framing is identical on every link, so a board that answers on two ports
reports the same `deviceId` on both. Such firmware names its link in the hello
`features` as `transport-usb` or `transport-uart`, and the desktop keeps one
session per device on the highest-ranked link.

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
{"type":"display","awake":true,"idleTimeoutSeconds":600,"invert":true,"rotation":90}
{"type":"display","blankNow":true}
{"type":"calibrate","action":"start"}
```

Firmware messages:

```json
{"type":"hello","protocol":1,"boardId":"waveshare-esp32-s3-touch-lcd-4-v3","firmwareVersion":"0.2.9","deviceId":"aabbccddeeff","features":["display-control","display-blank","key-update","image-rle"]}
{"type":"pong","id":1}
{"type":"touch","phase":"down","x":120,"y":240}
{"type":"layout-ack","page":0,"rows":3,"cols":3,"keyPx":150,"needImages":[0,4]}
{"type":"image-ack","page":0,"index":0,"seq":0}
{"type":"key-update-ack","page":0,"index":0,"needImage":true}
{"type":"image-ack","page":0,"index":0,"seq":0,"mode":"ephemeral"}
{"type":"page","index":1}
{"type":"press","page":0,"index":4,"phase":"down"}
{"type":"calibrate-ack","action":"start"}
{"type":"calibrate","state":"done"}
{"type":"display","invert":true,"rotation":90}
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

### Touch calibration and colour inversion

Both settings live on the board in NVS, so a deck running without a computer
starts with the touch and colours it was last given, and both follow the board
to another machine. Only a **Full erase** reflash clears them.

`calibrate` starts or cancels the on-device wizard for firmware advertising
`touch-calibration`, and is acknowledged with `calibrate-ack`. The board then
shows four markers: three solve an affine transform from raw ADC counts to
screen pixels, and the fourth checks it. That one transform absorbs offset,
scale, axis swap, mirroring, and glass mounted slightly askew, which is why a
resistive panel needs no per-board constants compiled in. A solve is rejected
when the three taps are near-collinear or the check tap lands more than 10
percent of the short edge from its marker, and the previous calibration
survives. The board reports `{"type":"calibrate","state":...}` as `done`,
`failed`, or `cancelled`; a wizard nobody finishes times out after a minute
rather than owning the screen. Capacitive GT911 boards report screen
coordinates already and answer `calibrate-unsupported`.

The optional `rotation` field on `display` turns the screen by 0, 90, 180 or
270 degrees for firmware advertising `display-rotation`, so a board can be
mounted in any orientation. The grid re-flows to the new shape, which changes
`keyPx` and makes the desktop re-send every icon on the next `layout-ack`.
Touch follows without recalibration: the transform is stored against the
panel's unrotated orientation and turned on the way out.

Rotation needs `esp_lcd_panel_swap_xy`, which the RGB and MIPI-DSI panel
drivers do not implement, so only the Cheap Yellow Display offers it today.

The optional `invert` field on `display` flips the panel's colour inversion
for firmware advertising `display-invert`. The same board model ships with
panels that disagree about this, so a screen that looks like a photographic
negative is fixed from the Devices page rather than by rebuilding. Because the
board owns the stored value, it announces `{"type":"display","invert":...}`
after every hello so the desktop toggle shows the real position.

The optional `iconSize` field on `display` insets artwork inside its key, as a
percentage of the tile from 25 to 100, for firmware advertising
`display-icon-size`. Tiles always stretch to fill the screen, so a sparse page
on a small panel gives every key a large icon; this shrinks the picture while
the tile and its label stay where the grid put them. `layout-ack` reports the
inset size rather than the tile, because the host renders pixels at the size
they are drawn, so changing it re-sends every icon the same way rotation does.

All three of these live in NVS, which sits past the app partition so a
firmware update cannot erase it. A single raw image is written from offset 0,
and everything below the end of the app is overwritten, gaps included.

### Display protection

Firmware turns the display off after 10 minutes without touch activity by
default. The desktop can change that interval with the additive `display`
message when the firmware hello advertises `display-control`. `awake:false`
forces the display to remain off while the host is locked; `awake:true` wakes
it and restores normal idle timing. `idleTimeoutSeconds` is bounded to
0-86400. Firmware advertising `display-blank` also accepts the separate
`{"type":"display","blankNow":true}` command used by the Sleep action. It
blanks immediately without entering host-forced sleep.

Touch stays active while the display is off. The first touch after an idle
timeout or Sleep action only wakes the display and does not press a deck key.
Touches remain
consumed during host-forced sleep, so locked computers cannot run key actions.
The optional `brightness` field is bounded to 0-100 and is sent only when hello
also advertises `display-brightness`. The global desktop brightness setting
therefore controls the Elecrow PWM backlight and is restored after idle or lock
sleep. CrowPanel blanking keeps its EK79007/DSI and LVGL touch polling active
while switching off the power-dominant PWM backlight, so an idle wake touch is
reliable. Waveshare Rev 3 does not advertise brightness because its current
BSP has no software-controlled backlight pin; idle and lock still blank its
ST7701 image, although the backlight may remain lit.

The firmware persists layouts and artwork to the dedicated `deck` flash
partition (header last, CRC-checked), so a standalone device boots straight
into its deck. Artwork is pooled by CRC and garbage-collected after each
full sync.

The shared component keeps wire decoding, strict bounds/UTF-8/hex checks,
ACK formatting, and image sequencing in `deck_protocol.c`. Its typed calls
leave LVGL objects and locking, the page model, display policy, persistent
storage decisions, and live-overlay pixel ownership in `deck_ui.c`.

## Flash recovery

Use a USB data cable and close other serial monitors before flashing. Connect
the CrowPanel through UART0; the USB 2.0 port cannot reach the bootloader.
If automatic bootloader entry fails:

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
