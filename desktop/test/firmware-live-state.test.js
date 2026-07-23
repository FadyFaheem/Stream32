const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const COMPONENT = path.resolve(
  __dirname,
  '..',
  '..',
  'boards',
  'common',
  'components',
  'stream32_deck',
);
const PROTOCOL_SOURCE = readFileSync(
  path.join(COMPONENT, 'deck_protocol.c'),
  'utf8',
);
const PROTOCOL_HEADER = readFileSync(
  path.join(COMPONENT, 'deck_protocol.h'),
  'utf8',
);
const UI_SOURCE = readFileSync(path.join(COMPONENT, 'deck_ui.c'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('firmware key updates never call persistent deck storage', () => {
  const decodeBody = sourceBetween(
    PROTOCOL_SOURCE,
    'static const char *handle_key_update(',
    'static const char *handle_image(',
  );
  const applyBody = sourceBetween(
    UI_SOURCE,
    'const char *deck_ui_apply_key_update(',
    'const char *deck_ui_get_image_target(',
  );

  assert.match(decodeBody, /deck_ui_apply_key_update\(&update, &need_image\)/);
  assert.doesNotMatch(decodeBody, /deck_storage_/);
  assert.match(applyBody, /s_overlays\[page_index\]\[key_index\]/);
  assert.doesNotMatch(applyBody, /deck_storage_/);
});

test('firmware ephemeral images have explicit RAM lifecycle', () => {
  const imageBody = sourceBetween(
    PROTOCOL_SOURCE,
    'static const char *handle_image(',
    'static const char *handle_page(',
  );
  const commitBody = sourceBetween(
    UI_SOURCE,
    'const char *deck_ui_commit_image(',
    'const char *deck_ui_select_page(',
  );

  assert.match(imageBody, /const bool ephemeral = mode != NULL;/);
  assert.match(
    imageBody,
    /deck_ui_commit_image\([\s\S]*ephemeral,[\s\S]*s_staging/,
  );
  assert.match(
    commitBody,
    /if \(!ephemeral\) \{[\s\S]*deck_storage_slot_write/,
  );
  assert.match(
    commitBody,
    /heap_caps_malloc\(size, MALLOC_CAP_SPIRAM\)[\s\S]*memcpy\(owned_pixels, pixels, size\)/,
  );
  assert.match(commitBody, /heap_caps_free\(overlay->image\)/);
  assert.match(commitBody, /overlay->image = owned_pixels;/);
  assert.match(UI_SOURCE, /deck_ui_clear_overlays\(\);/);
  assert.match(PROTOCOL_SOURCE, /if \(layout\.page == 0\)/);
  assert.match(UI_SOURCE, /DECK_OVERLAY_LEASE_MS/);
});

test('firmware live state belongs to the overlay compile type', () => {
  const key = UI_SOURCE.match(
    /typedef struct \{([\s\S]*?)\} deck_key_t;/,
  )?.[1];
  const overlay = UI_SOURCE.match(
    /typedef struct \{([\s\S]*?)\} deck_overlay_t;/,
  )?.[1];
  const update = PROTOCOL_HEADER.match(
    /typedef struct \{\s*uint8_t page;([\s\S]*?)\} deck_protocol_key_update_t;/,
  )?.[1];

  assert.ok(key);
  assert.ok(overlay);
  assert.ok(update);
  assert.doesNotMatch(key, /\bstate\b/);
  assert.match(overlay, /uint8_t state;/);
  assert.match(update, /uint8_t state;/);
  assert.match(PROTOCOL_SOURCE, /update\.state = [123];/);
  assert.match(
    UI_SOURCE,
    /deck_overlay_t parsed = \{ 0 \};[\s\S]*parsed\.state = update->state;/,
  );
});

test('firmware detaches visible LVGL images before freeing pixels', () => {
  const clearBody = sourceBetween(
    UI_SOURCE,
    'bool deck_ui_clear_overlays(',
    'static void build_page_locked(',
  );
  const keyUpdateBody = sourceBetween(
    UI_SOURCE,
    'const char *deck_ui_apply_key_update(',
    'const char *deck_ui_get_image_target(',
  );
  const commitBody = sourceBetween(
    UI_SOURCE,
    'const char *deck_ui_commit_image(',
    'const char *deck_ui_select_page(',
  );

  assert.match(
    clearBody,
    /bsp_display_lock[\s\S]*lv_obj_clean[\s\S]*heap_caps_free\(s_overlays[\s\S]*build_page_locked/,
  );
  assert.match(
    keyUpdateBody,
    /bsp_display_lock[\s\S]*lv_obj_clean[\s\S]*heap_caps_free\(overlay->image\)[\s\S]*build_page_locked/,
  );
  assert.match(
    commitBody,
    /const bool rebuild = s_active && page == s_visible_page;[\s\S]*bsp_display_lock[\s\S]*lv_obj_clean[\s\S]*heap_caps_free\(overlay->image\)[\s\S]*overlay->image = owned_pixels;[\s\S]*build_page_locked/,
  );
  assert.match(clearBody, /if \(rebuild && !bsp_display_lock\(1000\)\) \{\s*return false;/);
  assert.doesNotMatch(clearBody, /\bbuild_page\(/);
});

test('firmware validates each color and CRC character as hexadecimal', () => {
  const digitParser = sourceBetween(
    PROTOCOL_SOURCE,
    'static int hex_digit(',
    'static bool parse_hex(',
  );
  const hexParser = sourceBetween(
    PROTOCOL_SOURCE,
    'static bool parse_hex(',
    'static bool parse_color(',
  );
  const colorParser = sourceBetween(
    PROTOCOL_SOURCE,
    'static bool parse_color(',
    'static bool parse_crc(',
  );
  const crcParser = sourceBetween(
    PROTOCOL_SOURCE,
    'static bool parse_crc(',
    'static const char *decode_layout(',
  );

  assert.match(digitParser, /byte >= '0' && byte <= '9'/);
  assert.match(digitParser, /byte >= 'a' && byte <= 'f'/);
  assert.match(digitParser, /byte >= 'A' && byte <= 'F'/);
  assert.match(digitParser, /return -1;/);
  assert.match(
    hexParser,
    /hex_digit\(\(unsigned char\)text\[index\]\)[\s\S]*if \(digit < 0\)/,
  );
  assert.match(colorParser, /parse_hex\(value->valuestring, 1, 6, out\)/);
  assert.match(crcParser, /parse_hex\(value->valuestring, 0, 8, out\)/);
});
