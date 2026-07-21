#pragma once
#include "esp_lcd_touch.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief BSP touch configuration structure
 */
typedef struct {
    void *dummy;    /*!< Prepared for future use. */
} bsp_touch_config_t;

/**
 * @brief Create new touchscreen
 */
esp_err_t bsp_touch_new(const bsp_touch_config_t *config, esp_lcd_touch_handle_t *ret_touch);

#ifdef __cplusplus
}
#endif
