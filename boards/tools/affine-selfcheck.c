/*
 * Host self-check for the touch calibration solve.
 *
 * The wizard's whole value is that one transform absorbs offset, scale, axis
 * swap, mirroring and a panel mounted askew. That is only true if the solve
 * is right, and a wrong solve fails silently as "touch is a bit off", so it
 * is checked here against panels whose answer is known in advance.
 *
 * Built and run by affine-solve.test.js.
 */
#include <assert.h>
#include <stddef.h>
#include <stdio.h>

#include "deck_affine.h"

#define SCREEN_W 320
#define SCREEN_H 240
/* Raw counts are integers, so a solved coefficient lands a fraction of a
   pixel away from the exact answer. */
#define TOLERANCE 0.5f

/* Where the wizard puts its three solve targets. */
static const int32_t TARGET_X[3] = {48, 272, 160};
static const int32_t TARGET_Y[3] = {36, 36, 204};

static float mapped(const float c[3], uint16_t raw_x, uint16_t raw_y)
{
    return c[0] * raw_x + c[1] * raw_y + c[2];
}

static void check_close(float actual, float expected, const char *what)
{
    const float error = actual - expected;
    const float magnitude = error < 0 ? -error : error;

    if (magnitude > TOLERANCE) {
        printf("FAIL %s: got %.3f, wanted %.3f\n", what, actual, expected);
        assert(0);
    }
}

/* Feeds the solver raw samples produced by a panel with a known wiring, then
   checks that applying the result recovers the screen points it was given
   plus a fourth point it was not. */
static void check_panel(
    const char *name,
    uint16_t (*to_raw_x)(int32_t x, int32_t y),
    uint16_t (*to_raw_y)(int32_t x, int32_t y)
)
{
    uint16_t raw_x[3];
    uint16_t raw_y[3];
    float coefficients[DECK_CALIBRATION_COEFFICIENTS];

    for (int index = 0; index < 3; index++) {
        raw_x[index] = to_raw_x(TARGET_X[index], TARGET_Y[index]);
        raw_y[index] = to_raw_y(TARGET_X[index], TARGET_Y[index]);
    }

    assert(deck_affine_solve(raw_x, raw_y, TARGET_X, TARGET_Y, coefficients));

    for (int index = 0; index < 3; index++) {
        check_close(
            mapped(coefficients, raw_x[index], raw_y[index]),
            TARGET_X[index],
            name
        );
        check_close(
            mapped(coefficients + 3, raw_x[index], raw_y[index]),
            TARGET_Y[index],
            name
        );
    }

    /* The centre is the wizard's verification tap and was not part of the
       solve, so this is what proves the fit generalizes. */
    const int32_t centre_x = SCREEN_W / 2;
    const int32_t centre_y = SCREEN_H / 2;
    const uint16_t centre_raw_x = to_raw_x(centre_x, centre_y);
    const uint16_t centre_raw_y = to_raw_y(centre_x, centre_y);

    check_close(mapped(coefficients, centre_raw_x, centre_raw_y), centre_x, name);
    check_close(
        mapped(coefficients + 3, centre_raw_x, centre_raw_y),
        centre_y,
        name
    );
    printf("ok %s\n", name);
}

/* A well-behaved panel: raw counts rise with screen coordinates. */
static uint16_t plain_x(int32_t x, int32_t y) { (void)y; return 300 + x * 11; }
static uint16_t plain_y(int32_t x, int32_t y) { (void)x; return 320 + y * 14; }

/* Portrait glass on a landscape screen: the axes are swapped. */
static uint16_t swapped_x(int32_t x, int32_t y) { (void)x; return 280 + y * 15; }
static uint16_t swapped_y(int32_t x, int32_t y) { (void)y; return 350 + x * 11; }

/* Mounted the other way up: both axes run backwards. */
static uint16_t mirrored_x(int32_t x, int32_t y) { (void)y; return 3900 - x * 11; }
static uint16_t mirrored_y(int32_t x, int32_t y) { (void)x; return 3800 - y * 14; }

