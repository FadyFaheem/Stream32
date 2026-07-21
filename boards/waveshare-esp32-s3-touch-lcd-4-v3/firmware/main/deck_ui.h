// LVGL deck grid driven by the desktop's layout/image/page messages and by
// the persisted state in deck_storage. Presses and local page switches are
// reported through the notify callback as ready-to-send JSON lines.
#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "cJSON.h"
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

// Message handlers return NULL on success or a short error code for the
// protocol error reply. On success, reply (when non-NULL) holds a JSON
// line to send back.
const char *deck_ui_handle_layout(
    const cJSON *message,
    const char *raw_line,
    size_t raw_length,
    char *reply,
    size_t reply_capacity
);
const char *deck_ui_handle_image(
    const cJSON *message,
    char *reply,
    size_t reply_capacity
);
const char *deck_ui_handle_page(const cJSON *message);

#ifdef __cplusplus
}
#endif
