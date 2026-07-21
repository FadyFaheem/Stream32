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

The initial profile supports only:

- Waveshare `ESP32-S3-Touch-LCD-4`
- Silkscreen hardware revision `3.0`
- ESP32-S3 N16R8, ST7701 480×480 LCD, GT911 touch, and TCA9554 I/O expander
- The native USB Serial/JTAG connection (`303a:1001`)

The similarly named 4.3-inch board and hardware Rev 4 are different devices.
Do not select the Rev3 profile for either one.

The ESP32-S3 ROM reports the chip family but cannot identify the attached
display or PCB revision. The desktop app verifies `ESP32-S3` before erasing;
the user-visible silkscreen confirmation is therefore the final board-revision
safety check.

## Build the Rev3 firmware

Install ESP-IDF 5.4.4, activate its environment, then run:

```sh
cd boards/waveshare-esp32-s3-touch-lcd-4-v3/firmware
bash ../../tools/build-firmware.sh
```

The helper reads the versioned image name from `board.json` and writes the
merged factory image to `boards/dist/`. The merged image is flashed at
offset `0x0`.

## Add or update a board

1. Create a lowercase, stable board directory containing `board.json` and an
   ESP-IDF project.
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
ESP32-S3 USB Serial/JTAG port. Lines are limited to 4096 bytes on both
sides.

Desktop messages:

```json
{"type":"hello","protocol":1}
{"type":"ping","id":1}
{"type":"layout","page":0,"of":2,"rows":3,"cols":3,"keys":[{"index":0,"label":"OBS","color":"#ff5533","imageCrc":"9a3f11d2","goPage":1}]}
{"type":"image","page":0,"index":0,"seq":0,"of":13,"w":150,"h":150,"data":"<base64 RGB565>"}
{"type":"page","index":1}
```

Firmware messages:

```json
{"type":"hello","protocol":1,"boardId":"waveshare-esp32-s3-touch-lcd-4-v3","firmwareVersion":"0.2.0","deviceId":"aabbccddeeff"}
{"type":"pong","id":1}
{"type":"touch","phase":"down","x":120,"y":240}
{"type":"layout-ack","page":0,"rows":3,"cols":3,"keyPx":150,"needImages":[0,4]}
{"type":"image-ack","page":0,"index":0,"seq":0}
{"type":"page","index":1}
{"type":"press","page":0,"index":4,"phase":"down"}
```

The desktop does not mark a port connected until the hello response has the
expected protocol, a catalog board ID, a semantic firmware version, and a
valid MAC-derived device ID.

### Deck messages

The deck extension is additive to protocol 1; firmware without it answers
`error: unknown-type` and the desktop reports that a reflash is needed.

- `layout` describes one page of the desired deck state (up to 8 pages of
  1–5 × 1–5 keys). The desktop pushes every page in order after each
  handshake or edit. `imageCrc` is the CRC-32 of the key's rendered RGB565
  pixels; `goPage` marks a navigation key the firmware handles locally so
  page switching works without a host.
- `layout-ack` reports `keyPx`, the on-screen key size in pixels. The host
  renders artwork at exactly that size, which keeps the protocol
  resolution-independent across board types. `needImages` lists only the
  keys whose artwork is missing from the device's flash pool, so a
  steady-state reconnect streams nothing.
- `image` chunks stream RGB565 artwork base64-encoded, stop-and-wait: the
  desktop sends the next chunk only after the matching `image-ack`. The
  final chunk is verified against `imageCrc` and persisted.
- `page` selects the visible page. The firmware also emits it when a
  `goPage` key switches pages locally.
- `press` reports key touches with their page so the desktop can run the
  configured action.

The firmware persists layouts and artwork to the dedicated `deck` flash
partition (header last, CRC-checked), so a standalone device boots straight
into its deck. Artwork is pooled by CRC and garbage-collected after each
full sync.

## Flash recovery

Use a USB data cable and close other serial monitors before flashing. If
automatic bootloader entry fails:

1. Disconnect power.
2. Hold **BOOT** while reconnecting USB, then release **BOOT**.
3. Flash again.
4. After a successful flash, press **RESET** or reconnect power.

Flashing is destructive and erases the board's existing contents.
