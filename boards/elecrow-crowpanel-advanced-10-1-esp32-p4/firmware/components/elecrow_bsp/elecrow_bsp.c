/*
 * Elecrow CrowPanel Advanced 10.1" BSP implementation.
 *
 * The init sequence, pins, and panel timings mirror Elecrow's factory
 * ESP-IDF lessons for this exact board (EK79007 over 2-lane MIPI DSI,
 * GT911 touch, LEDC backlight, LDO channels 3 and 4).
 */
#include "bsp/esp-bsp.h"

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/ledc.h"
#include "esp_check.h"
#include "esp_lcd_ek79007.h"
#include "esp_lcd_mipi_dsi.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_touch.h"
#include "esp_lcd_touch_gt911.h"
#include "esp_ldo_regulator.h"
#include "esp_log.h"
#include "esp_lvgl_port.h"

#define BSP_MIPI_DSI_LANES 2
#define BSP_MIPI_DSI_LANE_MBPS 900
#define BSP_MIPI_DPI_CLOCK_MHZ 51
#define BSP_LDO_MIPI_PHY_CHANNEL 3
#define BSP_LDO_MIPI_PHY_MV 2500
#define BSP_LDO_PERIPHERAL_CHANNEL 4
#define BSP_LDO_PERIPHERAL_MV 3300
#define BSP_BACKLIGHT_PWM_HZ 30000
#define BSP_TOUCH_I2C_HZ 400000

static const char *TAG = "elecrow_bsp";

static esp_ldo_channel_handle_t s_ldo_mipi_phy;
static esp_ldo_channel_handle_t s_ldo_peripheral;
static i2c_master_bus_handle_t s_i2c_bus;
static esp_lcd_dsi_bus_handle_t s_dsi_bus;
static esp_lcd_panel_io_handle_t s_dbi_io;
static esp_lcd_panel_handle_t s_panel;
static esp_lcd_touch_handle_t s_touch;
static const char *s_status = "display-not-started";
static uint32_t s_brightness_percent = 100;
static bool s_display_awake;

static esp_err_t backlight_init(void)
{
    const gpio_config_t pin_config = {
        .pin_bit_mask = 1ULL << BSP_LCD_BACKLIGHT,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = false,
        .pull_down_en = false,
        .intr_type = GPIO_INTR_DISABLE,
    };
    const ledc_timer_config_t timer_config = {
        .clk_cfg = LEDC_USE_PLL_DIV_CLK,
        .duty_resolution = LEDC_TIMER_11_BIT,
        .freq_hz = BSP_BACKLIGHT_PWM_HZ,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .timer_num = LEDC_TIMER_0,
    };
    const ledc_channel_config_t channel_config = {
        .gpio_num = BSP_LCD_BACKLIGHT,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_0,
        .intr_type = LEDC_INTR_DISABLE,
        .timer_sel = LEDC_TIMER_0,
        .duty = 0,
        .hpoint = 0,
    };

    ESP_RETURN_ON_ERROR(gpio_config(&pin_config), TAG, "backlight gpio");
    ESP_RETURN_ON_ERROR(ledc_timer_config(&timer_config), TAG, "ledc timer");
    return ledc_channel_config(&channel_config);
}

static esp_err_t backlight_set(uint32_t brightness_percent)
{
    /* Factory duty curve: 0 is off, 100 maps to 2000/2047. */
    const uint32_t duty =
        brightness_percent == 0 ? 0 : brightness_percent * 18 + 200;

    ESP_RETURN_ON_ERROR(
        ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, duty),
        TAG,
        "ledc duty"
    );
    return ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

static esp_err_t power_init(void)
{
    const esp_ldo_channel_config_t mipi_phy = {
        .chan_id = BSP_LDO_MIPI_PHY_CHANNEL,
        .voltage_mv = BSP_LDO_MIPI_PHY_MV,
    };
    const esp_ldo_channel_config_t peripheral = {
        .chan_id = BSP_LDO_PERIPHERAL_CHANNEL,
        .voltage_mv = BSP_LDO_PERIPHERAL_MV,
    };

    ESP_RETURN_ON_ERROR(
        esp_ldo_acquire_channel(&mipi_phy, &s_ldo_mipi_phy),
        TAG,
        "ldo3"
    );
    return esp_ldo_acquire_channel(&peripheral, &s_ldo_peripheral);
}

