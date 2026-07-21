#pragma once

#include "sdkconfig.h"
#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/sdmmc_host.h"
#include "bsp/config.h"
#include "bsp/display.h"
#include "tca9554_io_expander.h"
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
#define BSP_CAPS_SDCARD         1
#define BSP_CAPS_IMU            0

/**************************************************************************************************
 * Pin definitions for Waveshare ESP32-S3 Touch LCD 4.0
 **************************************************************************************************/

/* I2C */
#define BSP_I2C_SCL           (GPIO_NUM_7)
#define BSP_I2C_SDA           (GPIO_NUM_15)

/* Display */
#define BSP_LCD_VSYNC     (GPIO_NUM_39)
#define BSP_LCD_HSYNC     (GPIO_NUM_38)
#define BSP_LCD_DE        (GPIO_NUM_40)
#define BSP_LCD_PCLK      (GPIO_NUM_41)
#define BSP_LCD_DISP      (GPIO_NUM_NC)
#define BSP_LCD_DATA0     (GPIO_NUM_5)
#define BSP_LCD_DATA1     (GPIO_NUM_45)
#define BSP_LCD_DATA2     (GPIO_NUM_48)
#define BSP_LCD_DATA3     (GPIO_NUM_47)
#define BSP_LCD_DATA4     (GPIO_NUM_21)
#define BSP_LCD_DATA5     (GPIO_NUM_14)
#define BSP_LCD_DATA6     (GPIO_NUM_13)
#define BSP_LCD_DATA7     (GPIO_NUM_12)
#define BSP_LCD_DATA8     (GPIO_NUM_11)
#define BSP_LCD_DATA9     (GPIO_NUM_10)
#define BSP_LCD_DATA10    (GPIO_NUM_9)
#define BSP_LCD_DATA11    (GPIO_NUM_46)
#define BSP_LCD_DATA12    (GPIO_NUM_3)
#define BSP_LCD_DATA13    (GPIO_NUM_8)
#define BSP_LCD_DATA14    (GPIO_NUM_18)
#define BSP_LCD_DATA15    (GPIO_NUM_17)

#define BSP_LCD_IO_SPI_CS (GPIO_NUM_42)
#define BSP_LCD_IO_SPI_SCL (GPIO_NUM_2)
#define BSP_LCD_IO_SPI_SDA (GPIO_NUM_1)

#define BSP_LCD_BACKLIGHT     (GPIO_NUM_NC)
#define BSP_LCD_RST           (IO_EXPANDER_PIN_NUM_3)
#define BSP_LCD_TOUCH_RST     (IO_EXPANDER_PIN_NUM_1)
#define BSP_LCD_TOUCH_INT     (GPIO_NUM_NC)

/* IO Expander pins */
// Note: IO_EXPANDER_PIN_NUM_5 (SYS_EN) controls the beeper - leave it LOW/unset to keep beeper off
#define BSP_RTC_INT          (IO_EXPANDER_PIN_NUM_7)

/* uSD card */
#define BSP_SD_D0            (GPIO_NUM_4)
#define BSP_SD_CMD           (GPIO_NUM_1)
#define BSP_SD_CLK           (GPIO_NUM_2)

/* TCA9554 IO expander address (your board uses 0x20) */
#define BSP_IO_EXPANDER_I2C_ADDRESS     (TCA9554_I2C_ADDRESS_000)
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
 * IO Expander Interface
 **************************************************************************************************/
esp_io_expander_handle_t bsp_io_expander_init(void);

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
void bsp_display_rotate(lv_display_t *disp, lv_disp_rotation_t rotation);
#endif // BSP_CONFIG_NO_GRAPHIC_LIB == 0

#ifdef __cplusplus
}
#endif
