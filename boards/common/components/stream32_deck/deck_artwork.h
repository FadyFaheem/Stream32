// The visible page's key artwork held in RAM, plus the LVGL descriptors that
// point at it.
//
// Split out of deck_ui because it answers a different question: deck_ui
// decides what the grid looks like, this decides which pixels are resident
// and keeps LVGL from reading a buffer that has been freed.
#pragma once

#include <stdint.h>

#include "deck_storage.h"
#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

// Frees every resident buffer. Call with the display lock held and only
// after the LVGL objects referencing them are gone, which in practice means
// straight after lv_obj_clean on the deck screen.
void deck_artwork_release(void);

// Loads whatever the pool holds for each CRC, skipping zeros and anything
// stored at a different size. Boards without PSRAM keep the whole visible
// page in internal DRAM, so a key that will not fit is simply left without
// artwork rather than failing the page.
void deck_artwork_load(const uint32_t *crcs, int count, int key_px);

// Resident pixels for one key, or NULL when it has none.
const uint8_t *deck_artwork_pixels(int index);

// Adds an image child showing `pixels` at `key_px`, below any label.
void deck_artwork_attach(
    lv_obj_t *parent,
    int index,
    int key_px,
    const uint8_t *pixels
);

#ifdef __cplusplus
}
#endif
