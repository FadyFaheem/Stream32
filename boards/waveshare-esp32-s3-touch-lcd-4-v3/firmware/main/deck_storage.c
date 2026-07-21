#include "deck_storage.h"

#include <stddef.h>
#include <string.h>

#include "esp_log.h"
#include "esp_partition.h"
#include "esp_rom_crc.h"

#define DECK_HEADER_MAGIC 0x44323353u /* "S32D" */
#define DECK_PAGE_MAGIC 0x50323353u   /* "S32P" */
#define DECK_STORAGE_VERSION 1u
#define DECK_SECTOR 4096u
#define DECK_POOL_OFFSET ((uint32_t)DECK_SECTOR * (1u + DECK_MAX_PAGES))
#define DECK_PARTITION_SUBTYPE 0x40

typedef struct __attribute__((packed)) {
    uint32_t crc;
    uint32_t size;
} deck_slot_t;

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t version;
    uint8_t page_count;
    uint8_t active_page;
    uint8_t reserved[2];
    deck_slot_t slots[DECK_MAX_SLOTS];
    uint32_t header_crc;
} deck_header_t;

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t length;
    uint32_t json_crc;
} deck_page_header_t;

_Static_assert(
    sizeof(deck_header_t) <= DECK_SECTOR,
    "Deck header must fit one erase sector"
);
_Static_assert(
    sizeof(deck_page_header_t) + DECK_PAGE_JSON_CAPACITY <= DECK_SECTOR,
    "Deck page metadata must fit one erase sector"
);

static const char *TAG = "deck_storage";
static const esp_partition_t *s_partition;
static deck_header_t s_header;
static bool s_header_valid;
/* The USB protocol task is the only writer, so one scratch sector is safe. */
static uint8_t s_sector[DECK_SECTOR];

static uint32_t compute_header_crc(const deck_header_t *header)
{
    return esp_rom_crc32_le(
        0,
        (const uint8_t *)header,
        offsetof(deck_header_t, header_crc)
    );
}

static void reset_header(void)
{
    memset(&s_header, 0, sizeof(s_header));
    s_header.magic = DECK_HEADER_MAGIC;
    s_header.version = DECK_STORAGE_VERSION;
    s_header_valid = false;
}

static esp_err_t write_header(void)
{
    s_header.header_crc = compute_header_crc(&s_header);

    esp_err_t error = esp_partition_erase_range(s_partition, 0, DECK_SECTOR);

    if (error == ESP_OK) {
        error = esp_partition_write(s_partition, 0, &s_header, sizeof(s_header));
    }

    if (error == ESP_OK) {
        s_header_valid = true;
    } else {
        ESP_LOGW(TAG, "Header write failed: %s", esp_err_to_name(error));
    }

    return error;
}

esp_err_t deck_storage_init(void)
{
    s_partition = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA,
        DECK_PARTITION_SUBTYPE,
        "deck"
    );
    reset_header();

    if (s_partition == NULL) {
        ESP_LOGE(TAG, "Deck partition is missing from the partition table");
        return ESP_ERR_NOT_FOUND;
    }

    deck_header_t stored;
    esp_err_t error = esp_partition_read(s_partition, 0, &stored, sizeof(stored));

    if (error != ESP_OK) {
        return error;
    }

    if (stored.magic == DECK_HEADER_MAGIC &&
        stored.version == DECK_STORAGE_VERSION &&
        stored.page_count >= 1 &&
        stored.page_count <= DECK_MAX_PAGES &&
        stored.active_page < stored.page_count &&
        stored.header_crc == compute_header_crc(&stored)) {
        s_header = stored;
        s_header_valid = true;
    }

    return ESP_OK;
}

bool deck_storage_has_state(void)
{
    return s_header_valid && s_header.page_count >= 1;
}

uint8_t deck_storage_page_count(void)
{
    return s_header.page_count;
}

uint8_t deck_storage_active_page(void)
{
    return s_header.active_page;
}

bool deck_storage_read_page_json(
    uint8_t page,
    char *out,
    size_t capacity,
    size_t *length_out
)
{
    if (s_partition == NULL || page >= DECK_MAX_PAGES) {
        return false;
    }

    const uint32_t offset = DECK_SECTOR * (1u + page);
    deck_page_header_t page_header;

    if (esp_partition_read(
            s_partition,
            offset,
            &page_header,
            sizeof(page_header)
        ) != ESP_OK) {
        return false;
    }

    if (page_header.magic != DECK_PAGE_MAGIC ||
        page_header.length == 0 ||
        page_header.length > DECK_PAGE_JSON_CAPACITY ||
        page_header.length + 1 > capacity) {
        return false;
    }

    if (esp_partition_read(
            s_partition,
            offset + sizeof(page_header),
            out,
            page_header.length
        ) != ESP_OK) {
        return false;
    }

    if (esp_rom_crc32_le(0, (const uint8_t *)out, page_header.length) !=
        page_header.json_crc) {
        return false;
    }

    out[page_header.length] = '\0';

    if (length_out != NULL) {
        *length_out = page_header.length;
    }

    return true;
}

