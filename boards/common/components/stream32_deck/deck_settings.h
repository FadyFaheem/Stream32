// Small persistent device settings that must survive a reboot and apply
// before any host connects: the resistive touch calibration and the panel
// colour inversion.
//
// These live in NVS rather than the deck partition. The deck header is
// CRC'd over a fixed layout with two spare bytes, so growing it would
// invalidate every saved deck on upgrade.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "deck_affine.h"
#include "esp_err.h"

// Artwork may shrink to a quarter of its tile but no further: below that the
// picture is unreadable, and layout-ack's keyPx has a floor of 16 px.
#define DECK_ICON_PERCENT_MIN 25

#ifdef __cplusplus
extern "C" {
#endif

// Mounts NVS. Safe to call more than once. A corrupt or outgrown partition
// is erased and remounted, which costs the stored settings but never blocks
// startup.
esp_err_t deck_settings_init(void);

// Pushes whatever has been stored into the BSP. Anything absent leaves the
// board's compiled-in default alone.
void deck_settings_apply(void);

// Reads the stored calibration. Returns false when none has been saved, when
// it is the wrong size, or when NVS is unavailable.
bool deck_settings_get_calibration(float coefficients[DECK_CALIBRATION_COEFFICIENTS]);

esp_err_t deck_settings_set_calibration(
    const float coefficients[DECK_CALIBRATION_COEFFICIENTS]
);

// Reads the stored colour inversion into *invert. Returns false when nothing
// has been stored, which leaves the board's compiled-in default standing.
bool deck_settings_get_invert(bool *invert);
esp_err_t deck_settings_set_invert(bool invert);

// Display rotation in degrees clockwise: 0, 90, 180 or 270. Same contract as
// invert; nothing stored leaves the board's own orientation alone.
bool deck_settings_get_rotation(uint16_t *degrees);
esp_err_t deck_settings_set_rotation(uint16_t degrees);

// Artwork size as a percentage of the key tile, from DECK_ICON_PERCENT_MIN to
// 100. Unlike the others this is not a BSP setting, so deck_ui reads it at
// startup rather than deck_settings_apply pushing it anywhere.
bool deck_settings_get_icon_percent(uint8_t *percent);
esp_err_t deck_settings_set_icon_percent(uint8_t percent);

#ifdef __cplusplus
}
#endif
