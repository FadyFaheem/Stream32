#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "bsp/esp-bsp.h"
#include "cJSON.h"
#include "driver/usb_serial_jtag.h"
#include "esp_app_desc.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "lvgl.h"

#define STREAM32_BOARD_ID "waveshare-esp32-s3-touch-lcd-4-v3"
#define STREAM32_PROTOCOL_VERSION 1
#define STREAM32_LINE_CAPACITY 256
#define STREAM32_USB_BUFFER_SIZE 1024

typedef struct {
    const char *phase;
    int16_t x;
    int16_t y;
} touch_message_t;

static const char *TAG = "stream32";
static QueueHandle_t touch_queue;
static lv_obj_t *connection_label;
static lv_obj_t *touch_label;
static lv_obj_t *touch_surface;

static void usb_write_all(const char *data, size_t length)
{
    size_t written = 0;

    while (written < length) {
        const int result = usb_serial_jtag_write_bytes(
            data + written,
            length - written,
            pdMS_TO_TICKS(100)
        );

        if (result <= 0) {
            ESP_LOGW(TAG, "USB write timed out");
            return;
        }

        written += (size_t)result;
    }
}

static void usb_write_line(const char *json)
{
    usb_write_all(json, strlen(json));
    usb_write_all("\n", 1);
}

static void update_connection_label(const char *text)
{
    if (connection_label == NULL || !bsp_display_lock(100)) {
        return;
    }

    lv_label_set_text(connection_label, text);
    bsp_display_unlock();
}

static void send_hello(void)
{
    uint8_t mac[6];
    char message[256];
    const esp_app_desc_t *app = esp_app_get_description();

    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
    snprintf(
        message,
        sizeof(message),
        "{\"type\":\"hello\",\"protocol\":%d,\"boardId\":\"%s\","
        "\"firmwareVersion\":\"%s\",\"deviceId\":\"%02x%02x%02x%02x%02x%02x\"}",
        STREAM32_PROTOCOL_VERSION,
        STREAM32_BOARD_ID,
        app->version,
        mac[0],
        mac[1],
        mac[2],
        mac[3],
        mac[4],
        mac[5]
    );
    usb_write_line(message);
}

static void send_error(const char *code)
{
    char message[128];

    snprintf(
        message,
        sizeof(message),
        "{\"type\":\"error\",\"code\":\"%s\"}",
        code
    );
    usb_write_line(message);
}

static void handle_host_message(const char *line, size_t length)
{
    cJSON *message = cJSON_ParseWithLength(line, length);

    if (message == NULL) {
        send_error("invalid-json");
        return;
    }

    const cJSON *type = cJSON_GetObjectItemCaseSensitive(message, "type");

    if (!cJSON_IsString(type) || type->valuestring == NULL) {
        send_error("missing-type");
    } else if (strcmp(type->valuestring, "hello") == 0) {
        const cJSON *protocol = cJSON_GetObjectItemCaseSensitive(
            message,
            "protocol"
        );

        if (!cJSON_IsNumber(protocol) ||
            protocol->valueint != STREAM32_PROTOCOL_VERSION) {
            send_error("unsupported-protocol");
        } else {
            update_connection_label("USB connected to Stream32");
            send_hello();
        }
    } else if (strcmp(type->valuestring, "ping") == 0) {
        const cJSON *id = cJSON_GetObjectItemCaseSensitive(message, "id");

        if (!cJSON_IsNumber(id)) {
            send_error("invalid-ping");
        } else {
            char response[96];

            snprintf(
                response,
                sizeof(response),
                "{\"type\":\"pong\",\"id\":%d}",
                id->valueint
            );
            usb_write_line(response);
        }
    } else {
        send_error("unknown-type");
    }

    cJSON_Delete(message);
}

static void send_touch_message(const touch_message_t *touch)
{
    char message[128];

    snprintf(
        message,
        sizeof(message),
        "{\"type\":\"touch\",\"phase\":\"%s\",\"x\":%d,\"y\":%d}",
        touch->phase,
        touch->x,
        touch->y
    );
    usb_write_line(message);
}

static void usb_protocol_task(void *argument)
{
    usb_serial_jtag_driver_config_t config = {
        .tx_buffer_size = STREAM32_USB_BUFFER_SIZE,
        .rx_buffer_size = STREAM32_USB_BUFFER_SIZE,
    };
    uint8_t incoming[64];
    char line[STREAM32_LINE_CAPACITY];
    size_t line_length = 0;
    bool dropping_oversized_line = false;

    (void)argument;
    ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&config));

    while (true) {
        const int received = usb_serial_jtag_read_bytes(
            incoming,
            sizeof(incoming),
            pdMS_TO_TICKS(20)
        );

        for (int index = 0; index < received; index++) {
            const char byte = (char)incoming[index];

            if (byte == '\n') {
                if (dropping_oversized_line) {
                    send_error("message-too-large");
                } else if (line_length > 0) {
                    handle_host_message(line, line_length);
                }

                line_length = 0;
                dropping_oversized_line = false;
            } else if (byte != '\r' && !dropping_oversized_line) {
                if (line_length < sizeof(line) - 1) {
                    line[line_length++] = byte;
                } else {
                    dropping_oversized_line = true;
                }
            }
        }

        touch_message_t touch;

        while (xQueueReceive(touch_queue, &touch, 0) == pdTRUE) {
            send_touch_message(&touch);
        }
    }
}

