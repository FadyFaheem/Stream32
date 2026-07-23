#include "deck_ui.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "deck_storage.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "lvgl.h"
#include "sdkconfig.h"

/* The LVGL lock comes from whichever board BSP the application links; the
   BSP component name differs per board, so the header is not included. */
extern bool bsp_display_lock(uint32_t timeout_ms);
extern void bsp_display_unlock(void);
extern esp_err_t bsp_display_set_awake(bool awake);
extern esp_err_t bsp_display_set_brightness(uint32_t brightness_percent);

/* Panel and grid limits are per-board Kconfig values (see this component's
   Kconfig for the protocol line-budget ceiling behind the ranges). */
#define DECK_SCREEN_W CONFIG_STREAM32_DECK_SCREEN_WIDTH
#define DECK_SCREEN_H CONFIG_STREAM32_DECK_SCREEN_HEIGHT
#define DECK_MAX_ROWS CONFIG_STREAM32_DECK_MAX_ROWS
#define DECK_MAX_COLS CONFIG_STREAM32_DECK_MAX_COLS
#define DECK_KEY_GAP 8
/* 180 px keys are the largest that fit a 64 KB flash slot in RGB565. */
#define DECK_KEY_MAX_PX 180
#define DECK_LINE_CAPACITY 128
#define DECK_DEFAULT_IDLE_SECONDS 600
#define DECK_OVERLAY_LEASE_MS 30000

typedef struct {
    bool used;
    bool has_color;
    bool has_label_color;
    int8_t go_page; /* -1 = plain key */
    uint32_t color;
    uint32_t label_color;
    uint32_t image_crc; /* 0 = no artwork */
    char label[DECK_PROTOCOL_LABEL_CAPACITY];
} deck_key_t;

typedef struct {
    uint8_t rows;
    uint8_t cols;
    deck_key_t keys[DECK_MAX_KEYS];
} deck_page_t;

typedef struct {
    bool active;
    bool has_color;
    bool has_label_color;
    uint8_t state; /* 0 absent, 1 on, 2 off, 3 unknown */
    uint32_t color;
    uint32_t label_color;
    uint32_t image_crc;
    uint32_t image_size;
    uint8_t *image;
    char label[DECK_PROTOCOL_LABEL_CAPACITY];
} deck_overlay_t;

static const char *TAG = "deck_ui";
static deck_notify_fn s_notify;
static deck_page_t s_pages[DECK_MAX_PAGES];
static deck_overlay_t s_overlays[DECK_MAX_PAGES][DECK_MAX_KEYS];
static uint8_t s_page_count;
static uint8_t s_visible_page;
static bool s_active;
static volatile int s_pending_page = -1;
static uint32_t s_idle_timeout_ms =
    DECK_DEFAULT_IDLE_SECONDS * 1000;
static int64_t s_last_activity_ms;
static bool s_panel_awake = true;
static bool s_forced_asleep;
static bool s_consume_touch;
static bool s_overlay_active;
static int64_t s_overlay_activity_ms;

static lv_obj_t *s_deck_screen;
static uint8_t *s_key_buffers[DECK_MAX_KEYS];
static lv_image_dsc_t s_key_dsc[DECK_MAX_KEYS];

static void build_page(uint8_t page_index);
static void build_page_locked(uint8_t page_index);

static bool overlays_active(void)
{
    for (int page = 0; page < DECK_MAX_PAGES; page++) {
        for (int index = 0; index < DECK_MAX_KEYS; index++) {
            if (s_overlays[page][index].active) {
                return true;
            }
        }
    }

    return false;
}

static int compute_key_px(int rows, int cols)
{
    const int width = (DECK_SCREEN_W - DECK_KEY_GAP * (cols + 1)) / cols;
    const int height = (DECK_SCREEN_H - DECK_KEY_GAP * (rows + 1)) / rows;
    const int size = width < height ? width : height;

    return size > DECK_KEY_MAX_PX ? DECK_KEY_MAX_PX : size;
}

static void notify_line(const char *line)
{
    if (s_notify != NULL) {
        s_notify(line);
    }
}

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static void set_panel_awake(bool awake)
{
    if (awake == s_panel_awake) {
        return;
    }

    const esp_err_t error = bsp_display_set_awake(awake);

    if (error != ESP_OK) {
        ESP_LOGW(
            TAG,
            "Could not turn display %s: %s",
            awake ? "on" : "off",
            esp_err_to_name(error)
        );
        return;
    }

    s_panel_awake = awake;
}

static void screen_event_handler(lv_event_t *event)
{
    const lv_event_code_t code = lv_event_get_code(event);

    if (code == LV_EVENT_PRESSED || code == LV_EVENT_RELEASED) {
        (void)deck_ui_handle_touch(code == LV_EVENT_PRESSED);
    }
}

