#include "deck_ui.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bsp/esp-bsp.h"
#include "deck_storage.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_rom_crc.h"
#include "lvgl.h"
#include "mbedtls/base64.h"

#define DECK_SCREEN_PX 480
#define DECK_KEY_GAP 8
/* 180 px keys are the largest that fit a 64 KB flash slot in RGB565. */
#define DECK_KEY_MAX_PX 180
#define DECK_MAX_ROWS 5
#define DECK_MAX_COLS 5
#define DECK_LABEL_CAPACITY 33
#define DECK_LINE_CAPACITY 128

typedef struct {
    bool used;
    bool has_color;
    bool has_label_color;
    int8_t go_page; /* -1 = plain key */
    uint32_t color;
    uint32_t label_color;
    uint32_t image_crc; /* 0 = no artwork */
    char label[DECK_LABEL_CAPACITY];
} deck_key_t;

typedef struct {
    uint8_t rows;
    uint8_t cols;
    deck_key_t keys[DECK_MAX_KEYS];
} deck_page_t;

static const char *TAG = "deck_ui";
static deck_notify_fn s_notify;
static deck_page_t s_pages[DECK_MAX_PAGES];
static uint8_t s_page_count;
static uint8_t s_visible_page;
static bool s_active;
static volatile int s_pending_page = -1;

static lv_obj_t *s_deck_screen;
static lv_obj_t *s_key_objects[DECK_MAX_KEYS];
static uint8_t *s_key_buffers[DECK_MAX_KEYS];
static lv_image_dsc_t s_key_dsc[DECK_MAX_KEYS];

static uint8_t *s_staging;
static int s_staging_page = -1;
static int s_staging_index = -1;
static uint32_t s_staging_expected_seq;
static uint32_t s_staging_received;

static int compute_key_px(int rows, int cols)
{
    const int width = (DECK_SCREEN_PX - DECK_KEY_GAP * (cols + 1)) / cols;
    const int height = (DECK_SCREEN_PX - DECK_KEY_GAP * (rows + 1)) / rows;
    const int size = width < height ? width : height;

    return size > DECK_KEY_MAX_PX ? DECK_KEY_MAX_PX : size;
}

static void notify_line(const char *line)
{
    if (s_notify != NULL) {
        s_notify(line);
    }
}

static void key_event_handler(lv_event_t *event)
{
    const lv_event_code_t code = lv_event_get_code(event);

    if (code != LV_EVENT_PRESSED && code != LV_EVENT_RELEASED) {
        return;
    }

    const int index = (int)(intptr_t)lv_event_get_user_data(event);
    const char *phase = code == LV_EVENT_PRESSED ? "down" : "up";
    char line[DECK_LINE_CAPACITY];

    snprintf(
        line,
        sizeof(line),
        "{\"type\":\"press\",\"page\":%d,\"index\":%d,\"phase\":\"%s\"}",
        s_visible_page,
        index,
        phase
    );
    notify_line(line);

    /* The raw touch stream stays alive for the desktop's touch test. */
    lv_indev_t *input = lv_indev_active();

    if (input != NULL) {
        lv_point_t point;
        lv_indev_get_point(input, &point);
        snprintf(
            line,
            sizeof(line),
            "{\"type\":\"touch\",\"phase\":\"%s\",\"x\":%d,\"y\":%d}",
            phase,
            (int)point.x,
            (int)point.y
        );
        notify_line(line);
    }

    const deck_key_t *key = &s_pages[s_visible_page].keys[index];

    if (code == LV_EVENT_PRESSED && key->go_page >= 0 &&
        key->go_page < s_page_count) {
        /* Rebuilding the grid needs the display lock, so defer the switch
           to the USB task instead of doing it inside this LVGL callback. */
        s_pending_page = key->go_page;
    }
}

static void free_key_buffers(void)
{
    for (int index = 0; index < DECK_MAX_KEYS; index++) {
        if (s_key_buffers[index] != NULL) {
            heap_caps_free(s_key_buffers[index]);
            s_key_buffers[index] = NULL;
        }
    }
}