static void touch_event_handler(lv_event_t *event)
{
    const lv_event_code_t code = lv_event_get_code(event);

    if (code != LV_EVENT_PRESSED && code != LV_EVENT_RELEASED) {
        return;
    }

    lv_indev_t *input = lv_indev_active();

    if (input == NULL) {
        return;
    }

    lv_point_t point;
    const char *phase = code == LV_EVENT_PRESSED ? "down" : "up";

    lv_indev_get_point(input, &point);
    lv_label_set_text_fmt(
        touch_label,
        "Touch %s\nX %ld   Y %ld",
        phase,
        (long)point.x,
        (long)point.y
    );
    lv_obj_set_style_bg_color(
        touch_surface,
        code == LV_EVENT_PRESSED
            ? lv_color_hex(0x5a3a08)
            : lv_color_hex(0x172630),
        LV_PART_MAIN
    );

    const touch_message_t touch = {
        .phase = phase,
        .x = (int16_t)point.x,
        .y = (int16_t)point.y,
    };

    (void)xQueueSend(touch_queue, &touch, 0);
}

static void create_self_test_ui(void)
{
    lv_obj_t *screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, lv_color_hex(0x0b1116), LV_PART_MAIN);
    lv_obj_set_style_text_color(screen, lv_color_hex(0xf3f7f9), LV_PART_MAIN);

    lv_obj_t *title = lv_label_create(screen);
    lv_label_set_text(title, "Stream32");
    lv_obj_set_style_text_color(title, lv_color_hex(0xffad22), LV_PART_MAIN);
    lv_obj_set_style_text_font(title, &lv_font_montserrat_28, LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 30);

    connection_label = lv_label_create(screen);
    lv_label_set_text(connection_label, "Waiting for the desktop app");
    lv_obj_set_style_text_color(
        connection_label,
        lv_color_hex(0x91a6b5),
        LV_PART_MAIN
    );
    lv_obj_align(connection_label, LV_ALIGN_TOP_MID, 0, 78);

    touch_surface = lv_obj_create(screen);
    lv_obj_set_size(touch_surface, 410, 280);
    lv_obj_align(touch_surface, LV_ALIGN_BOTTOM_MID, 0, -34);
    lv_obj_set_style_radius(touch_surface, 20, LV_PART_MAIN);
    lv_obj_set_style_bg_color(
        touch_surface,
        lv_color_hex(0x172630),
        LV_PART_MAIN
    );
    lv_obj_set_style_border_color(
        touch_surface,
        lv_color_hex(0x29404d),
        LV_PART_MAIN
    );
    lv_obj_set_style_border_width(touch_surface, 2, LV_PART_MAIN);
    lv_obj_add_flag(touch_surface, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(
        touch_surface,
        touch_event_handler,
        LV_EVENT_ALL,
        NULL
    );

    lv_obj_t *hint = lv_label_create(touch_surface);
    lv_label_set_text(hint, "Touch anywhere in this area");
    lv_obj_set_style_text_color(hint, lv_color_hex(0x91a6b5), LV_PART_MAIN);
    lv_obj_align(hint, LV_ALIGN_TOP_MID, 0, 42);

    touch_label = lv_label_create(touch_surface);
    lv_label_set_text(touch_label, "Touch ready\nX --   Y --");
    lv_obj_set_style_text_align(touch_label, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
    lv_obj_set_style_text_font(
        touch_label,
        &lv_font_montserrat_20,
        LV_PART_MAIN
    );
    lv_obj_align(touch_label, LV_ALIGN_CENTER, 0, 28);
}

void app_main(void)
{
    touch_queue = xQueueCreate(16, sizeof(touch_message_t));

    if (touch_queue == NULL) {
        ESP_LOGE(TAG, "Could not allocate the touch event queue");
        return;
    }

    lv_display_t *display = bsp_display_start();

    if (display == NULL) {
        ESP_LOGE(TAG, "Display initialization failed");
        return;
    }

    if (!bsp_display_lock(0)) {
        ESP_LOGE(TAG, "Could not lock LVGL");
        return;
    }

    create_self_test_ui();
    bsp_display_unlock();

    const BaseType_t task_created = xTaskCreate(
        usb_protocol_task,
        "stream32_usb",
        6144,
        NULL,
        5,
        NULL
    );

    if (task_created != pdPASS) {
        ESP_LOGE(TAG, "Could not create the USB protocol task");
    }
}
