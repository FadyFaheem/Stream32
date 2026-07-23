// Decodes the deck extension's JSON messages and drives the typed UI API.
// Transport framing, hello/ping, and physical writes remain board-specific.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "sdkconfig.h"

#define DECK_PROTOCOL_LABEL_CAPACITY 33
#define DECK_PROTOCOL_MAX_KEYS CONFIG_STREAM32_DECK_MAX_KEYS

struct cJSON;

typedef struct {
    bool used;
    bool has_color;
    bool has_label_color;
    int8_t go_page;
    uint32_t color;
    uint32_t label_color;
    uint32_t image_crc;
    char label[DECK_PROTOCOL_LABEL_CAPACITY];
} deck_protocol_key_t;

typedef struct {
    uint8_t page;
    uint8_t page_count;
    uint8_t rows;
    uint8_t cols;
    deck_protocol_key_t keys[DECK_PROTOCOL_MAX_KEYS];
} deck_protocol_layout_t;

typedef struct {
    uint8_t page;
    uint8_t index;
    bool clear;
    bool has_color;
    bool has_label_color;
    uint8_t state;
    uint32_t color;
    uint32_t label_color;
    uint32_t image_crc;
    char label[DECK_PROTOCOL_LABEL_CAPACITY];
} deck_protocol_key_update_t;

typedef struct {
    bool awake;
    bool has_brightness;
    uint32_t idle_timeout_seconds;
    uint8_t brightness_percent;
} deck_protocol_display_t;

typedef void (*deck_protocol_send_fn)(const char *json_line);

#ifdef __cplusplus
extern "C" {
#endif

// Restores one persisted layout through the same strict decoder used for
// host messages, without writing it back to flash.
const char *deck_protocol_restore_layout(
    const char *json,
    size_t length,
    uint8_t expected_page
);

// Handles layout/image/key-update/page/display and sends ACKs through the
// board transport callback. Returns false only for an unknown message type;
// handled failures are returned through error_out.
bool deck_protocol_dispatch(
    const struct cJSON *message,
    const char *raw_line,
    size_t raw_length,
    char *reply,
    size_t reply_capacity,
    deck_protocol_send_fn send,
    const char **error_out
);

// Clears RAM-only live state at handshake boundaries. Returns false if the
// UI could not acquire its display lock; no overlay state is then changed.
bool deck_protocol_clear_overlays(void);

#ifdef __cplusplus
}
#endif