static esp_err_t panel_init(void)
{
    const esp_lcd_dsi_bus_config_t bus_config = {
        .bus_id = 0,
        .num_data_lanes = BSP_MIPI_DSI_LANES,
        .phy_clk_src = MIPI_DSI_PHY_CLK_SRC_DEFAULT,
        .lane_bit_rate_mbps = BSP_MIPI_DSI_LANE_MBPS,
    };
    const esp_lcd_dbi_io_config_t dbi_config = {
        .virtual_channel = 0,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
    };
    const esp_lcd_dpi_panel_config_t dpi_config = {
        .dpi_clk_src = MIPI_DSI_DPI_CLK_SRC_DEFAULT,
        .dpi_clock_freq_mhz = BSP_MIPI_DPI_CLOCK_MHZ,
        .virtual_channel = 0,
        .pixel_format = LCD_COLOR_PIXEL_FORMAT_RGB565,
        .num_fbs = 1,
        .video_timing = {
            .h_size = BSP_LCD_H_RES,
            .v_size = BSP_LCD_V_RES,
            .hsync_back_porch = 160,
            .hsync_pulse_width = 70,
            .hsync_front_porch = 160,
            .vsync_back_porch = 23,
            .vsync_pulse_width = 10,
            .vsync_front_porch = 12,
        },
        .flags.use_dma2d = true,
    };
    ek79007_vendor_config_t vendor_config = {
        .mipi_config = {
            .dsi_bus = NULL, /* Filled below once the bus exists. */
            .dpi_config = &dpi_config,
        },
    };
    const esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = -1,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
        .vendor_config = &vendor_config,
    };

    s_status = "display-dsi-bus";
    ESP_RETURN_ON_ERROR(
        esp_lcd_new_dsi_bus(&bus_config, &s_dsi_bus),
        TAG,
        "dsi bus"
    );
    vendor_config.mipi_config.dsi_bus = s_dsi_bus;
    s_status = "display-dbi-io";
    ESP_RETURN_ON_ERROR(
        esp_lcd_new_panel_io_dbi(s_dsi_bus, &dbi_config, &s_dbi_io),
        TAG,
        "dbi io"
    );
    s_status = "display-panel-create";
    ESP_RETURN_ON_ERROR(
        esp_lcd_new_panel_ek79007(s_dbi_io, &panel_config, &s_panel),
        TAG,
        "ek79007"
    );
    s_status = "display-panel-reset";
    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(s_panel), TAG, "panel reset");
    s_status = "display-controller-init";
    return esp_lcd_panel_init(s_panel);
}

