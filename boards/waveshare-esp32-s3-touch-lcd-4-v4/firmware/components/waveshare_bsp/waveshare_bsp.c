/*
 * Waveshare ESP32-S3 Touch LCD 4.0 BSP (hardware Rev 4.0)
 * Rev 4 replaces Rev 3's TCA9554 IO expander with a Waveshare custom CH32V003,
 * which also exposes a PWM register used for real backlight dimming.
 */

#include <stdio.h>
#include <string.h>
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_io_additions.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_check.h"
#include "esp_vfs_fat.h"
#include "esp_spiffs.h"
#include "driver/gpio.h"
#include "driver/ledc.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_lcd_st7701.h"
#include "esp_lcd_touch_gt911.h"

#include "bsp/display.h"
#include "bsp/touch.h"
#include "bsp/esp32_s3_touch_lcd_4.h"
#include "bsp_err_check.h"

static const char *TAG = "waveshare_bsp";

static i2c_master_bus_handle_t i2c_handle = NULL;
static bool i2c_initialized = false;
static esp_io_expander_handle_t io_expander = NULL;
static lv_display_t *disp;
static lv_indev_t *disp_indev = NULL;
sdmmc_card_t *bsp_sdcard = NULL;
static esp_lcd_touch_handle_t tp = NULL;
static esp_lcd_panel_handle_t panel_handle = NULL;
static bool s_invert = false;
/* The requested backlight level survives blanking: wake restores it. */
static uint32_t s_brightness_percent = 100;
static bool s_display_awake = false;

static const st7701_lcd_init_cmd_t lcd_init_cmds[] = {
    {0x11, (uint8_t[]){0x00}, 0, 120},
    {0xFF, (uint8_t[]){0x77, 0x01, 0x00, 0x00, 0x10}, 5, 0},
    {0xC0, (uint8_t[]){0x3B, 0x00}, 2, 0},
    {0xC1, (uint8_t[]){0x0D, 0x02}, 2, 0},
    {0xC2, (uint8_t[]){0x21, 0x08}, 2, 0},
    {0xCD, (uint8_t[]){0x08}, 1, 0},
    {0xB0, (uint8_t[]){0x00, 0x11, 0x18, 0x0E, 0x11, 0x06, 0x07, 0x08, 0x07, 0x22, 0x04, 0x12, 0x0F, 0xAA, 0x31, 0x18}, 16, 0},
    {0xB1, (uint8_t[]){0x00, 0x11, 0x19, 0x0E, 0x12, 0x07, 0x08, 0x08, 0x08, 0x22, 0x04, 0x11, 0x11, 0xA9, 0x32, 0x18}, 16, 0},
    {0xFF, (uint8_t[]){0x77, 0x01, 0x00, 0x00, 0x11}, 5, 0},
    {0xB0, (uint8_t[]){0x60}, 1, 0},
    {0xB1, (uint8_t[]){0x30}, 1, 0},
    {0xB2, (uint8_t[]){0x87}, 1, 0},
    {0xB3, (uint8_t[]){0x80}, 1, 0},
    {0xB5, (uint8_t[]){0x49}, 1, 0},
    {0xB7, (uint8_t[]){0x85}, 1, 0},
    {0xB8, (uint8_t[]){0x21}, 1, 0},
    {0xC1, (uint8_t[]){0x78}, 1, 0},
    {0xC2, (uint8_t[]){0x78}, 1, 20},
    {0xE0, (uint8_t[]){0x00, 0x1B, 0x02}, 3, 0},
    {0xE1, (uint8_t[]){0x08, 0xA0, 0x00, 0x00, 0x07, 0xA0, 0x00, 0x00, 0x00, 0x44, 0x44}, 11, 0},
    {0xE2, (uint8_t[]){0x11, 0x11, 0x44, 0x44, 0xED, 0xA0, 0x00, 0x00, 0xEC, 0xA0, 0x00, 0x00}, 12, 0},
    {0xE3, (uint8_t[]){0x00, 0x00, 0x11, 0x11}, 4, 0},
    {0xE4, (uint8_t[]){0x44, 0x44}, 2, 0},
    {0xE5, (uint8_t[]){0x0A, 0xE9, 0xD8, 0xA0, 0x0C, 0xEB, 0xD8, 0xA0, 0x0E, 0xED, 0xD8, 0xA0, 0x10, 0xEF, 0xD8, 0xA0}, 16, 0},
    {0xE6, (uint8_t[]){0x00, 0x00, 0x11, 0x11}, 4, 0},
    {0xE7, (uint8_t[]){0x44, 0x44}, 2, 0},
    {0xE8, (uint8_t[]){0x09, 0xE8, 0xD8, 0xA0, 0x0B, 0xEA, 0xD8, 0xA0, 0x0D, 0xEC, 0xD8, 0xA0, 0x0F, 0xEE, 0xD8, 0xA0}, 16, 0},
    {0xEB, (uint8_t[]){0x02, 0x00, 0xE4, 0xE4, 0x88, 0x00, 0x40}, 7, 0},
    {0xEC, (uint8_t[]){0x3C, 0x00}, 2, 0},
    {0xED, (uint8_t[]){0xAB, 0x89, 0x76, 0x54, 0x02, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x20, 0x45, 0x67, 0x98, 0xBA}, 16, 0},
    {0xFF, (uint8_t[]){0x77, 0x01, 0x00, 0x00, 0x00}, 5, 0},
    {0x36, (uint8_t[]){0x00}, 1, 0},
    {0x3A, (uint8_t[]){0x66}, 1, 0},
    {0x21, (uint8_t[]){0x00}, 0, 120},
    {0x29, (uint8_t[]){0x00}, 0, 0},
};

