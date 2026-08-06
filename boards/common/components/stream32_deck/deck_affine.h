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

#ifdef __cplusplus
}
#endif
