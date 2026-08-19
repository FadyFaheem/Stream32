#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "bsp/esp-bsp.h"
#include "cJSON.h"
#include "deck_layout.h"
#include "deck_protocol.h"
#include "deck_ui.h"
#include "driver/usb_serial_jtag.h"
#include "esp_app_desc.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lvgl.h"

#define STREAM32_BOARD_ID "waveshare-esp32-s3-touch-lcd-4-v4"
#define STREAM32_PROTOCOL_VERSION 1
/* Matches the desktop's protocol line limit; image chunks fill whole lines. */
#define STREAM32_LINE_CAPACITY 4096
#define STREAM32_USB_BUFFER_SIZE 4096
#define STREAM32_EVENT_LINE_CAPACITY 128
#define STREAM32_REPLY_CAPACITY 384

static const char *TAG = "stream32";
static QueueHandle_t event_queue;
/* Serializes dispatch and every physical write. Queued touch events are the
   one writer outside dispatch, and they now run on their own task. */
static SemaphoreHandle_t protocol_mutex;
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

/* Queues a ready-to-send JSON line from LVGL/event context. */
static void queue_event_line(const char *json)
{
    char line[STREAM32_EVENT_LINE_CAPACITY];

    strlcpy(line, json, sizeof(line));
    (void)xQueueSend(event_queue, line, 0);
}

/* A key press is the one event the desktop is waiting on, so it gets its own
   task. Draining the queue from the protocol task instead made every press
   wait out that task's receive timeout before it reached the wire. */
static void event_writer_task(void *argument)
{
    char event_line[STREAM32_EVENT_LINE_CAPACITY];

    (void)argument;

    while (true) {
        if (xQueueReceive(event_queue, event_line, portMAX_DELAY) != pdTRUE) {
            continue;
        }

        /* Events are the one writer outside dispatch, so they take the same
           lock to stay off a half-written reply. */
        xSemaphoreTake(protocol_mutex, portMAX_DELAY);
        usb_write_line(event_line);
        xSemaphoreGive(protocol_mutex);
    }
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
    /* Sized for the worst case the compiler has to assume: esp_app_desc_t
       carries a 32-byte version, and the feature list grows over time. This
       build fit 256 with nothing to spare, which the next feature would
       have broken. */
    char message[384];
    const esp_app_desc_t *app = esp_app_get_description();

    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
    snprintf(
        message,
        sizeof(message),
        "{\"type\":\"hello\",\"protocol\":%d,\"boardId\":\"%s\","
        "\"firmwareVersion\":\"%s\",\"deviceId\":\"%02x%02x%02x%02x%02x%02x\","
        "\"features\":[\"display-control\",\"display-brightness\",\"display-blank\","
        "\"display-invert\",\"display-icon-size\",\"display-label-lines\","
        "\"key-update\",\"image-rle\",\"clean-mode\"]}",
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
    static char reply[STREAM32_REPLY_CAPACITY];

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
            deck_protocol_clear_overlays();
            update_connection_label("USB connected to Stream32");
            send_hello();

            /* A cleaning lock outlives the USB link, so a desktop that
               reconnects mid-wipe learns the panel is still locked. */
            if (deck_ui_clean_active()) {
                usb_write_line("{\"type\":\"clean\",\"active\":true}");
            }

            /* Inversion is stored on the board, so the desktop has to be told
               where the toggle actually sits. */
            char state[128];

            snprintf(
                state,
                sizeof(state),
                "{\"type\":\"display\",\"invert\":%s,\"iconSize\":%u,"
                "\"labelLines\":%u}",
                bsp_display_invert() ? "true" : "false",
                (unsigned)deck_layout_icon_percent(),
                (unsigned)deck_layout_label_lines()
            );
            usb_write_line(state);
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
        const char *error = NULL;
        const bool handled = deck_protocol_dispatch(
            message,
            line,
            length,
            reply,
            sizeof(reply),
            usb_write_line,
            &error
        );

        if (!handled) {
            send_error("unknown-type");
        } else if (error != NULL) {
            send_error(error);
        }
    }

    cJSON_Delete(message);
}

static void usb_protocol_task(void *argument)
{
    usb_serial_jtag_driver_config_t config = {
        .tx_buffer_size = STREAM32_USB_BUFFER_SIZE,
        .rx_buffer_size = STREAM32_USB_BUFFER_SIZE,
    };
    uint8_t incoming[256];
    /* Static: a 4 KB line does not belong on the task stack. */
    static char line[STREAM32_LINE_CAPACITY];
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
                xSemaphoreTake(protocol_mutex, portMAX_DELAY);

                if (dropping_oversized_line) {
                    send_error("message-too-large");
                } else if (line_length > 0) {
                    handle_host_message(line, line_length);
                }

                xSemaphoreGive(protocol_mutex);
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

        deck_ui_poll();
    }
}

static void touch_event_handler(lv_event_t *event)
{
    const lv_event_code_t code = lv_event_get_code(event);

    if (code != LV_EVENT_PRESSED && code != LV_EVENT_RELEASED) {
        return;
    }

    if (deck_ui_handle_touch(code == LV_EVENT_PRESSED)) {
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

    char line[STREAM32_EVENT_LINE_CAPACITY];

    snprintf(
        line,
        sizeof(line),
        "{\"type\":\"touch\",\"phase\":\"%s\",\"x\":%d,\"y\":%d}",
        phase,
        (int)point.x,
        (int)point.y
    );
    queue_event_line(line);
}

static void create_self_test_ui(void)
{
    lv_obj_t *screen = lv_screen_active();
    lv_obj_add_flag(screen, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(screen, touch_event_handler, LV_EVENT_ALL, NULL);
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
    event_queue = xQueueCreate(24, STREAM32_EVENT_LINE_CAPACITY);
    protocol_mutex = xSemaphoreCreateMutex();

    if (event_queue == NULL || protocol_mutex == NULL) {
        ESP_LOGE(TAG, "Could not allocate the protocol primitives");
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

    /* Restores the persisted deck; the self-test screen stays visible when
       no deck has ever been synced. */
    if (deck_ui_init(queue_event_line) != ESP_OK) {
        ESP_LOGW(TAG, "Deck storage is unavailable; decks will not persist");
    }

    const BaseType_t task_created = xTaskCreate(
        usb_protocol_task,
        "stream32_usb",
        8192,
        NULL,
        5,
        NULL
    );

    if (task_created != pdPASS) {
        ESP_LOGE(TAG, "Could not create the USB protocol task");
        return;
    }

    if (xTaskCreate(event_writer_task, "stream32_events", 3072, NULL, 5, NULL) !=
        pdPASS) {
        ESP_LOGE(TAG, "Could not create the event writer task");
    }
}
