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
  }

  assert.match(
    read(componentPath('CMakeLists.txt')),
    /SRCS "deck_protocol\.c" "deck_storage\.c" "deck_ui\.c"/,
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
