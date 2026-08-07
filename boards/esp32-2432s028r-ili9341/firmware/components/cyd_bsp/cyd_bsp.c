/*
 * ESP32-2432S028R "Cheap Yellow Display" BSP implementation.
 *
 * Pins follow the board's published Arduino/TFT_eSPI setup: the panel on SPI2
 * and XPT2046 on SPI3, with a PWM backlight on GPIO21. There is no PSRAM, so
 * LVGL draws through small DMA-capable line buffers in internal RAM.
 *
 * The panel is driven as an ST7789 even though listings and the profile id
 * say ILI9341. The ILI9341 init does light this screen, because the two share
 * the standard DCS subset, but its chip-specific power and gamma commands
 * leave an ST7789 half-configured: wrong colours, and MADCTL addressing
 * corrupt enough that an axis swap put pixels outside the visible window.
 */
#include "bsp/esp-bsp.h"

#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "esp_heap_caps.h"
#include "driver/ledc.h"
#include "driver/spi_master.h"
#include "esp_check.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_touch.h"
#include "esp_lcd_touch_xpt2046.h"
#include "esp_log.h"
#include "esp_lvgl_port.h"

#define BSP_LCD_SPI_HOST SPI2_HOST
#define BSP_TOUCH_SPI_HOST SPI3_HOST
#define BSP_LCD_PIXEL_CLOCK_HZ (40 * 1000 * 1000)
/* Partial-buffer height. Two DMA buffers of 320x20 RGB565 cost 25 KB of the
   internal RAM this board also has to fit a page of key artwork into. */
#define BSP_LCD_DRAW_LINES 20
#define BSP_BACKLIGHT_PWM_HZ 12000
#define BSP_BACKLIGHT_DUTY_MAX 1023

/* Pre-calibration fallback only: a straight linear map across the count
   window a typical XPT2046 reports, in the panel's own unrotated orientation.
   It is deliberately approximate, and on a panel whose range differs it
   leaves part of the screen out of reach. That is survivable because the
   wizard samples the digitiser directly rather than through this map, so a
   board can always be calibrated out of it. */
#define BSP_TOUCH_RAW_MIN 300
#define BSP_TOUCH_RAW_MAX 3800
#define BSP_TOUCH_ADC_MAX 4095
/* Landscape, because that is the shape the deck grid is laid out for. */
#define BSP_DEFAULT_ROTATION 90

static const char *TAG = "cyd_bsp";

static esp_lcd_panel_io_handle_t s_panel_io;
static esp_lcd_panel_handle_t s_panel;
static esp_lcd_touch_handle_t s_touch;
static const char *s_status = "display-not-started";
/* Holds a status that carries numbers with it; s_status points here then. */
static char s_status_detail[64];
static uint32_t s_brightness_percent = 100;
static bool s_display_awake;
/* Off, confirmed on hardware: this panel renders the deck's dark theme
   correctly without INVON, despite that being the usual ST7789 wiring.
   Overridable at runtime because the same model number ships with panels
   that disagree, and the board remembers the answer. */
static bool s_invert;
static uint16_t s_last_raw_x;
static uint16_t s_last_raw_y;
static bool s_touch_down;
static bool s_calibrated;
static float s_calibration[BSP_TOUCH_CALIBRATION_COEFFICIENTS];
static uint16_t s_rotation = BSP_DEFAULT_ROTATION;
static lv_display_t *s_display;

