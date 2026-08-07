#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "bsp/esp-bsp.h"
#include "cJSON.h"
#include "deck_layout.h"
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
#include "tinyusb.h"
#include "tinyusb_cdc_acm.h"
#include "tinyusb_default_config.h"

#define STREAM32_BOARD_ID "elecrow-crowpanel-advanced-10-1-esp32-p4"
#define STREAM32_PROTOCOL_VERSION 1
/* The desktop talks to the board through the CH340 bridge on UART0; the
   console is disabled in sdkconfig so protocol lines stay clean. */
#define STREAM32_UART UART_NUM_0
#define STREAM32_UART_BAUD 115200
#define STREAM32_UART_TX GPIO_NUM_37
#define STREAM32_UART_RX GPIO_NUM_38
/* The CrowPanel's second USB-C port wires D+/D- straight to the ESP32-P4's
   USB 2.0 high-speed PHY (module pads 50/49), so CDC-ACM turns the port
   Elecrow ships as power-only into a 480 Mbit/s protocol link. UART0 stays
   live beside it: it is the only way to flash this board, and the desktop
   holds it open across the manual post-flash reset. */
#define STREAM32_USB_CDC TINYUSB_CDC_ACM_0
#define STREAM32_USB_READ_CHUNK 512
#define STREAM32_USB_WRITE_TIMEOUT_MS 100
/* Safety net only: the CDC receive callback wakes the reader immediately. */
#define STREAM32_USB_IDLE_POLL_MS 50
/* This board advertises a 40-key page budget, so it accepts the extended
   8 KB layout line (the desktop's baseline for other messages is 4 KB). */
#define STREAM32_LINE_CAPACITY 8192
#define STREAM32_UART_BUFFER_SIZE 8192
#define STREAM32_EVENT_LINE_CAPACITY 128
#define STREAM32_REPLY_CAPACITY 384

typedef enum {
    STREAM32_LINK_UART = 0,
    STREAM32_LINK_USB,
} stream32_link_t;

/* Per-transport assembler for newline-delimited JSON. */
typedef struct {
    stream32_link_t link;
    char *buffer;
    size_t capacity;
    size_t length;
    bool dropping_oversized_line;
} line_reader_t;

static const char *TAG = "stream32";
static QueueHandle_t event_queue;
/* Serializes dispatch and every physical write. deck_protocol keeps static
   decode state and both transports share this file's reply buffer, so only
   one link may be mid-message at a time. */
static SemaphoreHandle_t protocol_mutex;
/* The transport that delivered the last complete host line. Replies and
   queued events follow it, so the desktop always hears back on the link it
   is actually talking on. */
static stream32_link_t active_link = STREAM32_LINK_UART;
static lv_obj_t *connection_label;
static lv_obj_t *touch_label;
static lv_obj_t *touch_surface;
static volatile bool system_ready;
static TaskHandle_t usb_task;
/* Filled from the efuse MAC before TinyUSB starts. */
static char usb_serial_string[13];
/* Index order is TinyUSB's default: language, manufacturer, product, serial,
   CDC interface. Naming the device keeps the fast link tellable from the
   CH340 bridge in the desktop's port list, and the per-board serial keeps two
   panels on one host distinct. File scope: the language compound literal
   needs static storage duration. */
static const char *usb_strings[] = {
    (const char[]){0x09, 0x04},
    "Stream32",
    "Stream32 CrowPanel 10.1",
    usb_serial_string,
    "Stream32 deck link",
};

static bool usb_flush(void)
{
    return tinyusb_cdcacm_write_flush(
               STREAM32_USB_CDC,
               pdMS_TO_TICKS(STREAM32_USB_WRITE_TIMEOUT_MS)
           ) == ESP_OK;
}

/* Queues one span, flushing only when the TX FIFO fills so a whole line
   normally costs a single USB transfer. Returns false once the host stops
   draining, which abandons the line instead of stalling the protocol task. */
static bool usb_queue_all(const char *data, size_t length)
{
    size_t written = 0;

    while (written < length) {
        written += tinyusb_cdcacm_write_queue(
            STREAM32_USB_CDC,
            (const uint8_t *)data + written,
            length - written
        );

        if (written < length && !usb_flush()) {
            return false;
        }
    }

    return true;
}