/**************************************************************************************************
 * I2C Functions
 **************************************************************************************************/
esp_err_t bsp_i2c_init(void)
{
    if (i2c_initialized) {
        return ESP_OK;
    }

    i2c_master_bus_config_t i2c_bus_conf = {
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .sda_io_num = BSP_I2C_SDA,
        .scl_io_num = BSP_I2C_SCL,
        .i2c_port = BSP_I2C_NUM,
        .flags.enable_internal_pullup = true,
    };
    BSP_ERROR_CHECK_RETURN_ERR(i2c_new_master_bus(&i2c_bus_conf, &i2c_handle));

    i2c_initialized = true;
    return ESP_OK;
}

esp_err_t bsp_i2c_deinit(void)
{
    BSP_ERROR_CHECK_RETURN_ERR(i2c_del_master_bus(i2c_handle));
    i2c_initialized = false;
    return ESP_OK;
}

i2c_master_bus_handle_t bsp_i2c_get_handle(void)
{
    bsp_i2c_init();
    return i2c_handle;
}

static esp_err_t bsp_i2c_device_probe(uint8_t addr)
{
    return i2c_master_probe(i2c_handle, addr, 100);
}

/**************************************************************************************************
 * SPIFFS Functions
 **************************************************************************************************/
esp_err_t bsp_spiffs_mount(void)
{
    esp_vfs_spiffs_conf_t conf = {
        .base_path = CONFIG_BSP_SPIFFS_MOUNT_POINT,
        .partition_label = CONFIG_BSP_SPIFFS_PARTITION_LABEL,
        .max_files = CONFIG_BSP_SPIFFS_MAX_FILES,
#ifdef CONFIG_BSP_SPIFFS_FORMAT_ON_MOUNT_FAIL
        .format_if_mount_failed = true,
#else
        .format_if_mount_failed = false,
#endif
    };

    esp_err_t ret_val = esp_vfs_spiffs_register(&conf);
    BSP_ERROR_CHECK_RETURN_ERR(ret_val);

    size_t total = 0, used = 0;
    ret_val = esp_spiffs_info(conf.partition_label, &total, &used);
    if (ret_val != ESP_OK) {
        ESP_LOGE(TAG, "Failed to get SPIFFS partition information (%s)", esp_err_to_name(ret_val));
    } else {
        ESP_LOGI(TAG, "Partition size: total: %d, used: %d", total, used);
    }

    return ret_val;
}

esp_err_t bsp_spiffs_unmount(void)
{
    return esp_vfs_spiffs_unregister(CONFIG_BSP_SPIFFS_PARTITION_LABEL);
}

/**************************************************************************************************
 * IO Expander Functions
 **************************************************************************************************/
esp_io_expander_handle_t bsp_io_expander_init()
{
    if (!i2c_initialized) {
        BSP_ERROR_CHECK_RETURN_NULL(bsp_i2c_init());
    }
    if (!io_expander) {
        ESP_LOGI(TAG, "Initializing CH32V003 IO expander at address 0x%02X", BSP_IO_EXPANDER_I2C_ADDRESS);
        BSP_ERROR_CHECK_RETURN_NULL(custom_io_expander_new_i2c_ch32v003(i2c_handle, BSP_IO_EXPANDER_I2C_ADDRESS, &io_expander));
        ESP_LOGI(TAG, "IO expander initialized successfully");
    }
    return io_expander;
}