static esp_err_t touch_init(void)
{
    const i2c_master_bus_config_t bus_config = {
        .i2c_port = 0,
        .sda_io_num = BSP_I2C_SDA,
        .scl_io_num = BSP_I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    esp_lcd_panel_io_i2c_config_t io_config = {
        .dev_addr = ESP_LCD_TOUCH_IO_I2C_GT911_ADDRESS,
        .control_phase_bytes = 1,
        .dc_bit_offset = 0,
        .lcd_cmd_bits = 16,
        .flags.disable_control_phase = 1,
        .scl_speed_hz = BSP_TOUCH_I2C_HZ,
    };
    const esp_lcd_touch_config_t touch_config = {
        .x_max = BSP_LCD_H_RES,
        .y_max = BSP_LCD_V_RES,
        .rst_gpio_num = BSP_TOUCH_RST,
        .int_gpio_num = BSP_TOUCH_INT,
        .levels = {
            .reset = 0,
            .interrupt = 0,
        },
        .flags = {
            .swap_xy = false,
            .mirror_x = false,
            .mirror_y = false,
        },
    };
    esp_lcd_panel_io_handle_t io = NULL;

    ESP_RETURN_ON_ERROR(
        i2c_new_master_bus(&bus_config, &s_i2c_bus),
        TAG,
        "i2c bus"
    );
    ESP_RETURN_ON_ERROR(
        esp_lcd_new_panel_io_i2c(s_i2c_bus, &io_config, &io),
        TAG,
        "touch io"
    );

    if (esp_lcd_touch_new_i2c_gt911(io, &touch_config, &s_touch) != ESP_OK) {
        /* The GT911 answers at 0x14 instead of 0x5D when its INT pin was
           sampled high during reset. */
        esp_lcd_panel_io_del(io);
        io = NULL;
        io_config.dev_addr = ESP_LCD_TOUCH_IO_I2C_GT911_ADDRESS_BACKUP;
        ESP_RETURN_ON_ERROR(
            esp_lcd_new_panel_io_i2c(s_i2c_bus, &io_config, &io),
            TAG,
            "touch io backup"
        );
        ESP_RETURN_ON_ERROR(
            esp_lcd_touch_new_i2c_gt911(io, &touch_config, &s_touch),
            TAG,
            "gt911"
        );
    }

    return ESP_OK;
}

lv_display_t *bsp_display_start(void)
{
    s_status = "display-power-init";
    if (power_init() != ESP_OK || backlight_init() != ESP_OK) {
        ESP_LOGE(TAG, "Power or backlight init failed");
        return NULL;
    }

    const lvgl_port_cfg_t lvgl_config = {
        .task_priority = 4,
        .task_stack = 16384,
        .task_affinity = -1,
        .task_max_sleep_ms = 20,
        .timer_period_ms = 5,
    };

    /* Elecrow's factory sequence initializes the DSI panel before LVGL. */
    s_status = "display-panel-init";
    if (panel_init() != ESP_OK) {
        ESP_LOGE(TAG, "Panel init failed");
        return NULL;
    }

    s_status = "display-lvgl-init";
    if (lvgl_port_init(&lvgl_config) != ESP_OK) {
        ESP_LOGE(TAG, "LVGL init failed");
        return NULL;
    }

    const lvgl_port_display_cfg_t display_config = {
        .io_handle = s_dbi_io,
        .panel_handle = s_panel,
        .control_handle = s_panel,
        .buffer_size = BSP_LCD_H_RES * BSP_LCD_V_RES,
        .double_buffer = true,
        .hres = BSP_LCD_H_RES,
        .vres = BSP_LCD_V_RES,
        .monochrome = false,
        .color_format = LV_COLOR_FORMAT_RGB565,
        .rotation = {
            .swap_xy = false,
            .mirror_x = false,
            .mirror_y = false,
        },
        .flags = {
            .buff_dma = false,
            .buff_spiram = true,
            /* ponytail: the DPI framebuffer takes native little-endian
               RGB565, same as LVGL renders; flip this single flag if
               hardware ever shows red/blue swapped. */
            .swap_bytes = false,
        },
    };
    const lvgl_port_display_dsi_cfg_t dsi_config = {
        .flags.avoid_tearing = false,
    };
    s_status = "display-lvgl-register";
    lv_display_t *display =
        lvgl_port_add_disp_dsi(&display_config, &dsi_config);

    if (display == NULL) {
        ESP_LOGE(TAG, "Could not register the DSI display with LVGL");
        return NULL;
    }

    /* Make display failures visible even if touch initialization fails. */
    s_status = "display-backlight";
    if (backlight_set(s_brightness_percent) != ESP_OK) {
        ESP_LOGE(TAG, "Could not turn the backlight on");
        return NULL;
    }
    s_display_awake = true;

    s_status = "display-touch-init";
    if (touch_init() != ESP_OK) {
        ESP_LOGW(TAG, "Touch init failed; continuing without touch");
        s_status = "display-ready-no-touch";
        return display;
    }

    const lvgl_port_touch_cfg_t touch_config = {
        .disp = display,
        .handle = s_touch,
    };

    lv_indev_t *touch = lvgl_port_add_touch(&touch_config);

    if (touch == NULL) {
        ESP_LOGW(TAG, "Could not register touch with LVGL");
        s_status = "display-ready-no-touch";
        return display;
    }

    /* ponytail: use one 15 ms polling path instead of mixing the GT911's
       100 Hz interrupt wake-up with LVGL's timer reads. Revisit event mode
       only with a driver that cannot lose or duplicate readiness edges. */
    if (esp_lcd_touch_register_interrupt_callback(s_touch, NULL) == ESP_OK) {
        lvgl_port_lock(0);
        lv_indev_set_mode(touch, LV_INDEV_MODE_TIMER);
        lvgl_port_unlock();
    } else {
        ESP_LOGW(TAG, "Could not disable touch interrupt; using event mode");
    }

    s_status = "display-ready";
    return display;
}

const char *bsp_display_status(void)
{
    return s_status;
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
    if (s_panel == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    if (awake) {
        ESP_RETURN_ON_ERROR(
            backlight_set(s_brightness_percent),
            TAG,
            "backlight on"
        );
        s_display_awake = true;
        return ESP_OK;
    }

    /* Keep the EK79007/DSI stream and LVGL touch polling alive while the
       display is blanked. The panel's disp_on_off command does not reliably
       resume on this board, and the backlight is the dominant power draw. */
    ESP_RETURN_ON_ERROR(backlight_set(0), TAG, "backlight off");
    s_display_awake = false;
    return ESP_OK;
}

esp_err_t bsp_display_set_brightness(uint32_t brightness_percent)
{
    if (brightness_percent > 100) {
        return ESP_ERR_INVALID_ARG;
    }

    if (s_panel == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    if (s_display_awake) {
        ESP_RETURN_ON_ERROR(
            backlight_set(brightness_percent),
            TAG,
            "backlight brightness"
        );
    }

    s_brightness_percent = brightness_percent;
    return ESP_OK;
}
