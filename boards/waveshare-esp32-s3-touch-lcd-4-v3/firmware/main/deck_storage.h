// Persistence for deck layouts and key artwork on the raw "deck" flash
// partition, so a powered device shows its deck without the desktop.
//
// Partition layout (4 KB erase sectors):
//   sector 0        main header: page count, active page, image slot table
//   sectors 1..8    one layout JSON per page
//   sector 9+       pool of 64 KB image slots keyed by CRC32 of the pixels
//
// Writes are ordered slots -> page sectors -> header, so a power cut leaves
// an invalid header and the device falls back to the self-test screen.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define DECK_MAX_PAGES 8
#define DECK_MAX_KEYS 25
#define DECK_MAX_SLOTS 190
#define DECK_SLOT_BYTES 0x10000
#define DECK_PAGE_JSON_CAPACITY 4084

#ifdef __cplusplus
extern "C" {
#endif

// Loads the header (or starts blank when missing/corrupt). Returns
// ESP_ERR_NOT_FOUND when the deck partition is absent from the table.
esp_err_t deck_storage_init(void);

bool deck_storage_has_state(void);
uint8_t deck_storage_page_count(void);
uint8_t deck_storage_active_page(void);

// Reads a stored page layout JSON. Returns false when the page is missing
// or fails its CRC.
bool deck_storage_read_page_json(
    uint8_t page,
    char *out,
    size_t capacity,
    size_t *length_out
);

// Persists one page's layout JSON and the page count. Skips flash writes
// when the stored bytes already match.
esp_err_t deck_storage_write_page_json(
    uint8_t page,
    const char *json,
    size_t length,
    uint8_t page_count
);

// Persists the active page shown at boot (no-op when unchanged).
esp_err_t deck_storage_set_active_page(uint8_t page);

bool deck_storage_slot_find(uint32_t crc, uint32_t *size_out);
esp_err_t deck_storage_slot_read(uint32_t crc, uint8_t *out, uint32_t size);
esp_err_t deck_storage_slot_write(
    uint32_t crc,
    const uint8_t *data,
    uint32_t size
);

// Drops pool slots whose CRC is not in the live set (runs after a full
// sync so replaced artwork stops occupying slots).
void deck_storage_gc(const uint32_t *live_crcs, size_t live_count);

#ifdef __cplusplus
}
#endif
