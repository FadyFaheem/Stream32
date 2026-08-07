#include "deck_layout.h"

#include "deck_settings.h"
#include "lvgl.h"
#include "sdkconfig.h"

#define DECK_KEY_MAX_PX CONFIG_STREAM32_DECK_KEY_MAX_PX
/* Floor for inset artwork, matching the host's lower bound on layout-ack's
   keyPx. A tile small enough to reach it is unreadable regardless. */
#define DECK_ICON_MIN_PX 16

static uint8_t s_icon_percent = 100;
static uint8_t s_label_lines = 1;

void deck_layout_init(void)
{
    uint8_t stored;

    if (deck_settings_get_icon_percent(&stored)) {
        s_icon_percent = stored;
    }

    if (deck_settings_get_label_lines(&stored)) {
        s_label_lines = stored;
    }
}

int deck_layout_label_h(void)
{
    return s_label_lines > 1
        ? s_label_lines * lv_font_get_line_height(LV_FONT_DEFAULT)
        : 0;
}

int32_t deck_layout_screen_w(void)
{
    return lv_display_get_horizontal_resolution(lv_display_get_default());
}

int32_t deck_layout_screen_h(void)
{
    return lv_display_get_vertical_resolution(lv_display_get_default());
}

int deck_layout_key_px(int rows, int cols)
{
    const int width =
        (deck_layout_screen_w() - DECK_KEY_GAP * (cols + 1)) / cols;
    const int height =
        (deck_layout_screen_h() - DECK_KEY_GAP * (rows + 1)) / rows;
    const int size = width < height ? width : height;

    return size > DECK_KEY_MAX_PX ? DECK_KEY_MAX_PX : size;
}

/* The tile keeps whatever size the grid gives it and only the picture
   shrinks, which is what a small panel needs: a 2x2 page on 320x240
   otherwise hands every key a 108 px icon. A multi-line label takes its
   share out of the same tile, so the icon yields to that as well. */
int deck_layout_icon_px(int rows, int cols)
{
    const int key_px = deck_layout_key_px(rows, cols);
    const int scaled = key_px * s_icon_percent / 100;
    const int room = key_px - deck_layout_label_h();
    const int size = scaled < room ? scaled : room;

    return size < DECK_ICON_MIN_PX ? DECK_ICON_MIN_PX : size;
}

void deck_layout_grid_origin(int rows, int cols, int *x, int *y)
{
    const int key_px = deck_layout_key_px(rows, cols);
    const int width = cols * key_px + (cols - 1) * DECK_KEY_GAP;
    const int height = rows * key_px + (rows - 1) * DECK_KEY_GAP;

    *x = (deck_layout_screen_w() - width) / 2;
    *y = (deck_layout_screen_h() - height) / 2;
}

uint8_t deck_layout_icon_percent(void)
{
    return s_icon_percent;
}

uint8_t deck_layout_label_lines(void)
{
    return s_label_lines;
}

bool deck_layout_set_icon_percent(uint8_t percent)
{
    if (percent < DECK_ICON_PERCENT_MIN || percent > 100 ||
        percent == s_icon_percent) {
        return false;
    }

    s_icon_percent = percent;
    deck_settings_set_icon_percent(percent);
    return true;
}

bool deck_layout_set_label_lines(uint8_t lines)
{
    if (lines < 1 || lines > DECK_LABEL_LINES_MAX || lines == s_label_lines) {
        return false;
    }

    s_label_lines = lines;
    deck_settings_set_label_lines(lines);
    return true;
}
