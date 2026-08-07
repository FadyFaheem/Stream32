// Where the deck grid sits, and how big its tiles and artwork are.
//
// Screen size is read from LVGL rather than Kconfig because it changes with
// display rotation. The grid builder, the cleaning overlay and the
// calibration overlay all need the same answers, so they are asked in one
// place instead of each keeping its own copy.
#pragma once

#include <stdint.h>

// Space between tiles, and between the outermost tiles and the screen edge.
#define DECK_KEY_GAP 8

#ifdef __cplusplus
extern "C" {
#endif

// Post-rotation screen size, straight from LVGL.
int32_t deck_layout_screen_w(void);
int32_t deck_layout_screen_h(void);

// Side of one key tile on a grid of this shape.
int deck_layout_key_px(int rows, int cols);

// Side of the artwork drawn inside that tile. This, not the tile, is what
// layout-ack reports, because the host renders pixels at the size they will
// be drawn at.
int deck_layout_icon_px(int rows, int cols);

// Top-left corner of the centred grid.
void deck_layout_grid_origin(int rows, int cols, int *x, int *y);

// Artwork size as a percentage of the tile, 100 filling it as it always did.
// Out-of-range values are ignored rather than clamped, so a bad stored byte
// cannot quietly resize every icon.
uint8_t deck_layout_icon_percent(void);
void deck_layout_set_icon_percent(uint8_t percent);

#ifdef __cplusplus
}
#endif
