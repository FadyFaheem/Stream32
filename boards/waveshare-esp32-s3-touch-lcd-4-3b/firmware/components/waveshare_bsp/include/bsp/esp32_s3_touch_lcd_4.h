#pragma once

#include "sdkconfig.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/sdmmc_host.h"
#include "bsp/config.h"
#include "bsp/display.h"
#include "lvgl.h"
#include "esp_lvgl_port.h"

/**************************************************************************************************
 *  BSP Capabilities
 **************************************************************************************************/

#define BSP_CAPS_DISPLAY        1
#define BSP_CAPS_TOUCH          1
#define BSP_CAPS_BUTTONS        0
#define BSP_CAPS_AUDIO          0
#define BSP_CAPS_AUDIO_SPEAKER  0
#define BSP_CAPS_AUDIO_MIC      0
#define BSP_CAPS_SDCARD         0
#define BSP_CAPS_IMU            0

/**************************************************************************************************
 * Pin definitions for Waveshare ESP32-S3 Touch LCD 4.3B
 **************************************************************************************************/

/* I2C */
#define BSP_I2C_SCL           (GPIO_NUM_9)
#define BSP_I2C_SDA           (GPIO_NUM_8)

/* Display */
#define BSP_LCD_VSYNC     (GPIO_NUM_3)
#define BSP_LCD_HSYNC     (GPIO_NUM_46)
#define BSP_LCD_DE        (GPIO_NUM_5)
#define BSP_LCD_PCLK      (GPIO_NUM_7)
#define BSP_LCD_DISP      (GPIO_NUM_NC)
#define BSP_LCD_DATA0     (GPIO_NUM_14)
#define BSP_LCD_DATA1     (GPIO_NUM_38)
#define BSP_LCD_DATA2     (GPIO_NUM_18)
#define BSP_LCD_DATA3     (GPIO_NUM_17)
#define BSP_LCD_DATA4     (GPIO_NUM_10)
#define BSP_LCD_DATA5     (GPIO_NUM_39)
#define BSP_LCD_DATA6     (GPIO_NUM_0)
#define BSP_LCD_DATA7     (GPIO_NUM_45)
#define BSP_LCD_DATA8     (GPIO_NUM_48)
#define BSP_LCD_DATA9     (GPIO_NUM_47)
#define BSP_LCD_DATA10    (GPIO_NUM_21)
#define BSP_LCD_DATA11    (GPIO_NUM_1)
#define BSP_LCD_DATA12    (GPIO_NUM_2)
#define BSP_LCD_DATA13    (GPIO_NUM_42)
#define BSP_LCD_DATA14    (GPIO_NUM_41)
#define BSP_LCD_DATA15    (GPIO_NUM_40)

#define BSP_LCD_BACKLIGHT     (GPIO_NUM_NC)
#define BSP_LCD_TOUCH_INT     (GPIO_NUM_4)

/* CH422G command addresses and output bits. */
#define BSP_CH422G_MODE_ADDRESS     (0x24)
#define BSP_CH422G_OUTPUT_ADDRESS   (0x38)
#define BSP_CH422G_TOUCH_RST        (1U << 1)
#define BSP_CH422G_LCD_BL           (1U << 2)
#define BSP_CH422G_LCD_RST          (1U << 3)
#define BSP_CH422G_SD_CS            (1U << 4)
#define BSP_CH422G_USB_SEL          (1U << 5)
#define LVGL_BUFFER_HEIGHT          (CONFIG_BSP_DISPLAY_LVGL_BUF_HEIGHT)

#ifdef __cplusplus
extern "C" {
#endif

/**************************************************************************************************
 * I2C interface
 **************************************************************************************************/
#define BSP_I2C_NUM     CONFIG_BSP_I2C_NUM

esp_err_t bsp_i2c_init(void);
esp_err_t bsp_i2c_deinit(void);
i2c_master_bus_handle_t bsp_i2c_get_handle(void);

/**************************************************************************************************
 * SPIFFS
 **************************************************************************************************/
#define BSP_SPIFFS_MOUNT_POINT      CONFIG_BSP_SPIFFS_MOUNT_POINT

esp_err_t bsp_spiffs_mount(void);
esp_err_t bsp_spiffs_unmount(void);

/**************************************************************************************************
 * uSD card
 **************************************************************************************************/
#define BSP_SD_MOUNT_POINT      CONFIG_BSP_SD_MOUNT_POINT
extern sdmmc_card_t *bsp_sdcard;

esp_err_t bsp_sdcard_mount(void);
esp_err_t bsp_sdcard_unmount(void);

/**************************************************************************************************
 * LCD interface
 **************************************************************************************************/
#define BSP_LCD_PIXEL_CLOCK_HZ     (16 * 1000 * 1000)
#define BSP_LCD_SPI_NUM            (SPI3_HOST)

#if (BSP_CONFIG_NO_GRAPHIC_LIB == 0)
#define BSP_LCD_DRAW_BUFF_SIZE     (BSP_LCD_H_RES * CONFIG_BSP_LCD_RGB_BOUNCE_BUFFER_HEIGHT)
#define BSP_LCD_DRAW_BUFF_DOUBLE   (0)

typedef struct {
    lvgl_port_cfg_t lvgl_port_cfg;
    uint32_t        buffer_size;
    uint32_t        trans_size;
    bool            double_buffer;
    struct {
        unsigned int buff_dma: 1;
        unsigned int buff_spiram: 1;
    } flags;
} bsp_display_cfg_t;

lv_display_t *bsp_display_start(void);
lv_display_t *bsp_display_start_with_config(const bsp_display_cfg_t *cfg);
lv_indev_t *bsp_display_get_input_dev(void);
bool bsp_display_lock(uint32_t timeout_ms);
void bsp_display_unlock(void);
esp_err_t bsp_display_set_awake(bool awake);
esp_err_t bsp_display_set_brightness(uint32_t brightness_percent);
esp_err_t bsp_display_set_invert(bool invert);
bool bsp_display_invert(void);
/* RGB panel rotation is performed by the LVGL software rotation path. */
esp_err_t bsp_display_set_rotation(uint16_t degrees);
uint16_t bsp_display_rotation(void);
esp_err_t bsp_display_set_flip(bool flip_x, bool flip_y);
void bsp_display_flip(bool *flip_x, bool *flip_y);
/* GT911 reports screen coordinates directly, so these decline. */
bool bsp_touch_read_raw(uint16_t *raw_x, uint16_t *raw_y);
esp_err_t bsp_touch_set_calibration(const float *coefficients);
void bsp_display_rotate(lv_display_t *disp, lv_disp_rotation_t rotation);
#endif // BSP_CONFIG_NO_GRAPHIC_LIB == 0

#ifdef __cplusplus
}
#endif