static esp_err_t backlight_init(void)
{
    const ledc_timer_config_t timer_config = {
        .clk_cfg = LEDC_AUTO_CLK,
        .duty_resolution = LEDC_TIMER_10_BIT,
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

    ESP_RETURN_ON_ERROR(ledc_timer_config(&timer_config), TAG, "ledc timer");
    return ledc_channel_config(&channel_config);
}

static esp_err_t backlight_set(uint32_t brightness_percent)
{
    const uint32_t duty =
        brightness_percent * BSP_BACKLIGHT_DUTY_MAX / 100;

    ESP_RETURN_ON_ERROR(
        ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, duty),
        TAG,
        "ledc duty"
    );
    return ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

static esp_err_t panel_init(void)
{
    const spi_bus_config_t bus_config = {
        .sclk_io_num = BSP_LCD_SPI_SCLK,
        .mosi_io_num = BSP_LCD_SPI_MOSI,
        .miso_io_num = GPIO_NUM_NC,
        .quadwp_io_num = GPIO_NUM_NC,
        .quadhd_io_num = GPIO_NUM_NC,
        .max_transfer_sz = BSP_LCD_H_RES * BSP_LCD_DRAW_LINES * 2,
    };
    const esp_lcd_panel_io_spi_config_t io_config = {
        .cs_gpio_num = BSP_LCD_SPI_CS,
        .dc_gpio_num = BSP_LCD_DC,
        .spi_mode = 0,
        .pclk_hz = BSP_LCD_PIXEL_CLOCK_HZ,
        .trans_queue_depth = 10,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
    };
    const esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = GPIO_NUM_NC,
        /* RGB, not the BGR most of this board's community configs specify.
           Confirmed on hardware: with BGR the amber title came out blue and
           the dark background picked up an orange cast, which is what
           swapping red and blue does to those two colours. */
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
    };

    s_status = "display-spi-bus";
    ESP_RETURN_ON_ERROR(
        spi_bus_initialize(BSP_LCD_SPI_HOST, &bus_config, SPI_DMA_CH_AUTO),
        TAG,
        "lcd spi bus"
    );
    s_status = "display-panel-io";
    ESP_RETURN_ON_ERROR(
        esp_lcd_new_panel_io_spi(
            (esp_lcd_spi_bus_handle_t)BSP_LCD_SPI_HOST,
            &io_config,
            &s_panel_io
        ),
        TAG,
        "lcd panel io"
    );
    s_status = "display-panel-create";
    ESP_RETURN_ON_ERROR(
        esp_lcd_new_panel_st7789(s_panel_io, &panel_config, &s_panel),
        TAG,
        "st7789"
    );
    s_status = "display-panel-reset";
    /* No reset GPIO on this board, so the driver issues a software reset. */
    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(s_panel), TAG, "panel reset");
    s_status = "display-controller-init";
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(s_panel), TAG, "panel init");

    /* Rotation is deliberately not set here. esp_lvgl_port rewrites MADCTL
       from its own rotation config when the display is registered, so
       anything set now is discarded; see the rotation field below. */
    ESP_RETURN_ON_ERROR(
        esp_lcd_panel_invert_color(s_panel, s_invert),
        TAG,
        "invert"
    );
    return esp_lcd_panel_disp_on_off(s_panel, true);
}

static esp_err_t touch_init(void)
{
    const spi_bus_config_t bus_config = {
        .sclk_io_num = BSP_TOUCH_SPI_SCLK,
        .mosi_io_num = BSP_TOUCH_SPI_MOSI,
        .miso_io_num = BSP_TOUCH_SPI_MISO,
        .quadwp_io_num = GPIO_NUM_NC,
        .quadhd_io_num = GPIO_NUM_NC,
        .max_transfer_sz = 32,
    };
    const esp_lcd_panel_io_spi_config_t io_config =
        ESP_LCD_TOUCH_IO_SPI_XPT2046_CONFIG(BSP_TOUCH_SPI_CS);
    const esp_lcd_touch_config_t touch_config = {
        .x_max = BSP_LCD_H_RES,
        .y_max = BSP_LCD_V_RES,
        .rst_gpio_num = GPIO_NUM_NC,
        /* PENIRQ stays unused: the driver leaves the XPT2046 in low-power
           mode where that output is not driven, and GPIO36 is input-only
           with no internal pull to hold it. LVGL polls instead. */
        .int_gpio_num = GPIO_NUM_NC,
    };
    esp_lcd_panel_io_handle_t io = NULL;

    ESP_RETURN_ON_ERROR(
        spi_bus_initialize(BSP_TOUCH_SPI_HOST, &bus_config, SPI_DMA_DISABLED),
        TAG,
        "touch spi bus"
    );
    ESP_RETURN_ON_ERROR(
        esp_lcd_new_panel_io_spi(
            (esp_lcd_spi_bus_handle_t)BSP_TOUCH_SPI_HOST,
            &io_config,
            &io
        ),
        TAG,
        "touch io"
    );
    return esp_lcd_touch_new_spi_xpt2046(io, &touch_config, &s_touch);
}

static int32_t clamp(int32_t value, int32_t span)
{
    if (value < 0) {
        return 0;
    }

    return value >= span ? span - 1 : value;
}