/**************************************************************************************************
 * SD Card Functions
 **************************************************************************************************/
esp_err_t bsp_sdcard_mount(void)
{
    const esp_vfs_fat_sdmmc_mount_config_t mount_config = {
#ifdef CONFIG_BSP_SD_FORMAT_ON_MOUNT_FAIL
        .format_if_mount_failed = true,
#else
        .format_if_mount_failed = false,
#endif
        .max_files = 5,
        .allocation_unit_size = 16 * 1024
    };

    // Use slower clock speed for better compatibility with large SDXC cards
    sdmmc_host_t host = SDMMC_HOST_DEFAULT();
    host.max_freq_khz = SDMMC_FREQ_PROBING;  // 400kHz - slowest, for debugging

    const sdmmc_slot_config_t slot_config = {
        .clk = BSP_SD_CLK,
        .cmd = BSP_SD_CMD,
        .d0 = BSP_SD_D0,
        .d1 = GPIO_NUM_NC,
        .d2 = GPIO_NUM_NC,
        .d3 = GPIO_NUM_NC,
        .d4 = GPIO_NUM_NC,
        .d5 = GPIO_NUM_NC,
        .d6 = GPIO_NUM_NC,
        .d7 = GPIO_NUM_NC,
        .cd = SDMMC_SLOT_NO_CD,
        .wp = SDMMC_SLOT_NO_WP,
        .width = 1,
        .flags = 0,
    };

    return esp_vfs_fat_sdmmc_mount(BSP_SD_MOUNT_POINT, &host, &slot_config, &mount_config, &bsp_sdcard);
}

esp_err_t bsp_sdcard_unmount(void)
{
    return esp_vfs_fat_sdcard_unmount(BSP_SD_MOUNT_POINT, bsp_sdcard);
}

/**************************************************************************************************
 * Display Functions
 **************************************************************************************************/
#define LCD_BRIGHTNESS_MAX 0xFF

/* The CH32V003 PWM register is inverted: 0 is full brightness and 0xFF
   is off. */
static int clamp_brightness(int brightness_percent)
{
    if (brightness_percent > 100) {
        return 100;
    }

    return brightness_percent < 0 ? 0 : brightness_percent;
}

static esp_err_t backlight_write(int brightness_percent)
{
    const int flipped = 100 - clamp_brightness(brightness_percent);
    return custom_io_expander_set_pwm(io_expander, (uint8_t)(flipped * LCD_BRIGHTNESS_MAX / 100));
}