/* Glass fitted slightly askew, which is the case only an affine fit can
   describe and the reason this is not a two-corner min/max map. */
static uint16_t skewed_x(int32_t x, int32_t y) { return 300 + x * 11 + y / 2; }
static uint16_t skewed_y(int32_t x, int32_t y) { return 320 + y * 14 - x / 2; }

/* Turning the display must not invalidate a calibration, which only holds if
 * rotate and unrotate are exact inverses and every rotated point lands inside
 * the turned screen. Both are cheap to prove here and impossible to notice by
 * eye on hardware, where a wrong corner just feels like drift. */
static void check_rotations(void)
{
    const uint16_t angles[] = {0, 90, 180, 270};

    for (size_t index = 0; index < 4; index++) {
        const uint16_t degrees = angles[index];
        /* A quarter turn swaps which edge is which. */
        const int32_t turned_w = (degrees == 90 || degrees == 270)
            ? SCREEN_H
            : SCREEN_W;
        const int32_t turned_h = (degrees == 90 || degrees == 270)
            ? SCREEN_W
            : SCREEN_H;

        for (int32_t y = 0; y < SCREEN_H; y += 17) {
            for (int32_t x = 0; x < SCREEN_W; x += 17) {
                int32_t rx, ry, bx, by;

                deck_affine_rotate(degrees, SCREEN_W, SCREEN_H, x, y, &rx, &ry);

                if (rx < 0 || rx >= turned_w || ry < 0 || ry >= turned_h) {
                    printf(
                        "FAIL rotate %u: (%d,%d) left the screen at (%d,%d)\n",
                        degrees,
                        (int)x,
                        (int)y,
                        (int)rx,
                        (int)ry
                    );
                    assert(0);
                }

                deck_affine_unrotate(
                    degrees, SCREEN_W, SCREEN_H, rx, ry, &bx, &by
                );

                if (bx != x || by != y) {
                    printf(
                        "FAIL round trip %u: (%d,%d) came back (%d,%d)\n",
                        degrees,
                        (int)x,
                        (int)y,
                        (int)bx,
                        (int)by
                    );
                    assert(0);
                }
            }
        }
    }

    /* The corner each turn sends the origin to, spelled out so a sign slip
       cannot hide behind a symmetric round trip. */
    int32_t x, y;

    deck_affine_rotate(90, SCREEN_W, SCREEN_H, 0, 0, &x, &y);
    assert(x == SCREEN_H - 1 && y == 0);
    deck_affine_rotate(180, SCREEN_W, SCREEN_H, 0, 0, &x, &y);
    assert(x == SCREEN_W - 1 && y == SCREEN_H - 1);
    deck_affine_rotate(270, SCREEN_W, SCREEN_H, 0, 0, &x, &y);
    assert(x == 0 && y == SCREEN_W - 1);
    printf("ok rotation round trips and corners\n");
}

int main(void)
{
    check_panel("plain panel", plain_x, plain_y);
    check_panel("swapped axes", swapped_x, swapped_y);
    check_panel("mirrored axes", mirrored_x, mirrored_y);
    check_panel("skewed glass", skewed_x, skewed_y);
    check_rotations();

    /* Three taps on one line describe no plane. A slipped tap that lands on
       the line through the other two must be rejected, not turned into a
       transform built from a near-zero determinant. */
    float coefficients[DECK_CALIBRATION_COEFFICIENTS];
    const uint16_t collinear_x[3] = {1000, 2000, 3000};
    const uint16_t collinear_y[3] = {1000, 2000, 3000};

    assert(!deck_affine_solve(
        collinear_x,
        collinear_y,
        TARGET_X,
        TARGET_Y,
        coefficients
    ));
    printf("ok collinear taps rejected\n");

    /* The same tap registered three times is the degenerate extreme. */
    const uint16_t identical_x[3] = {2048, 2048, 2048};
    const uint16_t identical_y[3] = {2048, 2048, 2048};

    assert(!deck_affine_solve(
        identical_x,
        identical_y,
        TARGET_X,
        TARGET_Y,
        coefficients
    ));
    printf("ok repeated tap rejected\n");
    return 0;
}