static void set_key_image_dsc(int index, int key_px)
{
    memset(&s_key_dsc[index], 0, sizeof(s_key_dsc[index]));
    s_key_dsc[index].header.magic = LV_IMAGE_HEADER_MAGIC;
    s_key_dsc[index].header.cf = LV_COLOR_FORMAT_RGB565;
    s_key_dsc[index].header.w = key_px;
    s_key_dsc[index].header.h = key_px;
    s_key_dsc[index].header.stride = key_px * 2;
    s_key_dsc[index].data_size = (uint32_t)key_px * key_px * 2;
    s_key_dsc[index].data = s_key_buffers[index];
}

static void attach_key_image(lv_obj_t *parent, int index)
{
    lv_obj_t *image = lv_image_create(parent);

    lv_image_set_src(image, &s_key_dsc[index]);
    lv_obj_center(image);
    /* Labels stay above artwork. */
    lv_obj_move_to_index(image, 0);
}

/* Loads the artwork for every key on the page into PSRAM. Runs before the
   grid is (re)built so image descriptors point at valid pixels. */
static void load_key_buffers(const deck_page_t *page, int key_px)
{
    const uint32_t size = (uint32_t)key_px * key_px * 2;

    for (int index = 0; index < page->rows * page->cols; index++) {
        const deck_key_t *key = &page->keys[index];
        uint32_t stored_size = 0;

        if (!key->used || key->image_crc == 0 ||
            !deck_storage_slot_find(key->image_crc, &stored_size) ||
            stored_size != size) {
            continue;
        }

        s_key_buffers[index] = heap_caps_malloc(size, MALLOC_CAP_SPIRAM);

        if (s_key_buffers[index] == NULL) {
            ESP_LOGW(TAG, "Out of PSRAM for key %d artwork", index);
            continue;
        }

        if (deck_storage_slot_read(
                key->image_crc,
                s_key_buffers[index],
                size
            ) != ESP_OK) {
            heap_caps_free(s_key_buffers[index]);
            s_key_buffers[index] = NULL;
        }
    }
}

