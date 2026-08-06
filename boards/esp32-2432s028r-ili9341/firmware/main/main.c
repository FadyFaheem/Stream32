#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "bsp/esp-bsp.h"
#include "cJSON.h"
#include "deck_protocol.h"
#include "deck_ui.h"
#include "driver/gpio.h"
#include "driver/uart.h"
#include "esp_app_desc.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lvgl.h"

#define STREAM32_BOARD_ID "esp32-2432s028r-ili9341"
#define STREAM32_PROTOCOL_VERSION 1
/* The classic ESP32 has no native USB, so the board's on-board USB-serial
   bridge on UART0 is the only link. The console is disabled in sdkconfig so
   protocol lines stay clean. */
#define STREAM32_UART UART_NUM_0
#define STREAM32_UART_BAUD 115200
#define STREAM32_UART_TX GPIO_NUM_1
#define STREAM32_UART_RX GPIO_NUM_3
/* This board advertises a 12-key page budget, which fits the baseline 4 KB
   layout line every protocol-1 firmware accepts. */
#define STREAM32_LINE_CAPACITY 4096
#define STREAM32_UART_BUFFER_SIZE 4096
#define STREAM32_EVENT_LINE_CAPACITY 128
#define STREAM32_REPLY_CAPACITY 384

/* Assembler for newline-delimited JSON. */
typedef struct {
    char *buffer;
    size_t capacity;
    size_t length;
    bool dropping_oversized_line;
} line_reader_t;

static const char *TAG = "stream32";
static QueueHandle_t event_queue;
/* Serializes dispatch and every physical write. deck_protocol keeps static
   decode state, and queued touch events are the one writer outside dispatch. */
static SemaphoreHandle_t protocol_mutex;
static lv_obj_t *connection_label;
static lv_obj_t *touch_label;
static lv_obj_t *touch_surface;
static volatile bool system_ready;

static void serial_write_line(const char *json)
{
    /* uart_write_bytes blocks until the line fits the TX ring buffer. */
    uart_write_bytes(STREAM32_UART, json, strlen(json));
    uart_write_bytes(STREAM32_UART, "\n", 1);
}

