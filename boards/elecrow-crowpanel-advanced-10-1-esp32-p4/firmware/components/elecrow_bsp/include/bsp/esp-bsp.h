/*
 * Elecrow CrowPanel Advanced 10.1" (ESP32-P4, model DHE04310D) BSP.
 *
 * EK79007 1024x600 IPS panel on 2-lane MIPI DSI, GT911 capacitive touch on
 * I2C0, and a PWM backlight. Pin assignments follow Elecrow's factory
 * sources and are identical across hardware revisions 1.0-1.2 (those
 * revisions only moved wireless-module pins this firmware never uses).
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "lvgl.h"

#define BSP_LCD_H_RES (1024)
#define BSP_LCD_V_RES (600)

/* GT911 touch controller */
#define BSP_I2C_SDA (45)
#define BSP_I2C_SCL (46)
#define BSP_TOUCH_RST (40)
#define BSP_TOUCH_INT (42)

/* Backlight PWM */
#define BSP_LCD_BACKLIGHT (31)

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

#ifdef __cplusplus
}
#endif
