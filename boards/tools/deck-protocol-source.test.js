const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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

test('both board transports dispatch through the shared protocol module', () => {
  const boards = [
    'waveshare-esp32-s3-touch-lcd-4-v3',
    'elecrow-crowpanel-advanced-10-1-esp32-p4',
  ];

  for (const board of boards) {
    const main = read(
      path.join(ROOT, 'boards', board, 'firmware', 'main', 'main.c'),
    );

    assert.match(main, /#include "deck_protocol\.h"/);
    assert.match(main, /deck_protocol_dispatch\(/);
    assert.match(main, /deck_protocol_clear_overlays\(/);
    assert.match(main, /display-blank/);
  }

  assert.match(
    read(componentPath('CMakeLists.txt')),
    /SRCS "deck_clean\.c" "deck_protocol\.c" "deck_storage\.c" "deck_ui\.c"/,
  );
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
  assert.match(handleTouch, /^\s*if \(s_clean_active \|\| s_forced_asleep\) \{\s*return true;/m);

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

  for (const board of [
    'waveshare-esp32-s3-touch-lcd-4-v3',
    'elecrow-crowpanel-advanced-10-1-esp32-p4',
  ]) {
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
  assert.match(ui, /Labels stay above artwork[\s\S]*lv_obj_move_to_index\(image, 0\)/);
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