/* Queues a ready-to-send JSON line from LVGL/event context. */
static void queue_event_line(const char *json)
{
    char line[STREAM32_EVENT_LINE_CAPACITY];

    strlcpy(line, json, sizeof(line));
    (void)xQueueSend(event_queue, line, 0);
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
    char message[288];
    const esp_app_desc_t *app = esp_app_get_description();

    /* Reads the efuse MAC; the radio is never started. */
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
    snprintf(
        message,
        sizeof(message),
        "{\"type\":\"hello\",\"protocol\":%d,\"boardId\":\"%s\","
        "\"firmwareVersion\":\"%s\",\"deviceId\":\"%02x%02x%02x%02x%02x%02x\","
        "\"features\":[\"display-control\",\"display-brightness\","
        "\"display-blank\",\"display-invert\",\"key-update\",\"image-rle\","
        "\"clean-mode\",\"touch-calibration\"]}",
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
    serial_write_line(message);
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
    serial_write_line(message);
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
        } else if (!system_ready) {
            send_error(bsp_display_status());
        } else {
            deck_protocol_clear_overlays();
            update_connection_label("Connected to Stream32");
            send_hello();

            /* A cleaning lock outlives the link, so a desktop that reconnects
               mid-wipe learns the panel is still locked. */
            if (deck_ui_clean_active()) {
                serial_write_line("{\"type\":\"clean\",\"active\":true}");
            }

            /* Inversion is stored on the board, so the desktop has to be told
               where the toggle actually sits. */
            serial_write_line(
                bsp_display_invert()
                    ? "{\"type\":\"display\",\"invert\":true}"
                    : "{\"type\":\"display\",\"invert\":false}"
            );
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
            serial_write_line(response);
        }
    } else {
        const char *error = NULL;
        const bool handled = deck_protocol_dispatch(
            message,
            line,
            length,
            reply,
            sizeof(reply),
            serial_write_line,
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

/* Feeds the link's bytes into the assembler and dispatches whole lines under
   the shared lock. */
static void consume_bytes(
    line_reader_t *reader,
    const uint8_t *data,
    size_t count
)
{
    for (size_t index = 0; index < count; index++) {
        const char byte = (char)data[index];

        if (byte != '\n') {
            if (byte != '\r' && !reader->dropping_oversized_line) {
                if (reader->length < reader->capacity - 1) {
                    reader->buffer[reader->length++] = byte;
                } else {
                    reader->dropping_oversized_line = true;
                }
            }

            continue;
        }

        xSemaphoreTake(protocol_mutex, portMAX_DELAY);

        if (reader->dropping_oversized_line) {
            send_error("message-too-large");
        } else if (reader->length > 0) {
            handle_host_message(reader->buffer, reader->length);
        }

        xSemaphoreGive(protocol_mutex);
        reader->length = 0;
        reader->dropping_oversized_line = false;
    }
}

static void serial_protocol_task(void *argument)
{
    const uart_config_t config = {
        .baud_rate = STREAM32_UART_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    uint8_t incoming[256];
    /* Static: a 4 KB line does not belong on the task stack. */
    static char line[STREAM32_LINE_CAPACITY];
    line_reader_t reader = {
        .buffer = line,
        .capacity = sizeof(line),
    };

    (void)argument;
    ESP_ERROR_CHECK(uart_driver_install(
        STREAM32_UART,
        STREAM32_UART_BUFFER_SIZE,
        STREAM32_UART_BUFFER_SIZE,
        0,
        NULL,
        0
    ));
    ESP_ERROR_CHECK(uart_param_config(STREAM32_UART, &config));
    /* Do not rely on ROM routing surviving the console-disabled app startup:
       the bridge is wired to the ESP32's default UART0 pins. */
    ESP_ERROR_CHECK(uart_set_pin(
        STREAM32_UART,
        STREAM32_UART_TX,
        STREAM32_UART_RX,
        UART_PIN_NO_CHANGE,
        UART_PIN_NO_CHANGE
    ));

    while (true) {
        const int received = uart_read_bytes(
            STREAM32_UART,
            incoming,
            sizeof(incoming),
            pdMS_TO_TICKS(20)
        );

        if (received > 0) {
            consume_bytes(&reader, incoming, (size_t)received);
        }

        deck_ui_poll();

        char event_line[STREAM32_EVENT_LINE_CAPACITY];

        while (xQueueReceive(event_queue, event_line, 0) == pdTRUE) {
            /* Touch and press events are the one writer outside dispatch, so
               they take the same lock to stay off a half-written reply. */
            xSemaphoreTake(protocol_mutex, portMAX_DELAY);
            serial_write_line(event_line);
            xSemaphoreGive(protocol_mutex);
        }
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
    uint16_t raw_x = 0;
    uint16_t raw_y = 0;

    lv_indev_get_point(input, &point);
    bsp_touch_last_raw(&raw_x, &raw_y);
    /* The raw pair is the only way to calibrate this resistive panel: the
       console is disabled because UART0 carries the protocol. */
    lv_label_set_text_fmt(
        touch_label,
        "Touch %s\nX %ld   Y %ld\nraw %u / %u",
        phase,
        (long)point.x,
        (long)point.y,
        (unsigned)raw_x,
        (unsigned)raw_y
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
    lv_obj_set_style_text_font(title, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 8);

    connection_label = lv_label_create(screen);
    lv_label_set_text(connection_label, "Waiting for the desktop app");
    lv_obj_set_style_text_color(
        connection_label,
        lv_color_hex(0x91a6b5),
        LV_PART_MAIN
    );
    lv_obj_align(connection_label, LV_ALIGN_TOP_MID, 0, 36);

    touch_surface = lv_obj_create(screen);
    lv_obj_set_size(touch_surface, 296, 148);
    lv_obj_align(touch_surface, LV_ALIGN_BOTTOM_MID, 0, -12);
    lv_obj_set_style_radius(touch_surface, 16, LV_PART_MAIN);
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
    lv_label_set_text(hint, "Touch each corner to calibrate");
    lv_obj_set_style_text_color(hint, lv_color_hex(0x91a6b5), LV_PART_MAIN);
    lv_obj_align(hint, LV_ALIGN_TOP_MID, 0, 0);

    touch_label = lv_label_create(touch_surface);
    lv_label_set_text(touch_label, "Touch ready\nX --   Y --\nraw -- / --");
    lv_obj_set_style_text_align(touch_label, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
    lv_obj_align(touch_label, LV_ALIGN_CENTER, 0, 16);
}

void app_main(void)
{
    event_queue = xQueueCreate(24, STREAM32_EVENT_LINE_CAPACITY);
    protocol_mutex = xSemaphoreCreateMutex();

    if (event_queue == NULL || protocol_mutex == NULL) {
        ESP_LOGE(TAG, "Could not allocate the protocol primitives");
        return;
    }

    /* Start communication before display bring-up. A slow panel init no
       longer misses every desktop hello, and UART remains available for
       startup diagnostics if the BSP fails. */
    const BaseType_t task_created = xTaskCreate(
        serial_protocol_task,
        "stream32_uart",
        6144,
        NULL,
        5,
        NULL
    );

    if (task_created != pdPASS) {
        ESP_LOGE(TAG, "Could not create the serial protocol task");
        return;
    }

    lv_display_t *display = bsp_display_start();

    if (display == NULL) {
        ESP_LOGE(TAG, "Display initialization failed");
        return;
    }

    if (!bsp_display_lock(1000)) {
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

    system_ready = true;
}
