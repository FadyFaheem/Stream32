#include "deck_calibrate.h"

#include <stdio.h>

#include "deck_affine.h"
#include "esp_err.h"
#include "esp_timer.h"
#include "sdkconfig.h"

/* Same arrangement as deck_ui: the BSP component name differs per board, so
   the contract is declared rather than included. */
extern bool bsp_display_lock(uint32_t timeout_ms);
extern void bsp_display_unlock(void);
extern bool bsp_touch_read_raw(uint16_t *x, uint16_t *y);
extern esp_err_t bsp_touch_set_calibration(
    const float coefficients[DECK_CALIBRATION_COEFFICIENTS]
);

#define CALIBRATE_SCREEN_W CONFIG_STREAM32_DECK_SCREEN_WIDTH
#define CALIBRATE_SCREEN_H CONFIG_STREAM32_DECK_SCREEN_HEIGHT

/* Internal: callers see only the outcome line from deck_calibrate_poll. */
typedef enum {
    DECK_CALIBRATE_RUNNING,
    DECK_CALIBRATE_DONE,
    DECK_CALIBRATE_FAILED,
} deck_calibrate_state_t;

/* Three targets solve the transform and the fourth checks it. They are inset
   from the corners because a resistive panel's extreme edges are its least
   linear region, and spread wide because a tight triangle amplifies tap
   error into the solved coefficients. */
#define CALIBRATE_SOLVE_POINTS 3
#define CALIBRATE_TOTAL_POINTS 4
static const int8_t TARGET_PERCENT[CALIBRATE_TOTAL_POINTS][2] = {
    {15, 15},
    {85, 15},
    {50, 85},
    {50, 50},
};

#define CALIBRATE_TARGET_PX 28
/* The verification tap must land within this fraction of the short edge. */
#define CALIBRATE_TOLERANCE_PERCENT 10
/* Long enough to find the stylus, short enough that a wizard abandoned
   halfway hands the screen back on its own instead of owning it for good. */
#define CALIBRATE_TIMEOUT_MS 60000

static lv_obj_t *s_screen;
static lv_obj_t *s_target;
static lv_obj_t *s_prompt;
static uint8_t s_index;
static bool s_was_pressed;
static uint16_t s_press_raw_x;
static uint16_t s_press_raw_y;
static uint16_t s_samples_x[CALIBRATE_TOTAL_POINTS];
static uint16_t s_samples_y[CALIBRATE_TOTAL_POINTS];
static int64_t s_activity_ms;
/* Latched so a busy display lock in the caller only delays the handover. */
static const char *s_outcome;

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static int32_t target_x(uint8_t index)
{
    return CALIBRATE_SCREEN_W * TARGET_PERCENT[index][0] / 100;
}

static int32_t target_y(uint8_t index)
{
    return CALIBRATE_SCREEN_H * TARGET_PERCENT[index][1] / 100;
}

static int32_t short_edge(void)
{
    return CALIBRATE_SCREEN_W < CALIBRATE_SCREEN_H
        ? CALIBRATE_SCREEN_W
        : CALIBRATE_SCREEN_H;
}

static void place_target(void)
{
    if (s_target == NULL || s_index >= CALIBRATE_TOTAL_POINTS) {
        return;
    }

    lv_obj_set_pos(
        s_target,
        target_x(s_index) - CALIBRATE_TARGET_PX / 2,
        target_y(s_index) - CALIBRATE_TARGET_PX / 2
    );

    char text[48];

    snprintf(
        text,
        sizeof(text),
        s_index < CALIBRATE_SOLVE_POINTS
            ? "Tap the centre of the marker (%u of %u)"
            : "One more to check the result (%u of %u)",
        (unsigned)(s_index + 1),
        (unsigned)CALIBRATE_TOTAL_POINTS
    );
    lv_label_set_text(s_prompt, text);
}