esp_err_t deck_storage_write_page_json(
    uint8_t page,
    const char *json,
    size_t length,
    uint8_t page_count
)
{
    if (s_partition == NULL || page >= DECK_MAX_PAGES ||
        page_count < 1 || page_count > DECK_MAX_PAGES ||
        length == 0 || length > DECK_PAGE_JSON_CAPACITY) {
        return ESP_ERR_INVALID_ARG;
    }

    const uint32_t json_crc = esp_rom_crc32_le(0, (const uint8_t *)json, length);
    const uint32_t offset = DECK_SECTOR * (1u + page);
    deck_page_header_t existing;
    const bool page_matches =
        esp_partition_read(s_partition, offset, &existing, sizeof(existing)) ==
            ESP_OK &&
        existing.magic == DECK_PAGE_MAGIC &&
        existing.length == length &&
        existing.json_crc == json_crc;

    if (!page_matches) {
        deck_page_header_t page_header = {
            .magic = DECK_PAGE_MAGIC,
            .length = (uint32_t)length,
            .json_crc = json_crc,
        };

        memset(s_sector, 0xff, sizeof(s_sector));
        memcpy(s_sector, &page_header, sizeof(page_header));
        memcpy(s_sector + sizeof(page_header), json, length);

        esp_err_t error = esp_partition_erase_range(
            s_partition,
            offset,
            DECK_SECTOR
        );

        if (error == ESP_OK) {
            error = esp_partition_write(
                s_partition,
                offset,
                s_sector,
                sizeof(page_header) + length
            );
        }

        if (error != ESP_OK) {
            ESP_LOGW(TAG, "Page %u write failed: %s", page, esp_err_to_name(error));
            return error;
        }
    }

    if (!s_header_valid || s_header.page_count != page_count ||
        s_header.active_page >= page_count) {
        s_header.page_count = page_count;

        if (s_header.active_page >= page_count) {
            s_header.active_page = 0;
        }

        return write_header();
    }

    return ESP_OK;
}

esp_err_t deck_storage_set_active_page(uint8_t page)
{
    if (!s_header_valid || page >= s_header.page_count) {
        return ESP_ERR_INVALID_ARG;
    }

    if (s_header.active_page == page) {
        return ESP_OK;
    }

    s_header.active_page = page;
    return write_header();
}

static int find_slot(uint32_t crc)
{
    if (crc == 0) {
        return -1;
    }

    for (int index = 0; index < DECK_MAX_SLOTS; index++) {
        if (s_header.slots[index].size > 0 &&
            s_header.slots[index].crc == crc) {
            return index;
        }
    }

    return -1;
}

bool deck_storage_slot_find(uint32_t crc, uint32_t *size_out)
{
    const int slot = find_slot(crc);

    if (slot < 0) {
        return false;
    }

    if (size_out != NULL) {
        *size_out = s_header.slots[slot].size;
    }

    return true;
}

esp_err_t deck_storage_slot_read(uint32_t crc, uint8_t *out, uint32_t size)
{
    const int slot = find_slot(crc);

    if (slot < 0 || s_header.slots[slot].size != size) {
        return ESP_ERR_NOT_FOUND;
    }

    esp_err_t error = esp_partition_read(
        s_partition,
        DECK_POOL_OFFSET + (uint32_t)slot * DECK_SLOT_BYTES,
        out,
        size
    );

    if (error != ESP_OK) {
        return error;
    }

    if (esp_rom_crc32_le(0, out, size) != crc) {
        return ESP_ERR_INVALID_CRC;
    }

    return ESP_OK;
}

esp_err_t deck_storage_slot_write(
    uint32_t crc,
    const uint8_t *data,
    uint32_t size
)
{
    if (s_partition == NULL || crc == 0 || size == 0 ||
        size > DECK_SLOT_BYTES) {
        return ESP_ERR_INVALID_ARG;
    }

    if (find_slot(crc) >= 0) {
        return ESP_OK; /* Identical artwork is stored once. */
    }

    int slot = -1;

    for (int index = 0; index < DECK_MAX_SLOTS; index++) {
        if (s_header.slots[index].size == 0) {
            slot = index;
            break;
        }
    }

    if (slot < 0) {
        return ESP_ERR_NO_MEM;
    }

    const uint32_t offset = DECK_POOL_OFFSET + (uint32_t)slot * DECK_SLOT_BYTES;
    const uint32_t erase_bytes = (size + DECK_SECTOR - 1) & ~(DECK_SECTOR - 1);
    esp_err_t error = esp_partition_erase_range(s_partition, offset, erase_bytes);

    if (error == ESP_OK) {
        error = esp_partition_write(s_partition, offset, data, size);
    }

    if (error != ESP_OK) {
        ESP_LOGW(TAG, "Slot write failed: %s", esp_err_to_name(error));
        return error;
    }

    s_header.slots[slot].crc = crc;
    s_header.slots[slot].size = size;
    return write_header();
}

void deck_storage_gc(const uint32_t *live_crcs, size_t live_count)
{
    bool changed = false;

    for (int index = 0; index < DECK_MAX_SLOTS; index++) {
        if (s_header.slots[index].size == 0) {
            continue;
        }

        bool live = false;

        for (size_t entry = 0; entry < live_count; entry++) {
            if (live_crcs[entry] == s_header.slots[index].crc) {
                live = true;
                break;
            }
        }

        if (!live) {
            /* ponytail: the pool is append-only between GCs; a linear scan
               over 190 slots is plenty at this scale. */
            s_header.slots[index].crc = 0;
            s_header.slots[index].size = 0;
            changed = true;
        }
    }

    if (changed) {
        write_header();
    }
}