static int32_t map_fallback(uint16_t raw, int32_t span)
{
    const int32_t offset = (int32_t)raw - BSP_TOUCH_RAW_MIN;
    const int32_t range = BSP_TOUCH_RAW_MAX - BSP_TOUCH_RAW_MIN;

    return clamp(offset * (span - 1) / range, span);
}

/* The XPT2046 driver reports raw ADC counts: its own conversion is a
   full-range linear map that cannot express this panel's offset window, and
   it ignores rotation entirely. The stored affine transform handles offset,
   scale, axis swap and mirroring together.
 *
 * Both paths produce a point in the unrotated BSP_LCD_H_RES x BSP_LCD_V_RES
 * space, which is exactly what LVGL wants handed to it: it applies the
 * display rotation to pointer samples itself. Storing the calibration
 * unrotated is also what lets the display be turned afterwards without
 * asking for it again. */
static void apply_calibration(uint16_t raw_x, uint16_t raw_y, lv_point_t *point)
{
    if (!s_calibrated) {
        /* The digitiser shares the panel's axes, so an uncalibrated board
           maps straight through. */
        point->x = map_fallback(raw_x, BSP_LCD_H_RES);
        point->y = map_fallback(raw_y, BSP_LCD_V_RES);
        return;
    }

    const float x = s_calibration[0] * raw_x + s_calibration[1] * raw_y +
        s_calibration[2];
    const float y = s_calibration[3] * raw_x + s_calibration[4] * raw_y +
        s_calibration[5];

    point->x = clamp((int32_t)x, BSP_LCD_H_RES);
    point->y = clamp((int32_t)y, BSP_LCD_V_RES);
}

static void touch_read_cb(lv_indev_t *indev, lv_indev_data_t *data)
{
    uint16_t raw_x[1];
    uint16_t raw_y[1];
    uint8_t count = 0;

    (void)indev;
    data->state = LV_INDEV_STATE_RELEASED;

    if (esp_lcd_touch_read_data(s_touch) != ESP_OK ||
        !esp_lcd_touch_get_coordinates(s_touch, raw_x, raw_y, NULL, &count, 1) ||
        count == 0) {
        s_touch_down = false;
        return;
    }

    /* Published for the calibration wizard, which needs the uncalibrated
       sample and must not open a second reader on the shared SPI bus. */
    s_last_raw_x = raw_x[0];
    s_last_raw_y = raw_y[0];
    s_touch_down = true;

    /* Left unrotated on purpose. LVGL's indev_pointer_proc turns every
       pointer sample by the display rotation itself, using the same formula
       as deck_affine_rotate, so turning it here too rotated each touch twice
       and pushed a quarter of the screen out of reach. */
    apply_calibration(raw_x[0], raw_y[0], &data->point);
    data->state = LV_INDEV_STATE_PRESSED;
}

