#include "deck_clean.h"

#include "esp_timer.h"
#include "sdkconfig.h"

#define CLEAN_SCREEN_W CONFIG_STREAM32_DECK_SCREEN_WIDTH
#define CLEAN_SCREEN_H CONFIG_STREAM32_DECK_SCREEN_HEIGHT
/* Long enough that a wiping cloth cannot dwell its way out of the lock. */
#define DECK_CLEAN_HOLD_MS 5000

static lv_obj_t *s_screen;
static lv_obj_t *s_fill;
/* Written from the LVGL task, read by the protocol task's poll. */
static volatile int64_t s_press_ms;

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static void set_progress(int32_t percent)
{
    if (s_fill != NULL) {
        lv_obj_set_width(s_fill, lv_pct(percent > 100 ? 100 : percent));
    }
}

/* Timed here rather than through LVGL's long-press event because that
   threshold is shared with every other consumer of the same input device. */
static void hold_handler(lv_event_t *event)
{
    const lv_event_code_t code = lv_event_get_code(event);

    if (code == LV_EVENT_PRESSED) {
        s_press_ms = now_ms();
        set_progress(0);
    } else if (code == LV_EVENT_PRESSING && s_press_ms != 0) {
        set_progress(
            (int32_t)(((now_ms() - s_press_ms) * 100) / DECK_CLEAN_HOLD_MS)
        );
    } else if (code == LV_EVENT_RELEASED || code == LV_EVENT_PRESS_LOST) {
        deck_clean_reset();
    }
}

/* A rounded card in the deck's colours, without lv_obj's default chrome. */
static lv_obj_t *panel(lv_obj_t *parent, int32_t width, int32_t height)
{
    lv_obj_t *object = lv_obj_create(parent);

    lv_obj_set_size(object, width, height);
    lv_obj_set_style_radius(object, LV_RADIUS_CIRCLE, LV_PART_MAIN);
    lv_obj_set_style_bg_color(object, lv_color_hex(0x172630), LV_PART_MAIN);
    lv_obj_set_style_border_width(object, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(object, 0, LV_PART_MAIN);
    lv_obj_remove_flag(
        object,
        LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE
    );
    return object;
}

static lv_obj_t *caption(lv_obj_t *parent, const char *text, uint32_t color)
{
    lv_obj_t *label = lv_label_create(parent);

    lv_label_set_text(label, text);
    lv_obj_set_style_text_color(label, lv_color_hex(color), LV_PART_MAIN);
    return label;
}

lv_obj_t *deck_clean_screen(void)
{
    if (s_screen != NULL) {
        return s_screen;
    }

    const int short_edge = CLEAN_SCREEN_W < CLEAN_SCREEN_H
        ? CLEAN_SCREEN_W
        : CLEAN_SCREEN_H;
    const int target_px = short_edge / 3;

    s_screen = lv_obj_create(NULL);
    lv_obj_remove_flag(s_screen, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_bg_color(s_screen, lv_color_hex(0x0b1116), LV_PART_MAIN);

    lv_obj_t *title = caption(s_screen, "Screen cleaning", 0xffad22);

    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, short_edge / 8);
    lv_obj_align_to(
        caption(s_screen, "Wipe away. Hold the circle to exit.", 0x91a6b5),
        title,
        LV_ALIGN_OUT_BOTTOM_MID,
        0,
        12
    );

    lv_obj_t *target = panel(s_screen, target_px, target_px);

    lv_obj_center(target);
    lv_obj_set_style_border_width(target, 2, LV_PART_MAIN);
    lv_obj_set_style_border_color(
        target,
        lv_color_hex(0x29404d),
        LV_PART_MAIN
    );
    lv_obj_set_style_border_color(
        target,
        lv_color_hex(0xffad22),
        LV_PART_MAIN | LV_STATE_PRESSED
    );
    lv_obj_add_flag(target, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(target, hold_handler, LV_EVENT_ALL, NULL);
    lv_obj_center(caption(target, "Hold 5s", 0xf3f7f9));

    /* Two plain objects instead of a bar widget, so no board has to enable an
       extra LVGL widget for the hold to show progress. */
    lv_obj_t *track = panel(s_screen, target_px, 8);

    lv_obj_align_to(track, target, LV_ALIGN_OUT_BOTTOM_MID, 0, 24);
    s_fill = panel(track, 0, lv_pct(100));
    lv_obj_align(s_fill, LV_ALIGN_LEFT_MID, 0, 0);
    lv_obj_set_style_bg_color(s_fill, lv_color_hex(0xffad22), LV_PART_MAIN);
    return s_screen;
}

void deck_clean_reset(void)
{
    s_press_ms = 0;
    set_progress(0);
}

bool deck_clean_held(int64_t now)
{
    const int64_t started = s_press_ms;

    return started != 0 && now - started >= DECK_CLEAN_HOLD_MS;
}
