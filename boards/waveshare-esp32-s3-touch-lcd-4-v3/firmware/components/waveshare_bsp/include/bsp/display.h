#pragma once
#include "esp_lcd_types.h"

/* LCD color formats */
#define ESP_LCD_COLOR_FORMAT_RGB565    (1)
#define ESP_LCD_COLOR_FORMAT_RGB888    (2)

/* LCD display color format */
#define BSP_LCD_COLOR_FORMAT        (ESP_LCD_COLOR_FORMAT_RGB565)
/* LCD display color bytes endianess */
#define BSP_LCD_BIGENDIAN           (1)
/* LCD display color bits */
#define BSP_LCD_BITS_PER_PIXEL      (16)
#define BSP_LCD_BIT_PER_PIXEL       (18)
#define BSP_RGB_DATA_WIDTH          (16)

/* LCD display definition */
#define BSP_LCD_H_RES              (480)
#define BSP_LCD_V_RES              (480)

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief BSP display configuration structure
 *
 */
typedef struct {
    int max_transfer_sz;    /*!< Maximum transfer size, in bytes. */
} bsp_display_config_t;

/**
 * @brief Create new display panel
 */
esp_err_t bsp_display_new(const bsp_display_config_t *config, esp_lcd_panel_handle_t *ret_panel, esp_lcd_panel_io_handle_t *ret_io);

/**
 * @brief Initialize display's brightness
 */
esp_err_t bsp_display_brightness_init(void);

/**
 * @brief Set display's brightness
 */
esp_err_t bsp_display_brightness_set(int brightness_percent);

/**
 * @brief Turn on display backlight
 */
esp_err_t bsp_display_backlight_on(void);

/**
 * @brief Turn off display backlight
 */
esp_err_t bsp_display_backlight_off(void);

#ifdef __cplusplus
}
#endif