esp_err_t bsp_display_brightness_init(void)
{
    if (io_expander == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    /* Drive the backlight on so the panel lights up. */
    s_display_awake = true;
    return backlight_write((int)s_brightness_percent);
}

esp_err_t bsp_display_brightness_set(int brightness_percent)
{
    if (io_expander == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    s_brightness_percent = (uint32_t)clamp_brightness(brightness_percent);

    /* A blanked panel only stores the level; the next wake applies it. */
    if (!s_display_awake) {
        return ESP_OK;
    }

    return backlight_write(brightness_percent);
}

esp_err_t bsp_display_backlight_off(void)
{
    return bsp_display_brightness_set(0);
}

esp_err_t bsp_display_backlight_on(void)
{
    if (io_expander == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    s_display_awake = true;
    return backlight_write((int)s_brightness_percent);
}

esp_err_t bsp_display_new(const bsp_display_config_t *config, esp_lcd_panel_handle_t *ret_panel, esp_lcd_panel_io_handle_t *ret_io)
{
    esp_lcd_panel_io_handle_t io_handle = NULL;

    esp_io_expander_handle_t expander = NULL;
    BSP_NULL_CHECK(expander = bsp_io_expander_init(), ESP_FAIL);

    /* Configure IO expander pins as outputs. SYS_EN powers the display rail
       and must be driven; BEE_EN is held low to keep the beeper silent. */
    esp_io_expander_set_dir(io_expander, BSP_SYS_EN | BSP_BEE_EN | BSP_LCD_RST | BSP_LCD_TOUCH_RST, IO_EXPANDER_OUTPUT);
    esp_io_expander_set_dir(io_expander, BSP_RTC_INT, IO_EXPANDER_INPUT);

    /* Reset sequence for LCD and Touch: pull reset lines and BEE_EN low,
       then release with SYS_EN high to power the rail. */
    esp_io_expander_set_level(io_expander, BSP_BEE_EN | BSP_LCD_RST | BSP_LCD_TOUCH_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(200));
    esp_io_expander_set_level(io_expander, BSP_SYS_EN | BSP_LCD_RST | BSP_LCD_TOUCH_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(200));

    ESP_LOGI(TAG, "Install 3-wire SPI panel IO");
    spi_line_config_t line_config = {
        .cs_io_type = IO_TYPE_GPIO,
        .cs_gpio_num = BSP_LCD_IO_SPI_CS,
        .scl_io_type = IO_TYPE_GPIO,
        .scl_gpio_num = BSP_LCD_IO_SPI_SCL,
        .sda_io_type = IO_TYPE_GPIO,
        .sda_gpio_num = BSP_LCD_IO_SPI_SDA,
    };
    esp_lcd_panel_io_3wire_spi_config_t io_config = ST7701_PANEL_IO_3WIRE_SPI_CONFIG(line_config, 0);
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_3wire_spi(&io_config, &io_handle));

    esp_lcd_rgb_panel_config_t rgb_config = {
        .clk_src = LCD_CLK_SRC_DEFAULT,
        .psram_trans_align = 64,
        .data_width = BSP_RGB_DATA_WIDTH,
        .bits_per_pixel = BSP_LCD_BITS_PER_PIXEL,
        .de_gpio_num = BSP_LCD_DE,
        .pclk_gpio_num = BSP_LCD_PCLK,
        .vsync_gpio_num = BSP_LCD_VSYNC,
        .hsync_gpio_num = BSP_LCD_HSYNC,
        .disp_gpio_num = BSP_LCD_DISP,
        .data_gpio_nums = {
            BSP_LCD_DATA0, BSP_LCD_DATA1, BSP_LCD_DATA2, BSP_LCD_DATA3,
            BSP_LCD_DATA4, BSP_LCD_DATA5, BSP_LCD_DATA6, BSP_LCD_DATA7,
            BSP_LCD_DATA8, BSP_LCD_DATA9, BSP_LCD_DATA10, BSP_LCD_DATA11,
            BSP_LCD_DATA12, BSP_LCD_DATA13, BSP_LCD_DATA14, BSP_LCD_DATA15,
        },
        .timings = ST7701_480_480_PANEL_60HZ_RGB_TIMING(),
        .flags.fb_in_psram = 1,
        .num_fbs = CONFIG_BSP_LCD_RGB_BUFFER_NUMS,
        .bounce_buffer_size_px = BSP_LCD_DRAW_BUFF_SIZE,
    };
    rgb_config.timings.h_res = BSP_LCD_H_RES;
    rgb_config.timings.v_res = BSP_LCD_V_RES;

    st7701_vendor_config_t vendor_config = {
        .rgb_config = &rgb_config,
        .init_cmds = lcd_init_cmds,
        .init_cmds_size = sizeof(lcd_init_cmds) / sizeof(lcd_init_cmds[0]),
        .flags = {
            .auto_del_panel_io = 0,
            .mirror_by_cmd = 1,
        },
    };
    const esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = BSP_LCD_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = BSP_LCD_BIT_PER_PIXEL,
        .vendor_config = &vendor_config,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_st7701(io_handle, &panel_config, &panel_handle));
    esp_lcd_panel_reset(panel_handle);
    esp_lcd_panel_init(panel_handle);
    esp_lcd_panel_disp_on_off(panel_handle, true);

    /* Rev 4 backlight is a PWM register on the CH32V003; drive it to full so
       the panel is lit. Without this the panel can stay dark. */
    ESP_ERROR_CHECK(bsp_display_brightness_init());

    if (ret_panel) {
        *ret_panel = panel_handle;
    }
    if (ret_io) {
        *ret_io = io_handle;
    }

    return ESP_OK;
}

esp_err_t bsp_touch_new(const bsp_touch_config_t *config, esp_lcd_touch_handle_t *ret_touch)
{
    BSP_ERROR_CHECK_RETURN_ERR(bsp_i2c_init());

    const esp_lcd_touch_config_t tp_cfg = {
        .x_max = BSP_LCD_H_RES,
        .y_max = BSP_LCD_V_RES,
        .rst_gpio_num = GPIO_NUM_NC,
        .int_gpio_num = GPIO_NUM_NC,
        .levels = {
            .reset = 0,
            .interrupt = 0,
        },
        .flags = {
            .swap_xy = 0,
            /* The Rev 4 touch digitizer natively matches physical orientation
               (top-left reads 0,0); only the display scan is 180°-reversed,
               which the software rotation corrects. Do not mirror touch. */
            .mirror_x = 0,
            .mirror_y = 0,
        },
    };
    esp_lcd_panel_io_handle_t tp_io_handle = NULL;
    esp_lcd_panel_io_i2c_config_t tp_io_config;

    if (ESP_OK == bsp_i2c_device_probe(ESP_LCD_TOUCH_IO_I2C_GT911_ADDRESS)) {
        ESP_LOGI(TAG, "Touch 0x5d found");
        esp_lcd_panel_io_i2c_config_t config = ESP_LCD_TOUCH_IO_I2C_GT911_CONFIG();
        memcpy(&tp_io_config, &config, sizeof(config));
    } else if (ESP_OK == bsp_i2c_device_probe(ESP_LCD_TOUCH_IO_I2C_GT911_ADDRESS_BACKUP)) {
        ESP_LOGI(TAG, "Touch 0x14 found");
        esp_lcd_panel_io_i2c_config_t config = ESP_LCD_TOUCH_IO_I2C_GT911_CONFIG();
        config.dev_addr = ESP_LCD_TOUCH_IO_I2C_GT911_ADDRESS_BACKUP;
        memcpy(&tp_io_config, &config, sizeof(config));
    } else {
        ESP_LOGE(TAG, "Touch not found");
        return ESP_ERR_NOT_FOUND;
    }
    tp_io_config.scl_speed_hz = CONFIG_BSP_I2C_CLK_SPEED_HZ;
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_i2c(i2c_handle, &tp_io_config, &tp_io_handle), TAG, "");
    return esp_lcd_touch_new_i2c_gt911(tp_io_handle, &tp_cfg, ret_touch);
}