static void serial_write_line(const char *json)
{
    const size_t length = strlen(json);

    if (active_link == STREAM32_LINK_USB) {
        if (usb_queue_all(json, length) && usb_queue_all("\n", 1)) {
            (void)usb_flush();
        }

        return;
    }

    /* uart_write_bytes blocks until the line fits the TX ring buffer. */
    uart_write_bytes(STREAM32_UART, json, length);
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
    /* Sized for the worst case the compiler has to assume: esp_app_desc_t
       carries a 32-byte version, and the feature list grows over time. */
    char message[384];
    const esp_app_desc_t *app = esp_app_get_description();

    /* The ESP32-P4 has no radio; the efuse base MAC is its identity. */
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_BASE));
    snprintf(
        message,
        sizeof(message),
        "{\"type\":\"hello\",\"protocol\":%d,\"boardId\":\"%s\","
        "\"firmwareVersion\":\"%s\",\"deviceId\":\"%02x%02x%02x%02x%02x%02x\","
        "\"features\":[\"display-control\",\"display-brightness\",\"display-blank\","
        "\"display-invert\",\"display-icon-size\",\"display-label-lines\","
        "\"key-update\",\"image-rle\",\"clean-mode\",\"%s\"]}",
        STREAM32_PROTOCOL_VERSION,
        STREAM32_BOARD_ID,
        app->version,
        mac[0],
        mac[1],
        mac[2],
        mac[3],
        mac[4],
        mac[5],
        /* Both ports reach the same board, so the desktop needs to know
           which link a session landed on to keep the faster one. */
        active_link == STREAM32_LINK_USB ? "transport-usb" : "transport-uart"
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
            update_connection_label(
                active_link == STREAM32_LINK_USB
                    ? "USB 2.0 connected to Stream32"
                    : "UART0 connected to Stream32"
            );
            send_hello();

            /* A cleaning lock outlives the link, so a desktop that reconnects
               mid-wipe learns the panel is still locked. */
            if (deck_ui_clean_active()) {
                serial_write_line("{\"type\":\"clean\",\"active\":true}");
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
            serial_write_line(state);
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

/* Feeds one transport's bytes into its assembler and dispatches whole lines
   under the shared lock, so replies leave on the link they arrived from. */
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
        active_link = reader->link;

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

static void usb_rx_event(int itf, cdcacm_event_t *event)
{
    (void)itf;
    (void)event;

    xTaskNotifyGive(usb_task);
}

static void usb_protocol_task(void *argument)
{
    /* TINYUSB_DEFAULT_CONFIG selects the high-speed port on the ESP32-P4,
       which is the one the CrowPanel's USB 2.0 connector is wired to. */
    tinyusb_config_t usb_config = TINYUSB_DEFAULT_CONFIG();
    const tinyusb_config_cdcacm_t cdc_config = {
        .cdc_port = STREAM32_USB_CDC,
        .callback_rx = usb_rx_event,
    };
    uint8_t incoming[STREAM32_USB_READ_CHUNK];
    uint8_t mac[6];
    /* Static: an 8 KB line does not belong on the task stack. */
    static char line[STREAM32_LINE_CAPACITY];
    line_reader_t reader = {
        .link = STREAM32_LINK_USB,
        .buffer = line,
        .capacity = sizeof(line),
    };

    (void)argument;
    /* Published before the callback can fire so no notification is lost. */
    usb_task = xTaskGetCurrentTaskHandle();
    /* Same efuse base MAC the hello reports as deviceId. */
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_BASE));
    snprintf(
        usb_serial_string,
        sizeof(usb_serial_string),
        "%02x%02x%02x%02x%02x%02x",
        mac[0],
        mac[1],
        mac[2],
        mac[3],
        mac[4],
        mac[5]
    );
    usb_config.descriptor.string = usb_strings;
    usb_config.descriptor.string_count =
        sizeof(usb_strings) / sizeof(usb_strings[0]);

    esp_err_t status = tinyusb_driver_install(&usb_config);

    if (status == ESP_OK) {
        status = tinyusb_cdcacm_init(&cdc_config);
    }

    if (status != ESP_OK) {
        /* UART0 still carries the protocol, so lose the fast link, not the
           board. Nothing here may abort a panel that flashes over UART0.
           A failed init registered no callback, so the handle stays set and
           unused rather than becoming a NULL target for a stray notify. */
        ESP_LOGW(TAG, "USB 2.0 link unavailable: %s", esp_err_to_name(status));
        vTaskDelete(NULL);
        return;
    }

    while (true) {
        size_t received = 0;

        if (tinyusb_cdcacm_read(
                STREAM32_USB_CDC,
                incoming,
                sizeof(incoming),
                &received
            ) == ESP_OK &&
            received > 0) {
            consume_bytes(&reader, incoming, received);
            continue;
        }

        (void)ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(STREAM32_USB_IDLE_POLL_MS));
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
    /* Static: an 8 KB line does not belong on the task stack. */
    static char line[STREAM32_LINE_CAPACITY];
    line_reader_t reader = {
        .link = STREAM32_LINK_UART,
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
       the CrowPanel schematic wires CH340 RXD/TXD to P4 GPIO37/GPIO38. */
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
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 40);

    connection_label = lv_label_create(screen);
    lv_label_set_text(connection_label, "Waiting for the desktop app");
    lv_obj_set_style_text_color(
        connection_label,
        lv_color_hex(0x91a6b5),
        LV_PART_MAIN
    );
    lv_obj_align(connection_label, LV_ALIGN_TOP_MID, 0, 92);

    touch_surface = lv_obj_create(screen);
    lv_obj_set_size(touch_surface, 720, 400);
    lv_obj_align(touch_surface, LV_ALIGN_BOTTOM_MID, 0, -48);
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
    lv_obj_align(hint, LV_ALIGN_TOP_MID, 0, 56);

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

    /* Start communication before display bring-up. A slow panel init no
       longer misses every desktop hello, and UART remains available for
       startup diagnostics if the BSP fails. */
    const BaseType_t task_created = xTaskCreate(
        serial_protocol_task,
        "stream32_uart",
        8192,
        NULL,
        5,
        NULL
    );

    if (task_created != pdPASS) {
        ESP_LOGE(TAG, "Could not create the serial protocol task");
        return;
    }

    /* The fast link is optional: a board with nothing in its USB 2.0 port
       keeps working over UART0, so a failure here is only logged. */
    if (xTaskCreate(usb_protocol_task, "stream32_usb", 8192, NULL, 5, NULL) !=
        pdPASS) {
        ESP_LOGW(TAG, "Could not create the USB 2.0 protocol task");
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