static void build_page(uint8_t page_index)
{
    if (page_index >= s_page_count) {
        return;
    }

    const deck_page_t *page = &s_pages[page_index];
    const int key_px = compute_key_px(page->rows, page->cols);
    const int grid_width =
        page->cols * key_px + (page->cols - 1) * DECK_KEY_GAP;
    const int grid_height =
        page->rows * key_px + (page->rows - 1) * DECK_KEY_GAP;
    const int origin_x = (DECK_SCREEN_PX - grid_width) / 2;
    const int origin_y = (DECK_SCREEN_PX - grid_height) / 2;

    if (!bsp_display_lock(1000)) {
        ESP_LOGW(TAG, "Could not lock LVGL to build the deck");
        return;
    }

    if (s_deck_screen == NULL) {
        s_deck_screen = lv_obj_create(NULL);
        lv_obj_set_style_bg_color(
            s_deck_screen,
            lv_color_hex(0x0b1116),
            LV_PART_MAIN
        );
        lv_obj_set_style_text_color(
            s_deck_screen,
            lv_color_hex(0xf3f7f9),
            LV_PART_MAIN
        );
    }

    lv_obj_clean(s_deck_screen);
    memset(s_key_objects, 0, sizeof(s_key_objects));
    s_visible_page = page_index;

    free_key_buffers();
    load_key_buffers(page, key_px);

    for (int index = 0; index < page->rows * page->cols; index++) {
        const deck_key_t *key = &page->keys[index];
        const int row = index / page->cols;
        const int col = index % page->cols;
        lv_obj_t *cell = lv_obj_create(s_deck_screen);

        s_key_objects[index] = cell;
        lv_obj_set_size(cell, key_px, key_px);
        lv_obj_set_pos(
            cell,
            origin_x + col * (key_px + DECK_KEY_GAP),
            origin_y + row * (key_px + DECK_KEY_GAP)
        );
        lv_obj_set_style_radius(cell, 14, LV_PART_MAIN);
        lv_obj_set_style_clip_corner(cell, true, LV_PART_MAIN);
        lv_obj_set_style_border_width(cell, 2, LV_PART_MAIN);
        lv_obj_set_style_border_color(
            cell,
            lv_color_hex(0x29404d),
            LV_PART_MAIN
        );
        lv_obj_set_style_border_color(
            cell,
            lv_color_hex(0xffad22),
            LV_PART_MAIN | LV_STATE_PRESSED
        );
        lv_obj_set_style_bg_color(
            cell,
            key->used && key->has_color ? lv_color_hex(key->color)
                                        : lv_color_hex(0x172630),
            LV_PART_MAIN
        );
        lv_obj_set_style_pad_all(cell, 2, LV_PART_MAIN);
        lv_obj_remove_flag(cell, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_add_flag(cell, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_add_event_cb(
            cell,
            key_event_handler,
            LV_EVENT_ALL,
            (void *)(intptr_t)index
        );

        if (key->used && key->label[0] != '\0') {
            lv_obj_t *label = lv_label_create(cell);

            lv_label_set_text(label, key->label);
            /* Explicit: the theme's card style would otherwise decide. */
            lv_obj_set_style_text_color(
                label,
                lv_color_hex(
                    key->has_label_color ? key->label_color : 0xf3f7f9
                ),
                LV_PART_MAIN
            );
            lv_label_set_long_mode(label, LV_LABEL_LONG_DOT);
            lv_obj_set_width(label, key_px - 12);
            lv_obj_set_style_text_align(
                label,
                LV_TEXT_ALIGN_CENTER,
                LV_PART_MAIN
            );
            lv_obj_align(
                label,
                s_key_buffers[index] != NULL ? LV_ALIGN_BOTTOM_MID
                                             : LV_ALIGN_CENTER,
                0,
                0
            );
        }

        if (s_key_buffers[index] != NULL) {
            set_key_image_dsc(index, key_px);
            attach_key_image(cell, index);
        }
    }

    lv_screen_load(s_deck_screen);
    bsp_display_unlock();
    s_active = true;
}

/* ---- Layout parsing ---------------------------------------------------- */

static bool parse_color(const char *text, uint32_t *out)
{
    if (text == NULL || text[0] != '#' || strlen(text) != 7) {
        return false;
    }

    char *end = NULL;
    const unsigned long value = strtoul(text + 1, &end, 16);

    if (end == NULL || *end != '\0') {
        return false;
    }

    *out = (uint32_t)value;
    return true;
}

static bool parse_crc(const char *text, uint32_t *out)
{
    if (text == NULL || strlen(text) != 8) {
        return false;
    }

    char *end = NULL;
    const unsigned long value = strtoul(text, &end, 16);

    if (end == NULL || *end != '\0') {
        return false;
    }

    *out = (uint32_t)value;
    return true;
}

static const char *parse_page_message(
    const cJSON *message,
    deck_page_t *out,
    int *page_out,
    int *page_count_out
)
{
    const cJSON *page = cJSON_GetObjectItemCaseSensitive(message, "page");
    const cJSON *of = cJSON_GetObjectItemCaseSensitive(message, "of");
    const cJSON *rows = cJSON_GetObjectItemCaseSensitive(message, "rows");
    const cJSON *cols = cJSON_GetObjectItemCaseSensitive(message, "cols");
    const cJSON *keys = cJSON_GetObjectItemCaseSensitive(message, "keys");

    if (!cJSON_IsNumber(page) || !cJSON_IsNumber(of) ||
        !cJSON_IsNumber(rows) || !cJSON_IsNumber(cols) ||
        !cJSON_IsArray(keys)) {
        return "layout-invalid";
    }

    const int page_index = page->valueint;
    const int page_count = of->valueint;

    if (page_index < 0 || page_count < 1 || page_count > DECK_MAX_PAGES ||
        page_index >= page_count || rows->valueint < 1 ||
        rows->valueint > DECK_MAX_ROWS || cols->valueint < 1 ||
        cols->valueint > DECK_MAX_COLS) {
        return "layout-invalid";
    }

    memset(out, 0, sizeof(*out));
    out->rows = (uint8_t)rows->valueint;
    out->cols = (uint8_t)cols->valueint;

    for (int index = 0; index < DECK_MAX_KEYS; index++) {
        out->keys[index].go_page = -1;
    }

    const int key_count = out->rows * out->cols;
    const cJSON *entry = NULL;

    cJSON_ArrayForEach(entry, keys) {
        const cJSON *key_index = cJSON_GetObjectItemCaseSensitive(entry, "index");

        if (!cJSON_IsNumber(key_index) || key_index->valueint < 0 ||
            key_index->valueint >= key_count) {
            return "layout-invalid";
        }

        deck_key_t *key = &out->keys[key_index->valueint];

        if (key->used) {
            return "layout-invalid";
        }

        key->used = true;

        const cJSON *label = cJSON_GetObjectItemCaseSensitive(entry, "label");
        const cJSON *color = cJSON_GetObjectItemCaseSensitive(entry, "color");
        const cJSON *image_crc =
            cJSON_GetObjectItemCaseSensitive(entry, "imageCrc");
        const cJSON *go_page = cJSON_GetObjectItemCaseSensitive(entry, "goPage");

        if (label != NULL) {
            if (!cJSON_IsString(label) ||
                strlen(label->valuestring) >= DECK_LABEL_CAPACITY) {
                return "layout-invalid";
            }

            strcpy(key->label, label->valuestring);
        }

        if (color != NULL) {
            if (!cJSON_IsString(color) ||
                !parse_color(color->valuestring, &key->color)) {
                return "layout-invalid";
            }

            key->has_color = true;
        }

        const cJSON *label_color =
            cJSON_GetObjectItemCaseSensitive(entry, "labelColor");

        if (label_color != NULL) {
            if (!cJSON_IsString(label_color) ||
                !parse_color(label_color->valuestring, &key->label_color)) {
                return "layout-invalid";
            }

            key->has_label_color = true;
        }

        if (image_crc != NULL) {
            if (!cJSON_IsString(image_crc) ||
                !parse_crc(image_crc->valuestring, &key->image_crc)) {
                return "layout-invalid";
            }
        }

        if (go_page != NULL) {
            if (!cJSON_IsNumber(go_page) || go_page->valueint < 0 ||
                go_page->valueint >= page_count) {
                return "layout-invalid";
            }

            key->go_page = (int8_t)go_page->valueint;
        }
    }

    *page_out = page_index;
    *page_count_out = page_count;
    return NULL;
}

/* ---- Public API --------------------------------------------------------- */

esp_err_t deck_ui_init(deck_notify_fn notify)
{
    s_notify = notify;

    const esp_err_t error = deck_storage_init();

    if (error != ESP_OK) {
        return error;
    }

    if (!deck_storage_has_state()) {
        return ESP_OK;
    }

    static char json[DECK_PAGE_JSON_CAPACITY + 1];
    const uint8_t page_count = deck_storage_page_count();
    uint8_t restored = 0;

    for (uint8_t page = 0; page < page_count; page++) {
        size_t length = 0;

        if (!deck_storage_read_page_json(page, json, sizeof(json), &length)) {
            ESP_LOGW(TAG, "Stored page %u is unreadable", page);
            return ESP_OK;
        }

        cJSON *message = cJSON_ParseWithLength(json, length);

        if (message == NULL) {
            return ESP_OK;
        }

        int page_index = 0;
        int stored_count = 0;
        const char *parse_error = parse_page_message(
            message,
            &s_pages[page],
            &page_index,
            &stored_count
        );

        cJSON_Delete(message);

        if (parse_error != NULL || page_index != page) {
            ESP_LOGW(TAG, "Stored page %u is invalid", page);
            return ESP_OK;
        }

        restored++;
    }

    if (restored == page_count) {
        s_page_count = page_count;
        build_page(deck_storage_active_page());
        ESP_LOGI(TAG, "Restored %u deck page(s) from flash", restored);
    }

    return ESP_OK;
}

bool deck_ui_active(void)
{
    return s_active;
}

void deck_ui_poll(void)
{
    const int pending = s_pending_page;

    if (pending < 0) {
        return;
    }

    s_pending_page = -1;

    if (pending >= s_page_count) {
        return;
    }

    build_page((uint8_t)pending);

    char line[DECK_LINE_CAPACITY];

    snprintf(line, sizeof(line), "{\"type\":\"page\",\"index\":%d}", pending);
    notify_line(line);
}

const char *deck_ui_handle_layout(
    const cJSON *message,
    const char *raw_line,
    size_t raw_length,
    char *reply,
    size_t reply_capacity
)
{
    deck_page_t parsed;
    int page_index = 0;
    int page_count = 0;
    const char *error =
        parse_page_message(message, &parsed, &page_index, &page_count);

    if (error != NULL) {
        return error;
    }

    if (raw_length > DECK_PAGE_JSON_CAPACITY) {
        return "layout-too-large";
    }

    s_pages[page_index] = parsed;
    s_page_count = (uint8_t)page_count;

    if (deck_storage_write_page_json(
            (uint8_t)page_index,
            raw_line,
            raw_length,
            (uint8_t)page_count
        ) != ESP_OK) {
        return "storage-failed";
    }

    /* The desktop pushes pages in order, so the last page marks a complete
       sync; unreferenced artwork can be dropped now. */
    if (page_index == page_count - 1) {
        uint32_t live[DECK_MAX_PAGES * DECK_MAX_KEYS];
        size_t live_count = 0;

        for (int page = 0; page < page_count; page++) {
            for (int key = 0; key < DECK_MAX_KEYS; key++) {
                const uint32_t crc = s_pages[page].keys[key].image_crc;

                if (s_pages[page].keys[key].used && crc != 0) {
                    live[live_count++] = crc;
                }
            }
        }

        deck_storage_gc(live, live_count);
    }

    if (!s_active) {
        /* First contact: show the first page; the host restores the real
           active page right after the sync. */
        if (page_index == 0) {
            build_page(0);
        }
    } else if (s_visible_page == page_index) {
        build_page((uint8_t)page_index);
    } else if (s_visible_page >= page_count) {
        build_page((uint8_t)(page_count - 1));
    }

    const int key_px = compute_key_px(parsed.rows, parsed.cols);
    int written = snprintf(
        reply,
        reply_capacity,
        "{\"type\":\"layout-ack\",\"page\":%d,\"rows\":%d,\"cols\":%d,"
        "\"keyPx\":%d,\"needImages\":[",
        page_index,
        parsed.rows,
        parsed.cols,
        key_px
    );
    bool first = true;

    for (int index = 0; index < parsed.rows * parsed.cols; index++) {
        const deck_key_t *key = &parsed.keys[index];
        const uint32_t expected_size = (uint32_t)key_px * key_px * 2;
        uint32_t stored_size = 0;

        if (!key->used || key->image_crc == 0) {
            continue;
        }

        if (deck_storage_slot_find(key->image_crc, &stored_size) &&
            stored_size == expected_size) {
            continue;
        }

        written += snprintf(
            reply + written,
            reply_capacity - written,
            "%s%d",
            first ? "" : ",",
            index
        );
        first = false;
    }

    snprintf(reply + written, reply_capacity - written, "]}");
    return NULL;
}

const char *deck_ui_handle_image(
    const cJSON *message,
    char *reply,
    size_t reply_capacity
)
{
    const cJSON *page = cJSON_GetObjectItemCaseSensitive(message, "page");
    const cJSON *index = cJSON_GetObjectItemCaseSensitive(message, "index");
    const cJSON *seq = cJSON_GetObjectItemCaseSensitive(message, "seq");
    const cJSON *of = cJSON_GetObjectItemCaseSensitive(message, "of");
    const cJSON *width = cJSON_GetObjectItemCaseSensitive(message, "w");
    const cJSON *height = cJSON_GetObjectItemCaseSensitive(message, "h");
    const cJSON *data = cJSON_GetObjectItemCaseSensitive(message, "data");

    if (!cJSON_IsNumber(page) || !cJSON_IsNumber(index) ||
        !cJSON_IsNumber(seq) || !cJSON_IsNumber(of) ||
        !cJSON_IsNumber(width) || !cJSON_IsNumber(height) ||
        !cJSON_IsString(data)) {
        return "image-invalid";
    }

    const int page_index = page->valueint;
    const int key_index = index->valueint;

    if (page_index < 0 || page_index >= s_page_count || key_index < 0 ||
        key_index >= s_pages[page_index].rows * s_pages[page_index].cols) {
        return "image-invalid";
    }

    const deck_key_t *key = &s_pages[page_index].keys[key_index];
    const uint32_t total_size = (uint32_t)width->valueint * height->valueint * 2;

    if (!key->used || key->image_crc == 0 || width->valueint < 1 ||
        height->valueint < 1 || total_size > DECK_SLOT_BYTES) {
        return "image-invalid";
    }

    if (s_staging == NULL) {
        s_staging = heap_caps_malloc(DECK_SLOT_BYTES, MALLOC_CAP_SPIRAM);

        if (s_staging == NULL) {
            return "image-no-memory";
        }
    }

    if (seq->valueint == 0) {
        s_staging_page = page_index;
        s_staging_index = key_index;
        s_staging_expected_seq = 0;
        s_staging_received = 0;
    }

    if (page_index != s_staging_page || key_index != s_staging_index ||
        (uint32_t)seq->valueint != s_staging_expected_seq) {
        s_staging_page = -1;
        return "image-sequence";
    }

    size_t decoded = 0;
    const size_t data_length = strlen(data->valuestring);

    if (mbedtls_base64_decode(
            s_staging + s_staging_received,
            DECK_SLOT_BYTES - s_staging_received,
            &decoded,
            (const unsigned char *)data->valuestring,
            data_length
        ) != 0) {
        s_staging_page = -1;
        return "image-invalid";
    }

    s_staging_received += decoded;
    s_staging_expected_seq++;

    if ((int)s_staging_expected_seq == of->valueint) {
        s_staging_page = -1;

        if (s_staging_received != total_size) {
            return "image-size-mismatch";
        }

        if (esp_rom_crc32_le(0, s_staging, total_size) != key->image_crc) {
            return "image-crc-mismatch";
        }

        if (deck_storage_slot_write(
                key->image_crc,
                s_staging,
                total_size
            ) != ESP_OK) {
            return "storage-failed";
        }

        /* Show the artwork immediately when its page is on screen. */
        if (s_active && s_visible_page == page_index &&
            s_key_objects[key_index] != NULL) {
            const int key_px =
                compute_key_px(s_pages[page_index].rows, s_pages[page_index].cols);

            if ((uint32_t)key_px * key_px * 2 == total_size &&
                bsp_display_lock(1000)) {
                if (s_key_buffers[key_index] == NULL) {
                    s_key_buffers[key_index] =
                        heap_caps_malloc(total_size, MALLOC_CAP_SPIRAM);

                    if (s_key_buffers[key_index] != NULL) {
                        memcpy(s_key_buffers[key_index], s_staging, total_size);
                        set_key_image_dsc(key_index, key_px);
                        attach_key_image(s_key_objects[key_index], key_index);
                    }
                } else {
                    memcpy(s_key_buffers[key_index], s_staging, total_size);
                    lv_obj_invalidate(s_key_objects[key_index]);
                }

                bsp_display_unlock();
            }
        }
    }

    snprintf(
        reply,
        reply_capacity,
        "{\"type\":\"image-ack\",\"page\":%d,\"index\":%d,\"seq\":%d}",
        page_index,
        key_index,
        seq->valueint
    );
    return NULL;
}

const char *deck_ui_handle_page(const cJSON *message)
{
    const cJSON *index = cJSON_GetObjectItemCaseSensitive(message, "index");

    if (!cJSON_IsNumber(index) || index->valueint < 0 ||
        index->valueint >= s_page_count) {
        return "page-invalid";
    }

    build_page((uint8_t)index->valueint);
    deck_storage_set_active_page((uint8_t)index->valueint);
    return NULL;
}
