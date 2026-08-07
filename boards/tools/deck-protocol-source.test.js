const assert = require('node:assert/strict');
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function headerFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);

    if (statSync(full).isDirectory()) {
      return headerFiles(full);
    }

    return entry.endsWith('.h') ? [full] : [];
  });
}

const ROOT = path.resolve(__dirname, '..', '..');
const componentPath = (...parts) =>
  path.join(
    ROOT,
    'boards',
    'common',
    'components',
    'stream32_deck',
    ...parts,
  );
const read = (file) => readFileSync(file, 'utf8');
const protocol = read(componentPath('deck_protocol.c'));
const ui = read(componentPath('deck_ui.c'));
const clean = read(componentPath('deck_clean.c'));
const storage = read(componentPath('deck_storage.c'));
const calibrate = read(componentPath('deck_calibrate.c'));
const artwork = read(componentPath('deck_artwork.c'));

test('protocol decoding and image sequencing stay outside the LVGL UI', () => {
  assert.match(protocol, /static bool valid_utf8\(/);
  assert.match(protocol, /static bool parse_hex\(/);
  assert.match(protocol, /static bool valid_base64\(/);
  assert.match(protocol, /image_sequence_t s_image_sequence/);
  assert.match(protocol, /mbedtls_base64_decode/);
  assert.match(protocol, /esp_rom_crc32_le/);
  assert.match(protocol, /DECK_MAX_ENCODED_CHUNK_BYTES 2688/);
  assert.match(protocol, /static uint8_t s_encoded_chunk\[/);
  assert.match(protocol, /strcmp\(encoding->valuestring, "rle565"\)/);
  assert.match(protocol, /decoded == 0 \|\| decoded % 4 != 0/);
  assert.match(protocol, /count == 0[\s\S]*count >[\s\S]*\/ 2/);
  assert.match(protocol, /return abort_image\("image-rle-invalid"\)/);
  assert.match(
    protocol,
    /reset_image_sequence[\s\S]*heap_caps_free\(s_staging\)/,
  );
  assert.match(protocol, /layout-ack/);
  assert.match(protocol, /key-update-ack/);
  assert.match(protocol, /image-ack/);

  assert.doesNotMatch(ui, /\bcJSON\b/);
  assert.doesNotMatch(ui, /mbedtls_base64_decode|esp_rom_crc32_le/);
  assert.doesNotMatch(ui, /\bs_staging\b|s_staging_expected_seq/);
  assert.ok(protocol.split(/\r?\n/).length < 1000);
  assert.ok(ui.split(/\r?\n/).length < 1000);
});

test('RLE decoding still commits raw pixels through existing storage ownership', () => {
  assert.match(
    protocol,
    /esp_rom_crc32_le\(0, s_staging, total_size\)[\s\S]*deck_ui_commit_image\(/,
  );
  assert.doesNotMatch(protocol, /deck_storage_slot_write\(/);
  assert.match(
    ui,
    /deck_ui_commit_image[\s\S]*deck_storage_slot_write\(key->image_crc, pixels, size\)/,
  );
});

test('artwork allocation falls back to internal RAM on boards without PSRAM', () => {
  // A bare MALLOC_CAP_SPIRAM allocation returns NULL on the classic ESP32,
  // which would fail every image with image-no-memory.
  for (const source of [protocol, artwork]) {
    assert.doesNotMatch(source, /heap_caps_malloc\([^)]*MALLOC_CAP_SPIRAM/);
    assert.match(
      source,
      /heap_caps_malloc_prefer\([\s\S]{0,120}MALLOC_CAP_SPIRAM,\s*MALLOC_CAP_INTERNAL \| MALLOC_CAP_8BIT/,
    );
  }
});

test('the artwork pool is bounded by the partition, not by the slot table', () => {
  const slotWrite = storage.slice(
    storage.indexOf('esp_err_t deck_storage_slot_write('),
    storage.indexOf('void deck_storage_gc('),
  );

  // DECK_MAX_SLOTS is sized for the 16 MB boards, so a 4 MB board would
  // otherwise address pool slots past the end of its deck partition.
  assert.match(
    slotWrite,
    /offset \+ erase_bytes > s_partition->size[\s\S]{0,60}ESP_ERR_NO_MEM/,
  );
  assert.ok(
    slotWrite.indexOf('s_partition->size') <
      slotWrite.indexOf('esp_partition_erase_range'),
    'the bound must be checked before erasing',
  );
  assert.match(storage, /The largest key must fit one flash pool slot/);
});

test('the calibration overlay owns only its own screen', () => {
  // Same boundary the cleaning overlay keeps: no deck grid, no storage, no
  // protocol decoding.
  assert.doesNotMatch(calibrate, /deck_storage_|s_pages|deck_protocol_/);
  assert.doesNotMatch(calibrate, /\bcJSON\b/);
  assert.ok(calibrate.split(/\r?\n/).length < 1000);

  // Taps are read from the BSP, not from LVGL, because the transform being
  // replaced is the one LVGL's coordinates come from.
  assert.match(calibrate, /bsp_touch_read_raw\(&raw_x, &raw_y\)/);
  assert.doesNotMatch(calibrate, /lv_indev_/);

  // A wizard nobody finishes must hand the screen back on its own.
  assert.match(calibrate, /CALIBRATE_TIMEOUT_MS\)[\s\S]{0,120}cancelled/);

  // The outcome latches so a busy display lock only delays the handover.
  assert.match(calibrate, /if \(s_outcome != NULL\) \{\s*return s_outcome;/);

  // Only a verified solve is allowed to replace a working calibration.
  assert.match(
    calibrate,
    /DECK_CALIBRATE_DONE[\s\S]{0,200}bsp_touch_set_calibration\([\s\S]{0,80}deck_settings_set_calibration/,
  );

  // The prompt changes length between targets, so it is centred by being
  // full width rather than by a one-shot align that would strand it at the
  // offset worked out for the previous string.
  assert.doesNotMatch(calibrate, /lv_obj_align_to\(s_prompt/);
  assert.match(
    calibrate,
    /lv_obj_set_width\(s_prompt, lv_pct\(100\)\)[\s\S]{0,200}LV_TEXT_ALIGN_CENTER/,
  );

  // Markers are unrotated before solving so turning the screen afterwards
  // does not silently invalidate the calibration.
  assert.match(calibrate, /deck_affine_unrotate\(/);
  assert.match(
    calibrate,
    /unrotated_target\([\s\S]{0,400}deck_affine_solve\(/,
  );
});

test('every bsp_ call in a board main.c is declared by that board BSP', () => {
  // A renamed BSP function is otherwise only caught by the ESP-IDF build,
  // which needs a toolchain most contributors will not have to hand.
  for (const board of BOARDS) {
    const firmware = path.join(ROOT, 'boards', board, 'firmware');
    const main = read(path.join(firmware, 'main', 'main.c'));
    const headers = readdirSync(path.join(firmware, 'components'))
      .flatMap((component) => {
        const include = path.join(firmware, 'components', component, 'include');

        return existsSync(include) ? headerFiles(include) : [];
      })
      .map(read)
      .join('\n');
    const called = new Set(
      [...main.matchAll(/\b(bsp_[a-z0-9_]+)\s*\(/g)].map((hit) => hit[1]),
    );

    assert.ok(called.size > 0, `${board} calls no BSP functions`);

    for (const name of called) {
      assert.ok(
        headers.includes(name),
        `${board} main.c calls ${name}, which its BSP headers do not declare`,
      );
    }
  }
});

test('screen geometry is read live, not from Kconfig', () => {
  // The screen size changes with rotation, so a compile-time value would lay
  // the grid out for the wrong shape the moment the panel is turned.
  for (const source of [ui, clean, calibrate]) {
    assert.doesNotMatch(source, /CONFIG_STREAM32_DECK_SCREEN_/);
    assert.match(source, /lv_display_get_horizontal_resolution\(/);
    assert.match(source, /lv_display_get_vertical_resolution\(/);
  }

  assert.doesNotMatch(
    read(componentPath('Kconfig')),
    /config STREAM32_DECK_SCREEN_/,
  );
});

test('no board redoes a rotation the platform already applies', () => {
  // Rotation is applied for us in two places, and duplicating either half
  // fails silently. lvgl_port_add_disp writes the panel's MADCTL from its own
  // rotation config, so a swap_xy or mirror call in a BSP's init is discarded
  // and the board comes up in portrait with no error to show for it. LVGL's
  // indev_pointer_proc then turns every pointer sample by the display
  // rotation, using the same formula as deck_affine_rotate, so a BSP that
  // turns its own samples as well rotates each touch twice and leaves a
  // quarter of the screen unreachable.
  for (const board of BOARDS) {
    const components = path.join(ROOT, 'boards', board, 'firmware', 'components');

    for (const component of readdirSync(components)) {
      const directory = path.join(components, component);
      const sources = readdirSync(directory).filter((f) => f.endsWith('.c'));

      for (const file of sources) {
        const source = read(path.join(directory, file));

        assert.doesNotMatch(
          source,
          /esp_lcd_panel_(swap_xy|mirror)\s*\(/,
          `${board}/${component}/${file} sets rotation that lvgl_port overwrites`,
        );
        assert.doesNotMatch(
          source,
          /deck_affine_rotate\s*\(/,
          `${board}/${component}/${file} rotates touch that LVGL rotates again`,
        );
      }
    }
  }
});

test('every board answers the calibration and invert BSP contract', () => {
  const bsps = [
    ['waveshare-esp32-s3-touch-lcd-4-v3', 'waveshare_bsp/waveshare_bsp.c'],
    ['elecrow-crowpanel-advanced-10-1-esp32-p4', 'elecrow_bsp/elecrow_bsp.c'],
    ['esp32-2432s028r-ili9341', 'cyd_bsp/cyd_bsp.c'],
  ];

  // deck_ui declares these extern, so a board that omits one fails to link.
  for (const [board, source] of bsps) {
    const bsp = read(
      path.join(ROOT, 'boards', board, 'firmware', 'components', ...source.split('/')),
    );

    assert.match(bsp, /esp_err_t bsp_display_set_invert\(bool invert\)/);
    assert.match(bsp, /bool bsp_display_invert\(void\)/);
    assert.match(bsp, /esp_err_t bsp_display_set_rotation\(uint16_t degrees\)/);
    assert.match(bsp, /uint16_t bsp_display_rotation\(void\)/);
    assert.match(bsp, /bool bsp_touch_read_raw\(/);
    assert.match(bsp, /esp_err_t bsp_touch_set_calibration\(/);
  }
});

test('UI owns overlays and detaches LVGL images before freeing pixels', () => {
  const key = ui.match(/typedef struct \{([\s\S]*?)\} deck_key_t;/)?.[1];
  const overlay = ui.match(
    /typedef struct \{([\s\S]*?)\} deck_overlay_t;/,
  )?.[1];
  const liveUpdate = ui.slice(
    ui.indexOf('const char *deck_ui_apply_key_update('),
    ui.indexOf('const char *deck_ui_get_image_target('),
  );

  assert.ok(key);
  assert.ok(overlay);
  assert.doesNotMatch(key, /\bstate\b/);
  assert.match(overlay, /uint8_t state;/);
  assert.doesNotMatch(liveUpdate, /deck_storage_/);
  assert.match(
    liveUpdate,
    /bsp_display_lock[\s\S]*lv_obj_clean[\s\S]*heap_caps_free\(overlay->image\)[\s\S]*build_page_locked/,
  );
  assert.match(
    ui,
    /deck_ui_commit_image[\s\S]*heap_caps_malloc[\s\S]*lv_obj_clean[\s\S]*heap_caps_free\(overlay->image\)[\s\S]*overlay->image = owned_pixels/,
  );
});

const BOARDS = [
  'waveshare-esp32-s3-touch-lcd-4-v3',
  'elecrow-crowpanel-advanced-10-1-esp32-p4',
  'esp32-2432s028r-ili9341',
];

test('every board transport dispatches through the shared protocol module', () => {
  for (const board of BOARDS) {
    const main = read(
      path.join(ROOT, 'boards', board, 'firmware', 'main', 'main.c'),
    );

    assert.match(main, /#include "deck_protocol\.h"/);
    assert.match(main, /deck_protocol_dispatch\(/);
    assert.match(main, /deck_protocol_clear_overlays\(/);
    assert.match(main, /display-blank/);
  }

  const cmake = read(componentPath('CMakeLists.txt'));

  for (const source of [
    'deck_affine.c',
    'deck_artwork.c',
    'deck_calibrate.c',
    'deck_clean.c',
    'deck_protocol.c',
    'deck_settings.c',
    'deck_storage.c',
    'deck_ui.c',
  ]) {
    assert.match(cmake, new RegExp(`"${source.replace('.', '\\.')}"`));
  }
});

test('the CrowPanel serves both links without risking the flashing one', () => {
  const main = read(
    path.join(
      ROOT,
      'boards',
      'elecrow-crowpanel-advanced-10-1-esp32-p4',
      'firmware',
      'main',
      'main.c',
    ),
  );
  const usbTask = main.slice(
    main.indexOf('static void usb_protocol_task('),
    main.indexOf('static void serial_protocol_task('),
  );
  const uartTask = main.slice(
    main.indexOf('static void serial_protocol_task('),
    main.indexOf('static void touch_event_handler('),
  );

  // One assembler for both links: line limits and the oversized-line reply
  // cannot drift apart per transport.
  assert.match(usbTask, /consume_bytes\(&reader/);
  assert.match(uartTask, /consume_bytes\(&reader/);
  assert.doesNotMatch(usbTask, /handle_host_message\(/);
  assert.doesNotMatch(uartTask, /handle_host_message\(/);
  assert.match(
    main,
    /xSemaphoreTake\(protocol_mutex[\s\S]*handle_host_message\([\s\S]*xSemaphoreGive\(protocol_mutex\)/,
  );

  // UART0 is the only way to flash this board and the link the desktop holds
  // across a manual post-flash reset, so USB bring-up may never abort.
  assert.doesNotMatch(usbTask, /ESP_ERROR_CHECK\(\s*tinyusb/);
  assert.match(usbTask, /vTaskDelete\(NULL\)/);
  assert.match(uartTask, /ESP_ERROR_CHECK\(uart_driver_install\(/);

  // The desktop keeps one session per board by ranking the reported link.
  assert.match(main, /"transport-usb" : "transport-uart"/);
  assert.ok(main.split(/\r?\n/).length < 1000);
});

test('Sleep blanks through the idle wake path without changing lock state', () => {
  const blankDisplay = ui.slice(
    ui.indexOf('const char *deck_ui_blank_display('),
    ui.indexOf('const char *deck_ui_apply_display('),
  );

  assert.match(protocol, /"blankNow"[\s\S]*deck_ui_blank_display\(\)/);
  assert.match(blankDisplay, /set_panel_awake\(false\)/);
  assert.doesNotMatch(blankDisplay, /s_forced_asleep\s*=/);
});

test('the cleaning lock swallows the wipe and only a held exit lifts it', () => {
  const handleTouch = ui.slice(
    ui.indexOf('bool deck_ui_handle_touch('),
    ui.indexOf('static void copy_layout('),
  );
  const poll = ui.slice(
    ui.indexOf('void deck_ui_poll('),
    ui.indexOf('bool deck_ui_handle_touch('),
  );
  const buildPage = ui.slice(
    ui.lastIndexOf('static void build_page_locked('),
    ui.indexOf('static void build_page(', ui.lastIndexOf('static void build_page_locked(')),
  );

  // Consumed before anything routes a press to the host or a local goPage.
  // Both modal overlays are in the guard: neither a wipe nor a calibration
  // tap may reach a deck key.
  assert.match(
    handleTouch,
    /^\s*if \(s_clean_active \|\| s_calibrate_active \|\| s_forced_asleep\) \{\s*return true;/m,
  );

  // A sync arriving mid-wipe stages the grid behind the lock, never over it.
  assert.match(buildPage, /if \(!s_clean_active\) \{\s*lv_screen_load\(s_deck_screen\);/);

  // Releasing needs the display lock, which the LVGL press callback holds, so
  // the hold is settled from the protocol task and retried while it is busy.
  assert.match(
    poll,
    /s_clean_active && deck_clean_held\(now_ms\(\)\) &&\s*deck_ui_set_clean\(false\) == NULL[\s\S]*notify_line\([^)]*clean[^)]*active[^)]*false/,
  );
  assert.match(poll, /!s_clean_active && !s_forced_asleep[\s\S]*set_panel_awake\(false\)/);

  // The overlay owns only its own screen: no deck grid or storage reaches it.
  assert.match(clean, /#define DECK_CLEAN_HOLD_MS 5000/);
  assert.doesNotMatch(clean, /deck_storage_|s_pages|deck_protocol_/);
  assert.ok(clean.split(/\r?\n/).length < 1000);
  assert.match(protocol, /"clean-invalid"[\s\S]*deck_ui_set_clean\(wanted\)/);
  assert.match(protocol, /clean-ack/);

  for (const board of BOARDS) {
    const main = read(
      path.join(ROOT, 'boards', board, 'firmware', 'main', 'main.c'),
    );

    assert.match(main, /clean-mode/);
    // A lock outlives the link, so a reconnecting desktop is told about it.
    assert.match(
      main,
      /send_hello\(\);[\s\S]{0,400}deck_ui_clean_active\(\)[\s\S]{0,200}write_line\([^)]*clean[^)]*active[^)]*true/,
    );
  }
});

test('key labels stay on one ellipsized line above artwork', () => {
  const start = ui.lastIndexOf('static void build_page_locked(');
  const buildPage = ui.slice(start, ui.indexOf('static void build_page(', start));

  assert.match(
    buildPage,
    /lv_label_set_long_mode\(label_obj, LV_LABEL_LONG_DOT\);[\s\S]*lv_obj_set_width\(label_obj, key_px - 12\);[\s\S]*lv_obj_set_height\([\s\S]*lv_font_get_line_height\(LV_FONT_DEFAULT\)/,
  );
  assert.match(
    artwork,
    /Labels stay above artwork[\s\S]*lv_obj_move_to_index\(image, 0\)/,
  );
});

test('CrowPanel blanking keeps the touch and DSI pipeline alive', () => {
  const bsp = read(
    path.join(
      ROOT,
      'boards',
      'elecrow-crowpanel-advanced-10-1-esp32-p4',
      'firmware',
      'components',
      'elecrow_bsp',
      'elecrow_bsp.c',
    ),
  );
  const setAwake = bsp.slice(
    bsp.indexOf('esp_err_t bsp_display_set_awake('),
    bsp.indexOf('esp_err_t bsp_display_set_brightness('),
  );

  assert.match(setAwake, /backlight_set\(0\)/);
  assert.match(setAwake, /backlight_set\(s_brightness_percent\)/);
  assert.doesNotMatch(setAwake, /esp_lcd_panel_disp_on_off/);
});
