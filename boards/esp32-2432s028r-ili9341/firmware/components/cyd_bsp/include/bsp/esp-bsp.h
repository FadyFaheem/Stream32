/*
 * ESP32-2432S028R "Cheap Yellow Display" BSP.
 *
 * ST7789 240x320 panel driven over SPI2 and rotated to 320x240 landscape,
 * XPT2046 resistive touch on its own SPI3 bus, and a PWM backlight.
 *
 * The profile id still says ILI9341, which is what these boards are sold as.
 * The panel in this batch is an ST7789, and its driver is what actually
 * initialises the glass correctly.
 *
 * The display and touch controllers sit on separate buses on this board, so
 * neither needs bus sharing. The micro-SD slot shares nothing with either and
 * is left alone.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "lvgl.h"

/* Six affine coefficients: x = a*raw_x + b*raw_y + c, y = d*raw_x + e*raw_y
   + f. Matches DECK_CALIBRATION_COEFFICIENTS in the shared deck component,
   which the array parameter below decays to a pointer for anyway. */
#define BSP_TOUCH_CALIBRATION_COEFFICIENTS 6

/* The panel's own orientation, which is also the space touch calibration is
   stored in. Turning the deck to landscape is a rotation applied on top of
   this rather than a different base, so a calibration outlives a change of
   orientation. */
#define BSP_LCD_H_RES (240)
#define BSP_LCD_V_RES (320)

/* Panel on SPI2 ("HSPI" in the board's Arduino documentation). Its
   reset line is tied to the board reset, so there is no GPIO for it, and the
   driver falls back to a software reset.

   The panel's MISO is wired to GPIO12, which is also the MTDI strapping pin
   that selects the flash voltage at boot. Nothing here reads the panel back,
   so the bus deliberately leaves MISO unclaimed rather than reconfiguring a
   strapping pin for no benefit. */
#define BSP_LCD_SPI_MOSI (13)
#define BSP_LCD_SPI_SCLK (14)
#define BSP_LCD_SPI_CS (15)
#define BSP_LCD_DC (2)

/* XPT2046 on SPI3 ("VSPI"). */
#define BSP_TOUCH_SPI_MOSI (32)
#define BSP_TOUCH_SPI_MISO (39)
#define BSP_TOUCH_SPI_SCLK (25)
#define BSP_TOUCH_SPI_CS (33)
#define BSP_TOUCH_INT (36)

/* Backlight PWM */
#define BSP_LCD_BACKLIGHT (21)

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Power the panel, start LVGL, attach the touch input, and turn the
 *        backlight on. Returns NULL when any stage fails.
 */
lv_display_t *bsp_display_start(void);

/**
 * @brief Current display startup stage, suitable for protocol diagnostics.
 */
const char *bsp_display_status(void);

/**
 * @brief Take the LVGL lock before touching any LVGL object from a task.
 */
bool bsp_display_lock(uint32_t timeout_ms);

void bsp_display_unlock(void);

/**
 * @brief Blank or restore the backlight without stopping touch or panel output.
 */
esp_err_t bsp_display_set_awake(bool awake);

/**
 * @brief Set and remember the backlight brightness from 0 to 100 percent.
 */
esp_err_t bsp_display_set_brightness(uint32_t brightness_percent);

/**
 * @brief Blank or restore colour inversion. The same model number ships with
 *        panels that disagree about this, so it is settable at runtime.
 */
esp_err_t bsp_display_set_invert(bool invert);

bool bsp_display_invert(void);

/**
 * @brief Rotate the display by 0, 90, 180 or 270 degrees clockwise.
 *
 * The panel is 240x320 portrait glass, so the deck runs in whichever
 * orientation the board is mounted. Touch follows without recalibration
 * because the stored transform is in unrotated coordinates.
 */
esp_err_t bsp_display_set_rotation(uint16_t degrees);

uint16_t bsp_display_rotation(void);

/**
 * @brief Mirror the panel's own x and/or y axis, on top of the rotation.
 *
 * Rotation alone reaches four of the eight ways a panel can be addressed.
 * These two flips reach the other four, which is what a board wired to
 * display everything mirrored needs. Touch is mirrored to match, so a saved
 * calibration stays valid.
 */
esp_err_t bsp_display_set_flip(bool flip_x, bool flip_y);

void bsp_display_flip(bool *flip_x, bool *flip_y);

/**
 * @brief Last raw 12-bit touch sample, before calibration is applied, and
 *        whether a touch is currently down.
 *
 * Sourced from the LVGL read callback rather than a fresh conversion, so the
 * calibration wizard never opens a second reader on the shared SPI bus.
 */
bool bsp_touch_read_raw(uint16_t *raw_x, uint16_t *raw_y);

/**
 * @brief Installs the solved affine transform, or restores the approximate
 *        built-in map when @p coefficients is NULL.
 */
esp_err_t bsp_touch_set_calibration(
    const float coefficients[BSP_TOUCH_CALIBRATION_COEFFICIENTS]
);

#ifdef __cplusplus
}
#endif