lv_obj_t *deck_calibrate_screen(void)
{
    if (s_screen != NULL) {
        return s_screen;
    }

    s_screen = lv_obj_create(NULL);
    lv_obj_remove_flag(s_screen, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_bg_color(s_screen, lv_color_hex(0x0b1116), LV_PART_MAIN);

    lv_obj_t *title = lv_label_create(s_screen);

    lv_label_set_text(title, "Touch calibration");
    lv_obj_set_style_text_color(title, lv_color_hex(0xffad22), LV_PART_MAIN);
    lv_obj_align(title, LV_ALIGN_TOP_MID, 0, short_edge() / 10);

    s_prompt = lv_label_create(s_screen);
    lv_obj_set_style_text_color(s_prompt, lv_color_hex(0x91a6b5), LV_PART_MAIN);
    lv_obj_align_to(s_prompt, title, LV_ALIGN_OUT_BOTTOM_MID, 0, 10);

    /* A cross rather than a filled dot: a fingertip covers the marker, and
       the arms stay visible around it. */
    s_target = lv_obj_create(s_screen);
    lv_obj_set_size(s_target, CALIBRATE_TARGET_PX, CALIBRATE_TARGET_PX);
    lv_obj_set_style_radius(s_target, LV_RADIUS_CIRCLE, LV_PART_MAIN);
    lv_obj_set_style_bg_opa(s_target, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_target, 3, LV_PART_MAIN);
    lv_obj_set_style_border_color(
        s_target,
        lv_color_hex(0xffad22),
        LV_PART_MAIN
    );
    lv_obj_set_style_pad_all(s_target, 0, LV_PART_MAIN);
    lv_obj_remove_flag(
        s_target,
        LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE
    );

    deck_calibrate_reset();
    return s_screen;
}

void deck_calibrate_reset(void)
{
    s_index = 0;
    s_was_pressed = false;
    s_outcome = NULL;
    s_activity_ms = now_ms();
    place_target();
}

static deck_calibrate_state_t finish(
    float coefficients[DECK_CALIBRATION_COEFFICIENTS]
)
{
    const int32_t screen_x[CALIBRATE_SOLVE_POINTS] = {
        target_x(0), target_x(1), target_x(2)
    };
    const int32_t screen_y[CALIBRATE_SOLVE_POINTS] = {
        target_y(0), target_y(1), target_y(2)
    };

    if (!deck_affine_solve(
            s_samples_x,
            s_samples_y,
            screen_x,
            screen_y,
            coefficients
        )) {
        return DECK_CALIBRATE_FAILED;
    }

    /* A three-point solve always fits its own three points exactly, so only
       the fourth tap can tell a good calibration from a mistyped one. */
    const uint8_t check = CALIBRATE_TOTAL_POINTS - 1;
    const float mapped_x = coefficients[0] * s_samples_x[check] +
        coefficients[1] * s_samples_y[check] + coefficients[2];
    const float mapped_y = coefficients[3] * s_samples_x[check] +
        coefficients[4] * s_samples_y[check] + coefficients[5];
    const float error_x = mapped_x - target_x(check);
    const float error_y = mapped_y - target_y(check);
    const float tolerance =
        (float)short_edge() * CALIBRATE_TOLERANCE_PERCENT / 100.0f;

    if (error_x * error_x + error_y * error_y > tolerance * tolerance) {
        return DECK_CALIBRATE_FAILED;
    }

    return DECK_CALIBRATE_DONE;
}

static deck_calibrate_state_t feed(
    bool pressed,
    uint16_t raw_x,
    uint16_t raw_y,
    float coefficients[DECK_CALIBRATION_COEFFICIENTS]
)
{
    if (s_index >= CALIBRATE_TOTAL_POINTS) {
        return DECK_CALIBRATE_RUNNING;
    }

    if (pressed) {
        /* Hold the newest sample and commit it on release: the last reading
           before lift is the settled one, and the first after touchdown is
           the noisiest. */
        s_press_raw_x = raw_x;
        s_press_raw_y = raw_y;
        s_was_pressed = true;
        return DECK_CALIBRATE_RUNNING;
    }

    if (!s_was_pressed) {
        return DECK_CALIBRATE_RUNNING;
    }

    s_was_pressed = false;
    s_samples_x[s_index] = s_press_raw_x;
    s_samples_y[s_index] = s_press_raw_y;
    s_index++;

    if (s_index < CALIBRATE_TOTAL_POINTS) {
        place_target();
        return DECK_CALIBRATE_RUNNING;
    }

    return finish(coefficients);
}

const char *deck_calibrate_poll(void)
{
    if (s_outcome != NULL) {
        return s_outcome;
    }

    uint16_t raw_x = 0;
    uint16_t raw_y = 0;
    const bool pressed = bsp_touch_read_raw(&raw_x, &raw_y);

    if (pressed) {
        s_activity_ms = now_ms();
    } else if (now_ms() - s_activity_ms >= CALIBRATE_TIMEOUT_MS) {
        s_outcome = "{\"type\":\"calibrate\",\"state\":\"cancelled\"}";
        return s_outcome;
    }

    float coefficients[DECK_CALIBRATION_COEFFICIENTS];

    /* Feeding moves the target, so it needs the lock. A busy lock only skips
       this sample; the press latch survives to the next poll. */
    if (!bsp_display_lock(20)) {
        return NULL;
    }

    const deck_calibrate_state_t state =
        feed(pressed, raw_x, raw_y, coefficients);

    bsp_display_unlock();

    if (state == DECK_CALIBRATE_RUNNING) {
        return NULL;
    }

    if (state == DECK_CALIBRATE_DONE) {
        bsp_touch_set_calibration(coefficients);
        deck_settings_set_calibration(coefficients);
        s_outcome = "{\"type\":\"calibrate\",\"state\":\"done\"}";
    } else {
        s_outcome = "{\"type\":\"calibrate\",\"state\":\"failed\"}";
    }

    return s_outcome;
}
