#include "deck_artwork.h"

#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"

static const char *TAG = "deck_artwork";
static uint8_t *s_buffers[DECK_MAX_KEYS];
static lv_image_dsc_t s_descriptors[DECK_MAX_KEYS];

void deck_artwork_release(void)
{
    for (int index = 0; index < DECK_MAX_KEYS; index++) {
        if (s_buffers[index] != NULL) {
            heap_caps_free(s_buffers[index]);
            s_buffers[index] = NULL;
        }
    }
}

void deck_artwork_load(const uint32_t *crcs, int count, int key_px)
{
    const uint32_t size = (uint32_t)key_px * key_px * 2;

    if (count > DECK_MAX_KEYS) {
        count = DECK_MAX_KEYS;
    }

    for (int index = 0; index < count; index++) {
        uint32_t stored_size = 0;

        if (crcs[index] == 0 ||
            !deck_storage_slot_find(crcs[index], &stored_size) ||
            stored_size != size) {
            continue;
        }

        s_buffers[index] = heap_caps_malloc_prefer(
            size,
            2,
            MALLOC_CAP_SPIRAM,
            MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT
        );

        if (s_buffers[index] == NULL) {
            ESP_LOGW(TAG, "Out of memory for key %d artwork", index);
            continue;
        }

        if (deck_storage_slot_read(crcs[index], s_buffers[index], size) !=
            ESP_OK) {
            heap_caps_free(s_buffers[index]);
            s_buffers[index] = NULL;
        }
    }
}

const uint8_t *deck_artwork_pixels(int index)
{
    return index >= 0 && index < DECK_MAX_KEYS ? s_buffers[index] : NULL;
}

void deck_artwork_attach(
    lv_obj_t *parent,
    int index,
    int key_px,
    const uint8_t *pixels
)
{
    lv_image_dsc_t *descriptor = &s_descriptors[index];

    memset(descriptor, 0, sizeof(*descriptor));
    descriptor->header.magic = LV_IMAGE_HEADER_MAGIC;
    descriptor->header.cf = LV_COLOR_FORMAT_RGB565;
    descriptor->header.w = key_px;
    descriptor->header.h = key_px;
    descriptor->header.stride = key_px * 2;
    descriptor->data_size = (uint32_t)key_px * key_px * 2;
    descriptor->data = pixels;

    lv_obj_t *image = lv_image_create(parent);

    lv_image_set_src(image, descriptor);
    lv_obj_center(image);
    /* The parent key owns the full touch target; artwork is visual only. */
    lv_obj_remove_flag(image, LV_OBJ_FLAG_CLICKABLE);
    /* Labels stay above artwork. */
    lv_obj_move_to_index(image, 0);
}
