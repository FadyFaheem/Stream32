// LVGL deck grid driven by the desktop's layout/image/page messages and by
// the persisted state in deck_storage. Presses and local page switches are
// reported through the notify callback as ready-to-send JSON lines.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "deck_protocol.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*deck_notify_fn)(const char *json_line);

// Restores the persisted deck (when present) and shows it. The notify
// callback runs in LVGL task context and must only queue the line.
esp_err_t deck_ui_init(deck_notify_fn notify);

// True once a deck layout is on screen instead of the self-test UI.
bool deck_ui_active(void);

// Runs deferred work (local goPage switches) outside LVGL context. Call
// regularly from the USB protocol task.
void deck_ui_poll(void);
// Returns false without changing overlay state when the display lock is busy.
bool deck_ui_clear_overlays(void);

// Records a touch edge and returns true when firmware must consume it. The
// first touch wakes an idle display; host-forced sleep consumes every touch.
bool deck_ui_handle_touch(bool pressed);

// Narrow typed operations used by deck_protocol after JSON validation.
const char *deck_ui_apply_layout(
    const deck_protocol_layout_t *layout,
    const char *raw_line,
    size_t raw_length
);
void deck_ui_restore_layout(const deck_protocol_layout_t *layout);
int deck_ui_key_px(uint8_t rows, uint8_t cols);
bool deck_ui_image_needed(uint32_t crc, uint32_t expected_size);
const char *deck_ui_apply_key_update(
    const deck_protocol_key_update_t *update,
    bool *need_image
);
const char *deck_ui_get_image_target(
    uint8_t page,
    uint8_t index,
    bool ephemeral,
    uint16_t *key_px,
    uint32_t *expected_crc
);
const char *deck_ui_commit_image(
    uint8_t page,
    uint8_t index,
    bool ephemeral,
    const uint8_t *pixels,
    uint32_t size
);
const char *deck_ui_select_page(uint8_t page);
const char *deck_ui_apply_display(const deck_protocol_display_t *display);

#ifdef __cplusplus
}
#endif
