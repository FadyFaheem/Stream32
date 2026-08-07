#include "deck_settings.h"

#include <string.h>

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

/* Same arrangement as deck_ui: the BSP component name differs per board, so
   the contract is declared rather than included. */
extern esp_err_t bsp_display_set_invert(bool invert);
extern esp_err_t bsp_display_set_rotation(uint16_t degrees);
extern esp_err_t bsp_touch_set_calibration(
    const float coefficients[DECK_CALIBRATION_COEFFICIENTS]
);

#define DECK_SETTINGS_NAMESPACE "stream32"
#define DECK_SETTINGS_KEY_CALIBRATION "touchcal"
#define DECK_SETTINGS_KEY_INVERT "invert"
#define DECK_SETTINGS_KEY_ROTATION "rotation"

static const char *TAG = "deck_settings";
static bool s_mounted;

esp_err_t deck_settings_init(void)
{
    if (s_mounted) {
        return ESP_OK;
    }

    esp_err_t error = nvs_flash_init();

    /* A partition grown by an older build or left half-written by a power cut
       is worth more empty than absent: losing the calibration is recoverable
       from the desktop, failing to mount is not. */
    if (error == ESP_ERR_NVS_NO_FREE_PAGES ||
        error == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "Erasing NVS: %s", esp_err_to_name(error));

        error = nvs_flash_erase();

        if (error == ESP_OK) {
            error = nvs_flash_init();
        }
    }

    s_mounted = error == ESP_OK;

    if (!s_mounted) {
        ESP_LOGE(TAG, "NVS unavailable: %s", esp_err_to_name(error));
    }

    return error;
}

void deck_settings_apply(void)
{
    float coefficients[DECK_CALIBRATION_COEFFICIENTS];
    bool invert;
    uint16_t degrees;

    /* Rotation first: it changes the screen size everything else is laid out
       against, and the calibration is stored in unrotated coordinates so it
       does not care which way round the panel ends up. */
    if (deck_settings_get_rotation(&degrees)) {
        bsp_display_set_rotation(degrees);
    }

    if (deck_settings_get_calibration(coefficients)) {
        bsp_touch_set_calibration(coefficients);
    }

    /* Nothing stored leaves the board's compiled-in default standing. */
    if (deck_settings_get_invert(&invert)) {
        bsp_display_set_invert(invert);
    }
}

bool deck_settings_get_calibration(
    float coefficients[DECK_CALIBRATION_COEFFICIENTS]
)
{
    if (!s_mounted || coefficients == NULL) {
        return false;
    }

    nvs_handle_t handle;

    if (nvs_open(DECK_SETTINGS_NAMESPACE, NVS_READONLY, &handle) != ESP_OK) {
        return false;
    }

    float stored[DECK_CALIBRATION_COEFFICIENTS];
    size_t length = sizeof(stored);
    const esp_err_t error = nvs_get_blob(
        handle,
        DECK_SETTINGS_KEY_CALIBRATION,
        stored,
        &length
    );

    nvs_close(handle);

    if (error != ESP_OK || length != sizeof(stored)) {
        return false;
    }

    memcpy(coefficients, stored, sizeof(stored));
    return true;
}

esp_err_t deck_settings_set_calibration(
    const float coefficients[DECK_CALIBRATION_COEFFICIENTS]
)
{
    if (coefficients == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    if (!s_mounted) {
        return ESP_ERR_INVALID_STATE;
    }

    nvs_handle_t handle;
    esp_err_t error = nvs_open(DECK_SETTINGS_NAMESPACE, NVS_READWRITE, &handle);

    if (error != ESP_OK) {
        return error;
    }

    error = nvs_set_blob(
        handle,
        DECK_SETTINGS_KEY_CALIBRATION,
        coefficients,
        sizeof(float) * DECK_CALIBRATION_COEFFICIENTS
    );

    if (error == ESP_OK) {
        error = nvs_commit(handle);
    }

    nvs_close(handle);
    return error;
}

bool deck_settings_get_invert(bool *invert)
{
    if (!s_mounted || invert == NULL) {
        return false;
    }

    nvs_handle_t handle;

    if (nvs_open(DECK_SETTINGS_NAMESPACE, NVS_READONLY, &handle) != ESP_OK) {
        return false;
    }

    uint8_t stored = 0;
    const esp_err_t error =
        nvs_get_u8(handle, DECK_SETTINGS_KEY_INVERT, &stored);

    nvs_close(handle);

    if (error != ESP_OK) {
        return false;
    }

    *invert = stored != 0;
    return true;
}

bool deck_settings_get_rotation(uint16_t *degrees)
{
    if (!s_mounted || degrees == NULL) {
        return false;
    }

    nvs_handle_t handle;

    if (nvs_open(DECK_SETTINGS_NAMESPACE, NVS_READONLY, &handle) != ESP_OK) {
        return false;
    }

    uint16_t stored = 0;
    const esp_err_t error =
        nvs_get_u16(handle, DECK_SETTINGS_KEY_ROTATION, &stored);

    nvs_close(handle);

    /* A value written by a newer build is discarded rather than passed on to
       a BSP that would reject it. */
    if (error != ESP_OK || (stored != 0 && stored != 90 && stored != 180 &&
                            stored != 270)) {
        return false;
    }

    *degrees = stored;
    return true;
}

esp_err_t deck_settings_set_rotation(uint16_t degrees)
{
    if (degrees != 0 && degrees != 90 && degrees != 180 && degrees != 270) {
        return ESP_ERR_INVALID_ARG;
    }

    if (!s_mounted) {
        return ESP_ERR_INVALID_STATE;
    }

    nvs_handle_t handle;
    esp_err_t error = nvs_open(DECK_SETTINGS_NAMESPACE, NVS_READWRITE, &handle);

    if (error != ESP_OK) {
        return error;
    }

    error = nvs_set_u16(handle, DECK_SETTINGS_KEY_ROTATION, degrees);

    if (error == ESP_OK) {
        error = nvs_commit(handle);
    }

    nvs_close(handle);
    return error;
}

esp_err_t deck_settings_set_invert(bool invert)
{
    if (!s_mounted) {
        return ESP_ERR_INVALID_STATE;
    }

    nvs_handle_t handle;
    esp_err_t error = nvs_open(DECK_SETTINGS_NAMESPACE, NVS_READWRITE, &handle);

    if (error != ESP_OK) {
        return error;
    }

    error = nvs_set_u8(handle, DECK_SETTINGS_KEY_INVERT, invert ? 1 : 0);

    if (error == ESP_OK) {
        error = nvs_commit(handle);
    }

    nvs_close(handle);
    return error;
}