static void key_event_handler(lv_event_t *event)
{
    const lv_event_code_t code = lv_event_get_code(event);

    if (code != LV_EVENT_PRESSED && code != LV_EVENT_RELEASED) {
        return;
    }

    if (deck_ui_handle_touch(code == LV_EVENT_PRESSED)) {
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

static void set_key_image_dsc(int index, int key_px, const uint8_t *pixels)
{
    memset(&s_key_dsc[index], 0, sizeof(s_key_dsc[index]));
    s_key_dsc[index].header.magic = LV_IMAGE_HEADER_MAGIC;
    s_key_dsc[index].header.cf = LV_COLOR_FORMAT_RGB565;
    s_key_dsc[index].header.w = key_px;
    s_key_dsc[index].header.h = key_px;
    s_key_dsc[index].header.stride = key_px * 2;
    s_key_dsc[index].data_size = (uint32_t)key_px * key_px * 2;
    s_key_dsc[index].data = pixels;
}

static void attach_key_image(lv_obj_t *parent, int index)
{
    lv_obj_t *image = lv_image_create(parent);

    lv_image_set_src(image, &s_key_dsc[index]);
    lv_obj_center(image);
    /* The parent key owns the full touch target; artwork is visual only. */
    lv_obj_remove_flag(image, LV_OBJ_FLAG_CLICKABLE);
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

bool deck_ui_clear_overlays(void)
{
    const bool rebuild = s_active && s_visible_page < s_page_count;

    if (rebuild && !bsp_display_lock(1000)) {
        return false;
    }

    if (rebuild && s_deck_screen != NULL) {
        /* Detach every LVGL image descriptor before freeing its pixels. */
        lv_obj_clean(s_deck_screen);
    }

    for (int page = 0; page < DECK_MAX_PAGES; page++) {
        for (int index = 0; index < DECK_MAX_KEYS; index++) {
            if (s_overlays[page][index].image != NULL) {
                heap_caps_free(s_overlays[page][index].image);
            }

            memset(&s_overlays[page][index], 0, sizeof(deck_overlay_t));
        }
    }

    s_overlay_active = false;

    if (rebuild) {
        build_page_locked(s_visible_page);
        bsp_display_unlock();
    }

    return true;
}

static void build_page_locked(uint8_t page_index)
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
    const int origin_x = (DECK_SCREEN_W - grid_width) / 2;
    const int origin_y = (DECK_SCREEN_H - grid_height) / 2;

    if (s_deck_screen == NULL) {
        s_deck_screen = lv_obj_create(NULL);
        lv_obj_add_flag(s_deck_screen, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_add_event_cb(
            s_deck_screen,
            screen_event_handler,
            LV_EVENT_ALL,
            NULL
        );
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
    s_visible_page = page_index;

    free_key_buffers();
    load_key_buffers(page, key_px);

    for (int index = 0; index < page->rows * page->cols; index++) {
        const deck_key_t *key = &page->keys[index];
        const deck_overlay_t *overlay = &s_overlays[page_index][index];
        const bool live = overlay->active;
        const char *label_text = live && overlay->label[0] != '\0'
            ? overlay->label
            : key->label;
        const uint8_t *image = live && overlay->image_crc != 0
            ? overlay->image
            : s_key_buffers[index];
        const int row = index / page->cols;
        const int col = index % page->cols;
        lv_obj_t *cell = lv_obj_create(s_deck_screen);

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
            live && overlay->has_color
                ? lv_color_hex(overlay->color)
                : key->used && key->has_color
                    ? lv_color_hex(key->color)
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

        if ((key->used || live) && label_text[0] != '\0') {
            lv_obj_t *label_obj = lv_label_create(cell);

            lv_label_set_text(label_obj, label_text);
            /* Explicit: the theme's card style would otherwise decide. */
            lv_obj_set_style_text_color(
                label_obj,
                lv_color_hex(
                    live && overlay->has_label_color
                        ? overlay->label_color
                        : key->has_label_color
                            ? key->label_color
                            : 0xf3f7f9
                ),
                LV_PART_MAIN
            );
            lv_label_set_long_mode(label_obj, LV_LABEL_LONG_DOT);
            lv_obj_set_width(label_obj, key_px - 12);
            lv_obj_set_style_text_align(
                label_obj,
                LV_TEXT_ALIGN_CENTER,
                LV_PART_MAIN
            );
            lv_obj_align(
                label_obj,
                image != NULL ? LV_ALIGN_BOTTOM_MID : LV_ALIGN_CENTER,
                0,
                0
            );
        }

        if (image != NULL) {
            set_key_image_dsc(index, key_px, image);
            attach_key_image(cell, index);
        }
    }

    lv_screen_load(s_deck_screen);
    s_active = true;
}

static void build_page(uint8_t page_index)
{
    if (page_index >= s_page_count) {
        return;
    }

    if (!bsp_display_lock(1000)) {
        ESP_LOGW(TAG, "Could not lock LVGL to build the deck");
        return;
    }

    build_page_locked(page_index);
    bsp_display_unlock();
}

/* ---- Public API --------------------------------------------------------- */

esp_err_t deck_ui_init(deck_notify_fn notify)
{
    s_notify = notify;
    s_last_activity_ms = now_ms();

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

        if (deck_protocol_restore_layout(json, length, page) != NULL) {
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
    if (s_panel_awake && !s_forced_asleep && s_idle_timeout_ms > 0 &&
        now_ms() - s_last_activity_ms >= s_idle_timeout_ms) {
        set_panel_awake(false);
    }

    if (s_overlay_active &&
        now_ms() - s_overlay_activity_ms >= DECK_OVERLAY_LEASE_MS) {
        deck_ui_clear_overlays();
    }

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

bool deck_ui_handle_touch(bool pressed)
{
    if (s_forced_asleep) {
        return true;
    }

    s_last_activity_ms = now_ms();

    if (pressed && !s_panel_awake) {
        set_panel_awake(true);
        s_consume_touch = true;
        return true;
    }

    if (!pressed && s_consume_touch) {
        s_consume_touch = false;
        return true;
    }

    return false;
}

static void copy_layout(
    deck_page_t *page,
    const deck_protocol_layout_t *layout
)
{
    memset(page, 0, sizeof(*page));
    page->rows = layout->rows;
    page->cols = layout->cols;

    for (int index = 0; index < DECK_MAX_KEYS; index++) {
        const deck_protocol_key_t *source = &layout->keys[index];
        deck_key_t *target = &page->keys[index];

        target->used = source->used;
        target->has_color = source->has_color;
        target->has_label_color = source->has_label_color;
        target->go_page = source->go_page;
        target->color = source->color;
        target->label_color = source->label_color;
        target->image_crc = source->image_crc;
        memcpy(target->label, source->label, sizeof(target->label));
    }
}

void deck_ui_restore_layout(const deck_protocol_layout_t *layout)
{
    copy_layout(&s_pages[layout->page], layout);
}

int deck_ui_key_px(uint8_t rows, uint8_t cols)
{
    return compute_key_px(rows, cols);
}

bool deck_ui_image_needed(uint32_t crc, uint32_t expected_size)
{
    uint32_t stored_size = 0;

    return !deck_storage_slot_find(crc, &stored_size) ||
        stored_size != expected_size;
}

const char *deck_ui_apply_layout(
    const deck_protocol_layout_t *layout,
    const char *raw_line,
    size_t raw_length
)
{
    if (raw_length > DECK_PAGE_JSON_CAPACITY) {
        return "layout-too-large";
    }

    if (layout->page == 0) {
        if (!deck_ui_clear_overlays()) {
            return "display-busy";
        }
    }

    copy_layout(&s_pages[layout->page], layout);
    s_page_count = layout->page_count;

    if (deck_storage_write_page_json(
            layout->page,
            raw_line,
            raw_length,
            layout->page_count
        ) != ESP_OK) {
        return "storage-failed";
    }

    /* The desktop pushes pages in order, so the last page marks a complete
       sync; unreferenced artwork can be dropped now. */
    if (layout->page == layout->page_count - 1) {
        uint32_t live[DECK_MAX_PAGES * DECK_MAX_KEYS];
        size_t live_count = 0;

        for (int page = 0; page < layout->page_count; page++) {
            for (int key = 0; key < DECK_MAX_KEYS; key++) {
                const uint32_t crc = s_pages[page].keys[key].image_crc;

                if (s_pages[page].keys[key].used && crc != 0) {
                    live[live_count++] = crc;
                }
            }
        }

        deck_storage_gc(live, live_count);
    }

    return NULL;
}

const char *deck_ui_apply_key_update(
    const deck_protocol_key_update_t *update,
    bool *need_image
)
{
    if (update->page >= s_page_count ||
        update->index >=
            s_pages[update->page].rows * s_pages[update->page].cols) {
        return "key-update-invalid";
    }

    const int page_index = update->page;
    const int key_index = update->index;
    deck_overlay_t parsed = { 0 };

    if (!update->clear) {
        parsed.active = true;
        parsed.has_color = update->has_color;
        parsed.has_label_color = update->has_label_color;
        parsed.state = update->state;
        parsed.color = update->color;
        parsed.label_color = update->label_color;
        parsed.image_crc = update->image_crc;
        memcpy(parsed.label, update->label, sizeof(parsed.label));
    }

    deck_overlay_t *overlay = &s_overlays[page_index][key_index];
    const deck_overlay_t previous = *overlay;
    *need_image = parsed.image_crc != 0;

    if (*need_image && overlay->image_crc == parsed.image_crc &&
        overlay->image != NULL) {
        parsed.image = overlay->image;
        parsed.image_size = overlay->image_size;
        *need_image = false;
    }

    const bool changed = memcmp(&previous, &parsed, sizeof(parsed)) != 0;
    const bool rebuild =
        changed && s_active && page_index == s_visible_page;

    if (rebuild && !bsp_display_lock(1000)) {
        return "display-busy";
    }

    if (rebuild && s_deck_screen != NULL) {
        /* The current descriptor may point at overlay->image. */
        lv_obj_clean(s_deck_screen);
    }

    if (overlay->image != NULL && overlay->image != parsed.image) {
        heap_caps_free(overlay->image);
    }

    *overlay = parsed;
    s_overlay_active = overlays_active();
    s_overlay_activity_ms = now_ms();

    if (rebuild) {
        build_page_locked((uint8_t)page_index);
        bsp_display_unlock();
    }

    return NULL;
}

const char *deck_ui_get_image_target(
    uint8_t page,
    uint8_t index,
    bool ephemeral,
    uint16_t *key_px,
    uint32_t *expected_crc
)
{
    if (page >= s_page_count ||
        index >= s_pages[page].rows * s_pages[page].cols) {
        return "image-invalid";
    }

    const deck_key_t *key = &s_pages[page].keys[index];
    const deck_overlay_t *overlay = &s_overlays[page][index];

    if ((!ephemeral && (!key->used || key->image_crc == 0)) ||
        (ephemeral && (!overlay->active || overlay->image_crc == 0))) {
        return "image-invalid";
    }

    *key_px = (uint16_t)compute_key_px(
        s_pages[page].rows,
        s_pages[page].cols
    );
    *expected_crc = ephemeral ? overlay->image_crc : key->image_crc;
    return NULL;
}

const char *deck_ui_commit_image(
    uint8_t page,
    uint8_t index,
    bool ephemeral,
    const uint8_t *pixels,
    uint32_t size
)
{
    if (!ephemeral) {
        const deck_key_t *key = &s_pages[page].keys[index];

        return deck_storage_slot_write(key->image_crc, pixels, size) == ESP_OK
            ? NULL
            : "storage-failed";
    }

    uint8_t *owned_pixels = heap_caps_malloc(size, MALLOC_CAP_SPIRAM);

    if (owned_pixels == NULL) {
        return "image-no-memory";
    }

    memcpy(owned_pixels, pixels, size);

    deck_overlay_t *overlay = &s_overlays[page][index];
    const bool rebuild = s_active && page == s_visible_page;

    if (rebuild && !bsp_display_lock(1000)) {
        heap_caps_free(owned_pixels);
        return "display-busy";
    }

    if (rebuild && s_deck_screen != NULL) {
        /* Stop LVGL from reading the old image before replacing it. */
        lv_obj_clean(s_deck_screen);
    }

    if (overlay->image != NULL) {
        heap_caps_free(overlay->image);
    }

    overlay->image = owned_pixels;
    overlay->image_size = size;

    if (rebuild) {
        build_page_locked(page);
        bsp_display_unlock();
    }

    return NULL;
}

const char *deck_ui_select_page(uint8_t page)
{
    if (page >= s_page_count) {
        return "page-invalid";
    }

    /* Layouts and artwork are staged first; the final page message commits
       the whole sync in one render instead of exposing each incoming key. */
    build_page(page);
    deck_storage_set_active_page(page);
    return NULL;
}

const char *deck_ui_apply_display(const deck_protocol_display_t *display)
{
    if (display->has_brightness) {
        const esp_err_t error =
            bsp_display_set_brightness(display->brightness_percent);

        if (error == ESP_ERR_NOT_SUPPORTED) {
            return "display-brightness-unsupported";
        }

        if (error != ESP_OK) {
            return "display-brightness-failed";
        }
    }

    s_idle_timeout_ms = display->idle_timeout_seconds * 1000;
    s_forced_asleep = !display->awake;
    s_consume_touch = false;

    if (s_forced_asleep) {
        set_panel_awake(false);
    } else {
        s_last_activity_ms = now_ms();
        set_panel_awake(true);
    }

    return NULL;
}
