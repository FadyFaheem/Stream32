// The touch calibration overlay: a sequence of targets whose raw samples
// solve the affine transform from panel ADC counts to screen pixels.
//
// deck_ui decides when the wizard is on; this owns what it looks like, which
// target is next, and the arithmetic. Like deck_clean it never touches the
// deck grid, storage, or the protocol.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "deck_settings.h"
#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

// Builds the overlay on first use and returns it. Call with the display lock
// held; the caller loads the returned screen.
lv_obj_t *deck_calibrate_screen(void);

// Arms the wizard at its first target. Display lock held.
void deck_calibrate_reset(void);

// Samples the panel, advances the target, and on the last tap solves,
// applies and persists the transform. Returns NULL while the wizard is still
// running, or the ready-to-send outcome line once it is over. Call from the
// protocol task without the display lock: it takes the lock itself.
//
// The outcome latches, so a caller that cannot release the screen right away
// sees the same line on its next poll.
const char *deck_calibrate_poll(void);

#ifdef __cplusplus
}
#endif