static lv_display_t *bsp_display_lcd_init()
{
    esp_lcd_panel_io_handle_t io_handle = NULL;
    bsp_display_config_t disp_config = {0};

    BSP_ERROR_CHECK_RETURN_NULL(bsp_display_new(&disp_config, &panel_handle, &io_handle));

    int buffer_size = 0;
#if CONFIG_BSP_DISPLAY_LVGL_AVOID_TEAR
    buffer_size = BSP_LCD_H_RES * BSP_LCD_V_RES;
#else
    buffer_size = BSP_LCD_H_RES * LVGL_BUFFER_HEIGHT;
#endif

    const lvgl_port_display_cfg_t disp_cfg = {
        .io_handle = io_handle,
        .panel_handle = panel_handle,
        .buffer_size = buffer_size,
        .monochrome = false,
        .hres = BSP_LCD_H_RES,
        .vres = BSP_LCD_V_RES,
#if LVGL_VERSION_MAJOR >= 9
        .color_format = LV_COLOR_FORMAT_RGB565,
#endif
        .rotation = {
            .swap_xy = false,
            .mirror_x = false,
            .mirror_y = false,
        },
        .flags = {
            .sw_rotate = true,
            .buff_dma = false,
#if CONFIG_BSP_DISPLAY_LVGL_PSRAM
            .buff_spiram = false,
#endif
#if CONFIG_BSP_DISPLAY_LVGL_FULL_REFRESH
            .full_refresh = 1,
#elif CONFIG_BSP_DISPLAY_LVGL_DIRECT_MODE
            .direct_mode = 1,
#endif
#if LVGL_VERSION_MAJOR >= 9
            .swap_bytes = false,
#endif
        }
    };
    const lvgl_port_display_rgb_cfg_t rgb_cfg = {
        .flags = {
#if CONFIG_BSP_LCD_RGB_BOUNCE_BUFFER_MODE
            .bb_mode = 1,
#else
            .bb_mode = 0,
#endif
#if CONFIG_BSP_DISPLAY_LVGL_AVOID_TEAR
            .avoid_tearing = true,
#else
            .avoid_tearing = false,
#endif
        }
    };

    return lvgl_port_add_disp_rgb(&disp_cfg, &rgb_cfg);
}

static lv_indev_t *bsp_display_indev_init(lv_display_t *disp)
{
    BSP_ERROR_CHECK_RETURN_NULL(bsp_touch_new(NULL, &tp));
    assert(tp);

    const lvgl_port_touch_cfg_t touch_cfg = {
        .disp = disp,
        .handle = tp,
    };

    return lvgl_port_add_touch(&touch_cfg);
}

