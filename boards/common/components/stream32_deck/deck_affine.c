#include "deck_affine.h"

/* Raw counts span roughly 0-4095, so three well-separated taps produce a
   determinant in the millions. This floor only rejects taps that landed
   effectively on one line. */
#define DECK_AFFINE_MIN_DETERMINANT 10000.0f

bool deck_affine_solve(
    const uint16_t raw_x[3],
    const uint16_t raw_y[3],
    const int32_t screen_x[3],
    const int32_t screen_y[3],
    float coefficients[DECK_CALIBRATION_COEFFICIENTS]
)
{
    /* Cramer's rule on the two 3x3 systems that share this matrix:
         | rx0 ry0 1 |   | a |   | sx0 |
         | rx1 ry1 1 | . | b | = | sx1 |
         | rx2 ry2 1 |   | c |   | sx2 |
       and the same for (d, e, f) against screen_y. */
    const float rx0 = raw_x[0], rx1 = raw_x[1], rx2 = raw_x[2];
    const float ry0 = raw_y[0], ry1 = raw_y[1], ry2 = raw_y[2];
    const float determinant = rx0 * (ry1 - ry2) - ry0 * (rx1 - rx2) +
        (rx1 * ry2 - rx2 * ry1);

    if (determinant > -DECK_AFFINE_MIN_DETERMINANT &&
        determinant < DECK_AFFINE_MIN_DETERMINANT) {
        return false;
    }

    for (int axis = 0; axis < 2; axis++) {
        const int32_t *screen = axis == 0 ? screen_x : screen_y;
        const float s0 = screen[0], s1 = screen[1], s2 = screen[2];

        coefficients[axis * 3 + 0] =
            (s0 * (ry1 - ry2) - ry0 * (s1 - s2) + (s1 * ry2 - s2 * ry1)) /
            determinant;
        coefficients[axis * 3 + 1] =
            (rx0 * (s1 - s2) - s0 * (rx1 - rx2) + (rx1 * s2 - rx2 * s1)) /
            determinant;
        coefficients[axis * 3 + 2] =
            (rx0 * (ry1 * s2 - ry2 * s1) - ry0 * (rx1 * s2 - rx2 * s1) +
             s0 * (rx1 * ry2 - rx2 * ry1)) /
            determinant;
    }

    return true;
}

void deck_affine_rotate(
    uint16_t degrees,
    int32_t base_w,
    int32_t base_h,
    int32_t x,
    int32_t y,
    int32_t *out_x,
    int32_t *out_y
)
{
    switch (degrees) {
    case 90:
        *out_x = base_h - 1 - y;
        *out_y = x;
        break;
    case 180:
        *out_x = base_w - 1 - x;
        *out_y = base_h - 1 - y;
        break;
    case 270:
        *out_x = y;
        *out_y = base_w - 1 - x;
        break;
    default:
        *out_x = x;
        *out_y = y;
        break;
    }
}

void deck_affine_unrotate(
    uint16_t degrees,
    int32_t base_w,
    int32_t base_h,
    int32_t x,
    int32_t y,
    int32_t *out_x,
    int32_t *out_y
)
{
    switch (degrees) {
    case 90:
        *out_x = y;
        *out_y = base_h - 1 - x;
        break;
    case 180:
        *out_x = base_w - 1 - x;
        *out_y = base_h - 1 - y;
        break;
    case 270:
        *out_x = base_w - 1 - y;
        *out_y = x;
        break;
    default:
        *out_x = x;
        *out_y = y;
        break;
    }
}