lv_display_t *bsp_display_start(void)
{
    s_status = "display-backlight-init";
    if (backlight_init() != ESP_OK) {
        ESP_LOGE(TAG, "Backlight init failed");
        return NULL;
    }

    s_status = "display-panel-init";
    if (panel_init() != ESP_OK) {
        ESP_LOGE(TAG, "Panel init failed");
        return NULL;
    }

    const lvgl_port_cfg_t lvgl_config = {
        .task_priority = 4,
        .task_stack = 6144,
        .task_affinity = -1,
        .task_max_sleep_ms = 20,
        .timer_period_ms = 5,
    };

    s_status = "display-lvgl-init";
    if (lvgl_port_init(&lvgl_config) != ESP_OK) {
        ESP_LOGE(TAG, "LVGL init failed");
        return NULL;
    }

    const lvgl_port_display_cfg_t display_config = {
        .io_handle = s_panel_io,
        .panel_handle = s_panel,
        .buffer_size = BSP_LCD_H_RES * BSP_LCD_DRAW_LINES,
        .double_buffer = true,
        .hres = BSP_LCD_H_RES,
        .vres = BSP_LCD_V_RES,
        .monochrome = false,
        .color_format = LV_COLOR_FORMAT_RGB565,
        /* The panel's own orientation is the base; turning it is a rotation
           on top, applied to MADCTL by lvgl_port. Setting anything here would
           be overwritten by that, so this is the one place it may be set. */
        .rotation = {
            .swap_xy = false,
            .mirror_x = false,
            .mirror_y = false,
        },
        .flags = {
            .buff_dma = true,
            .buff_spiram = false,
            /* An SPI panel takes RGB565 big-endian; LVGL renders it little-
               endian. Without this every color comes out wrong. */
            .swap_bytes = true,
        },
    };

    s_status = "display-lvgl-register";
    lv_display_t *display = lvgl_port_add_disp(&display_config);

    if (display == NULL) {
        /* Almost always the DMA-capable draw buffers on a board with no
           PSRAM, and the console is off here, so the numbers travel back in
           the status the desktop already shows. Guessing at this from the
           stage name alone cost several flashes. */
        snprintf(
            s_status_detail,
            sizeof(s_status_detail),
            "display-lvgl-register-dma-%u-max-%u",
            (unsigned)heap_caps_get_free_size(MALLOC_CAP_DMA),
            (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_DMA)
        );
        s_status = s_status_detail;
        ESP_LOGE(TAG, "Could not register the display with LVGL");
        return NULL;
    }

    s_display = display;

    /* The deck grid is laid out for landscape, so that is where the panel
       starts. deck_settings overrides this from NVS if the user picked
       something else. */
    bsp_display_set_rotation(BSP_DEFAULT_ROTATION);

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

    /* Not lvgl_port_add_touch: that path feeds esp_lcd_touch coordinates
       straight to LVGL, and this driver reports uncalibrated raw ADC counts
       for a portrait panel. */
    lvgl_port_lock(0);
    lv_indev_t *input = lv_indev_create();

    if (input != NULL) {
        lv_indev_set_type(input, LV_INDEV_TYPE_POINTER);
        lv_indev_set_display(input, display);
        lv_indev_set_read_cb(input, touch_read_cb);
    }

    lvgl_port_unlock();

    if (input == NULL) {
        ESP_LOGW(TAG, "Could not register touch with LVGL");
        s_status = "display-ready-no-touch";
        return display;
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

    /* Blank with the backlight alone and leave the panel and touch polling
       running, so the first touch after an idle timeout still wakes it. */
    ESP_RETURN_ON_ERROR(
        backlight_set(awake ? s_brightness_percent : 0),
        TAG,
        "backlight"
    );
    s_display_awake = awake;
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

bool bsp_touch_read_raw(uint16_t *raw_x, uint16_t *raw_y)
{
    if (raw_x != NULL) {
        *raw_x = s_last_raw_x;
    }

    if (raw_y != NULL) {
        *raw_y = s_last_raw_y;
    }

    return s_touch_down;
}

esp_err_t bsp_touch_set_calibration(
    const float coefficients[BSP_TOUCH_CALIBRATION_COEFFICIENTS]
)
{
    if (s_touch == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    if (coefficients == NULL) {
        /* Back to the approximate map, which is what the wizard needs to be
           usable again after a bad calibration. */
        s_calibrated = false;
        return ESP_OK;
    }

    memcpy(s_calibration, coefficients, sizeof(s_calibration));
    s_calibrated = true;
    return ESP_OK;
}

esp_err_t bsp_display_set_invert(bool invert)
{
    if (s_panel == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    ESP_RETURN_ON_ERROR(
        esp_lcd_panel_invert_color(s_panel, invert),
        TAG,
        "invert"
    );
    s_invert = invert;
    return ESP_OK;
}

bool bsp_display_invert(void)
{
    return s_invert;
}

esp_err_t bsp_display_set_rotation(uint16_t degrees)
{
    static const lv_display_rotation_t ROTATIONS[] = {
        LV_DISPLAY_ROTATION_0,
        LV_DISPLAY_ROTATION_90,
        LV_DISPLAY_ROTATION_180,
        LV_DISPLAY_ROTATION_270,
    };

    if (degrees % 90 != 0 || degrees > 270) {
        return ESP_ERR_INVALID_ARG;
    }

    if (s_display == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    /* lv_display_set_rotation swaps LVGL's own resolution and fires the size
       event that makes esp_lvgl_port rewrite the panel's MADCTL, so this one
       call turns both the framebuffer and the glass. */
    lvgl_port_lock(0);
    lv_display_set_rotation(s_display, ROTATIONS[degrees / 90]);
    lvgl_port_unlock();
    s_rotation = degrees;
    return ESP_OK;
}

uint16_t bsp_display_rotation(void)
{
    return s_rotation;
}