lv_display_t *bsp_display_start(void)
{
    bsp_display_cfg_t cfg = {
        .lvgl_port_cfg = ESP_LVGL_PORT_INIT_CONFIG()
    };
    return bsp_display_start_with_config(&cfg);
}

lv_display_t *bsp_display_start_with_config(const bsp_display_cfg_t *cfg)
{
    BSP_ERROR_CHECK_RETURN_NULL(lvgl_port_init(&cfg->lvgl_port_cfg));
    BSP_NULL_CHECK(disp = bsp_display_lcd_init(), NULL);
    BSP_NULL_CHECK(disp_indev = bsp_display_indev_init(disp), NULL);

    /* Rev 4 mounts the panel rotated 180° vs Rev 3, and the ST7701 ignores
       the MADCTL MY/MX and SDIR/ML mirror commands in RGB mode (both were
       tried on hardware). Rotate in software instead: sw_rotate is set on
       this display, so the port rotates every flushed buffer 180° via
       lv_draw_sw_rotate before it reaches the panel. Touch stays aligned
       because the port maps touch coordinates through the same display
       rotation; the natively oriented digitizer needs no mirroring. */
    if (lvgl_port_lock(0)) {
        lv_display_set_rotation(disp, LV_DISPLAY_ROTATION_180);
        lvgl_port_unlock();
    }

    return disp;
}

lv_indev_t *bsp_display_get_input_dev(void)
{
    return disp_indev;
}

void bsp_display_rotate(lv_display_t *disp, lv_display_rotation_t rotation)
{
    lv_disp_set_rotation(disp, rotation);
}

bool bsp_display_lock(uint32_t timeout_ms)
{
    return lvgl_port_lock(timeout_ms);
}

void bsp_display_unlock(void)
{
    lvgl_port_unlock();
}

esp_err_t bsp_display_set_awake(bool awake)
{
    if (panel_handle == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    /* Rev 4 has a real PWM backlight, so blanking actually turns the panel
       dark. Waking restores the configured brightness rather than forcing
       full, and the ST7701 display command is kept for state-machine
       parity. */
    const esp_err_t error = backlight_write(awake ? (int)s_brightness_percent : 0);
    const esp_err_t panel = esp_lcd_panel_disp_on_off(panel_handle, awake);

    if (error == ESP_OK && panel == ESP_OK) {
        s_display_awake = awake;
    }

    return error != ESP_OK ? error : panel;
}

esp_err_t bsp_display_set_brightness(uint32_t brightness_percent)
{
    if (brightness_percent > 100) {
        return ESP_ERR_INVALID_ARG;
    }

    return bsp_display_brightness_set((int)brightness_percent);
}

esp_err_t bsp_display_set_invert(bool invert)
{
    if (panel_handle == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    const esp_err_t error = esp_lcd_panel_invert_color(panel_handle, invert);

    if (error == ESP_OK) {
        s_invert = invert;
    }

    return error;
}

bool bsp_display_invert(void)
{
    return s_invert;
}

/* The ST7701 runs as an RGB panel, whose esp_lcd driver has no swap_xy, so
   there is no rotation to offer on a square 480x480 screen anyway. */
esp_err_t bsp_display_set_rotation(uint16_t degrees)
{
    (void)degrees;
    return ESP_ERR_NOT_SUPPORTED;
}

uint16_t bsp_display_rotation(void)
{
    return 0;
}

/* Mirroring is a MADCTL bit, which an RGB panel driven straight from the
   framebuffer does not have. */
esp_err_t bsp_display_set_flip(bool flip_x, bool flip_y)
{
    (void)flip_x;
    (void)flip_y;
    return ESP_ERR_NOT_SUPPORTED;
}

void bsp_display_flip(bool *flip_x, bool *flip_y)
{
    if (flip_x != NULL) {
        *flip_x = false;
    }

    if (flip_y != NULL) {
        *flip_y = false;
    }
}

/* GT911 is a capacitive controller that reports screen coordinates directly,
   so there is nothing to calibrate and no raw sample to expose. */
bool bsp_touch_read_raw(uint16_t *raw_x, uint16_t *raw_y)
{
    (void)raw_x;
    (void)raw_y;
    return false;
}

esp_err_t bsp_touch_set_calibration(const float *coefficients)
{
    (void)coefficients;
    return ESP_ERR_NOT_SUPPORTED;
}
