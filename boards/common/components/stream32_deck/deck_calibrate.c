#include "deck_calibrate.h"

#include <stdio.h>

#include "deck_affine.h"
#include "esp_err.h"
#include "esp_timer.h"

/* Same arrangement as deck_ui: the BSP component name differs per board, so
   the contract is declared rather than included. */
extern bool bsp_display_lock(uint32_t timeout_ms);
extern void bsp_display_unlock(void);
extern bool bsp_touch_read_raw(uint16_t *x, uint16_t *y);
extern uint16_t bsp_display_rotation(void);
extern esp_err_t bsp_touch_set_calibration(
    const float coefficients[DECK_CALIBRATION_COEFFICIENTS]
);

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

/* Read from LVGL, not Kconfig: the targets have to land on the screen as it
   is oriented right now, and deck_calibrate_reset re-places them on entry. */
static int32_t screen_w(void)
{
    return lv_display_get_horizontal_resolution(lv_display_get_default());
}

static int32_t screen_h(void)
{
    return lv_display_get_vertical_resolution(lv_display_get_default());
}

static int32_t target_x(uint8_t index)
{
    return screen_w() * TARGET_PERCENT[index][0] / 100;
}

static int32_t target_y(uint8_t index)
{
    return screen_h() * TARGET_PERCENT[index][1] / 100;
}

static int32_t short_edge(void)
{
    const int32_t width = screen_w();
    const int32_t height = screen_h();

    return width < height ? width : height;
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

/* Markers are drawn in the rotated space the person is looking at, but the
   solve has to land in unrotated coordinates so the result survives a later
   rotation change. The touch driver turns each sample back on the way out. */
static void unrotated_target(uint8_t index, int32_t *x, int32_t *y)
{
    const uint16_t degrees = bsp_display_rotation();
    const bool quarter_turn = degrees == 90 || degrees == 270;
    const int32_t base_w = quarter_turn ? screen_h() : screen_w();
    const int32_t base_h = quarter_turn ? screen_w() : screen_h();

    deck_affine_unrotate(
        degrees,
        base_w,
        base_h,
        target_x(index),
        target_y(index),
        x,
        y
    );
}

static deck_calibrate_state_t finish(
    float coefficients[DECK_CALIBRATION_COEFFICIENTS]
)
{
    int32_t screen_x[CALIBRATE_SOLVE_POINTS];
    int32_t screen_y[CALIBRATE_SOLVE_POINTS];

    for (uint8_t index = 0; index < CALIBRATE_SOLVE_POINTS; index++) {
        unrotated_target(index, &screen_x[index], &screen_y[index]);
    }

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
    int32_t check_x;
    int32_t check_y;

    unrotated_target(check, &check_x, &check_y);

    const float mapped_x = coefficients[0] * s_samples_x[check] +
        coefficients[1] * s_samples_y[check] + coefficients[2];
    const float mapped_y = coefficients[3] * s_samples_x[check] +
        coefficients[4] * s_samples_y[check] + coefficients[5];
    const float error_x = mapped_x - check_x;
    const float error_y = mapped_y - check_y;
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
