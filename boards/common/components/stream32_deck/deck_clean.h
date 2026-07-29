// The screen-cleaning overlay: a dark screen whose only live target is one
// centred hold. deck_ui decides when the lock is on; this owns what it looks
// like and how long the current hold has lasted.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

// Builds the overlay on first use and returns it. Call with the display lock
// held; the caller loads the returned screen.
lv_obj_t *deck_clean_screen(void);

// Drops any hold in progress and empties the progress bar. Display lock held.
void deck_clean_reset(void);

// True once the target has been held long enough to release the lock. Safe to
// poll from the protocol task: it reads only the press timestamp.
bool deck_clean_held(int64_t now_ms);

#ifdef __cplusplus
}
#endif
