// The arithmetic behind touch calibration, kept apart from the LVGL overlay
// that collects the taps so it can be compiled and checked on a host.
#pragma once

#include <stdbool.h>
#include <stdint.h>

// Six coefficients mapping a raw touch sample to screen pixels:
//   x = a * raw_x + b * raw_y + c
//   y = d * raw_x + e * raw_y + f
#define DECK_CALIBRATION_COEFFICIENTS 6

#ifdef __cplusplus
extern "C" {
#endif

// Solves both rows of the transform from three tapped targets. Returns false
// when the three taps are too close to collinear to describe a plane, which
// is what a slipped or double-registered tap looks like.
//
// An affine fit is what lets one wizard absorb offset, scale, axis swap,
// mirroring and a panel mounted slightly askew, instead of each of those
// being a compile-time guess per board.
bool deck_affine_solve(
    const uint16_t raw_x[3],
    const uint16_t raw_y[3],
    const int32_t screen_x[3],
    const int32_t screen_y[3],
    float coefficients[DECK_CALIBRATION_COEFFICIENTS]
);

// Rotation helpers shared by the touch driver and the calibration wizard.
//
// A calibration is stored against the panel's unrotated orientation so that
// turning the display never invalidates it. The driver rotates each sampled
// point on the way out, and the wizard unrotates its markers on the way in.
// Keeping both directions here means they cannot drift apart, and lets a
// host test prove they are inverses.
//
// base_w and base_h are the unrotated size. Degrees must be 0, 90, 180 or
// 270; anything else is treated as 0.

// Unrotated point to where it lands on a display turned by `degrees`.
void deck_affine_rotate(
    uint16_t degrees,
    int32_t base_w,
    int32_t base_h,
    int32_t x,
    int32_t y,
    int32_t *out_x,
    int32_t *out_y
);

// The inverse: a point on the turned display back to unrotated space.
void deck_affine_unrotate(
    uint16_t degrees,
    int32_t base_w,
    int32_t base_h,
    int32_t x,
    int32_t y,
    int32_t *out_x,
    int32_t *out_y
);

#ifdef __cplusplus
}
#endif
