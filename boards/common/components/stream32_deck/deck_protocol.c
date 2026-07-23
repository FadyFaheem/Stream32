#include "deck_protocol.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "deck_storage.h"
#include "deck_ui.h"
#include "esp_heap_caps.h"
#include "esp_rom_crc.h"
#include "mbedtls/base64.h"
#include "sdkconfig.h"

#define DECK_MAX_ROWS CONFIG_STREAM32_DECK_MAX_ROWS
#define DECK_MAX_COLS CONFIG_STREAM32_DECK_MAX_COLS
#define DECK_MAX_IDLE_SECONDS 86400
#define DECK_MAX_BRIGHTNESS_PERCENT 100
#define DECK_MAX_IMAGE_CHUNKS 256
#define DECK_MAX_ENCODED_CHUNK_BYTES 2688

typedef struct {
    bool active;
    uint8_t page;
    uint8_t index;
    bool ephemeral;
    bool rle;
    uint16_t key_px;
    uint32_t expected_crc;
    uint32_t expected_seq;
    uint32_t received;
    uint32_t total_seq;
    uint32_t total_size;
} image_sequence_t;

typedef struct {
    char *data;
    size_t capacity;
    size_t length;
} reply_builder_t;

static uint8_t *s_staging;
static uint8_t s_encoded_chunk[DECK_MAX_ENCODED_CHUNK_BYTES];
static image_sequence_t s_image_sequence;

static bool parse_integer(
    const cJSON *value,
    int minimum,
    int maximum,
    int *out
)
{
    if (!cJSON_IsNumber(value) ||
        value->valuedouble != (double)value->valueint ||
        value->valueint < minimum || value->valueint > maximum) {
        return false;
    }

    *out = value->valueint;
    return true;
}

static bool valid_utf8(const char *text)
{
    if (text == NULL) {
        return false;
    }

    const unsigned char *cursor = (const unsigned char *)text;

    while (*cursor != '\0') {
        if (*cursor <= 0x7f) {
            cursor++;
            continue;
        }

        uint32_t codepoint;
        int continuation_count;

        if (*cursor >= 0xc2 && *cursor <= 0xdf) {
            codepoint = *cursor & 0x1f;
            continuation_count = 1;
        } else if (*cursor >= 0xe0 && *cursor <= 0xef) {
            codepoint = *cursor & 0x0f;
            continuation_count = 2;
        } else if (*cursor >= 0xf0 && *cursor <= 0xf4) {
            codepoint = *cursor & 0x07;
            continuation_count = 3;
        } else {
            return false;
        }

        cursor++;

        for (int index = 0; index < continuation_count; index++, cursor++) {
            if ((*cursor & 0xc0) != 0x80) {
                return false;
            }

            codepoint = (codepoint << 6) | (*cursor & 0x3f);
        }

        if ((continuation_count == 2 &&
             (codepoint < 0x800 ||
              (codepoint >= 0xd800 && codepoint <= 0xdfff))) ||
            (continuation_count == 3 &&
             (codepoint < 0x10000 || codepoint > 0x10ffff))) {
            return false;
        }
    }

    return true;
}

static bool parse_label(const cJSON *value, char *out)
{
    if (!cJSON_IsString(value) || value->valuestring == NULL ||
        !valid_utf8(value->valuestring)) {
        return false;
    }

    const size_t length = strlen(value->valuestring);

    if (length >= DECK_PROTOCOL_LABEL_CAPACITY) {
        return false;
    }

    memcpy(out, value->valuestring, length + 1);
    return true;
}

static int hex_digit(unsigned char byte)
{
    if (byte >= '0' && byte <= '9') {
        return byte - '0';
    }

    if (byte >= 'a' && byte <= 'f') {
        return byte - 'a' + 10;
    }

    if (byte >= 'A' && byte <= 'F') {
        return byte - 'A' + 10;
    }

    return -1;
}

static bool parse_hex(
    const char *text,
    size_t offset,
    size_t digits,
    uint32_t *out
)
{
    if (text == NULL || strlen(text) != offset + digits) {
        return false;
    }

    uint32_t value = 0;

    for (size_t index = offset; index < offset + digits; index++) {
        const int digit = hex_digit((unsigned char)text[index]);

        if (digit < 0) {
            return false;
        }

        value = (value << 4) | (uint32_t)digit;
    }

    *out = value;
    return true;
}

static bool parse_color(const cJSON *value, uint32_t *out)
{
    return cJSON_IsString(value) && value->valuestring != NULL &&
        value->valuestring[0] == '#' &&
        parse_hex(value->valuestring, 1, 6, out);
}

static bool parse_crc(const cJSON *value, uint32_t *out)
{
    return cJSON_IsString(value) && value->valuestring != NULL &&
        parse_hex(value->valuestring, 0, 8, out);
}

static const char *decode_layout(
    const cJSON *message,
    deck_protocol_layout_t *out
)
{
    const cJSON *page = cJSON_GetObjectItemCaseSensitive(message, "page");
    const cJSON *of = cJSON_GetObjectItemCaseSensitive(message, "of");
    const cJSON *rows = cJSON_GetObjectItemCaseSensitive(message, "rows");
    const cJSON *cols = cJSON_GetObjectItemCaseSensitive(message, "cols");
    const cJSON *keys = cJSON_GetObjectItemCaseSensitive(message, "keys");
    int page_index;
    int page_count;
    int row_count;
    int column_count;

    if (!parse_integer(page, 0, DECK_MAX_PAGES - 1, &page_index) ||
        !parse_integer(of, 1, DECK_MAX_PAGES, &page_count) ||
        !parse_integer(rows, 1, DECK_MAX_ROWS, &row_count) ||
        !parse_integer(cols, 1, DECK_MAX_COLS, &column_count) ||
        page_index >= page_count || !cJSON_IsArray(keys) ||
        row_count * column_count > DECK_MAX_KEYS) {
        return "layout-invalid";
    }

    memset(out, 0, sizeof(*out));
    out->page = (uint8_t)page_index;
    out->page_count = (uint8_t)page_count;
    out->rows = (uint8_t)row_count;
    out->cols = (uint8_t)column_count;

    for (int index = 0; index < DECK_MAX_KEYS; index++) {
        out->keys[index].go_page = -1;
    }

    const int key_count = row_count * column_count;
    const cJSON *entry = NULL;

    cJSON_ArrayForEach(entry, keys) {
        const cJSON *index_value =
            cJSON_GetObjectItemCaseSensitive(entry, "index");
        int key_index;

        if (!cJSON_IsObject(entry) ||
            !parse_integer(index_value, 0, key_count - 1, &key_index) ||
            out->keys[key_index].used) {
            return "layout-invalid";
        }

        deck_protocol_key_t *key = &out->keys[key_index];
        const cJSON *label =
            cJSON_GetObjectItemCaseSensitive(entry, "label");
        const cJSON *color =
            cJSON_GetObjectItemCaseSensitive(entry, "color");
        const cJSON *label_color =
            cJSON_GetObjectItemCaseSensitive(entry, "labelColor");
        const cJSON *image_crc =
            cJSON_GetObjectItemCaseSensitive(entry, "imageCrc");
        const cJSON *go_page =
            cJSON_GetObjectItemCaseSensitive(entry, "goPage");

        key->used = true;

        if (label != NULL && !parse_label(label, key->label)) {
            return "layout-invalid";
        }

        if (color != NULL) {
            if (!parse_color(color, &key->color)) {
                return "layout-invalid";
            }

            key->has_color = true;
        }

        if (label_color != NULL) {
            if (!parse_color(label_color, &key->label_color)) {
                return "layout-invalid";
            }

            key->has_label_color = true;
        }

        if (image_crc != NULL && !parse_crc(image_crc, &key->image_crc)) {
            return "layout-invalid";
        }

        if (go_page != NULL) {
            int target_page;

            if (!parse_integer(go_page, 0, page_count - 1, &target_page)) {
                return "layout-invalid";
            }

            key->go_page = (int8_t)target_page;
        }
    }

    return NULL;
}

static bool append_reply(reply_builder_t *reply, const char *format, ...)
{
    if (reply->length >= reply->capacity) {
        return false;
    }

    va_list arguments;
    va_start(arguments, format);
    const int written = vsnprintf(
        reply->data + reply->length,
        reply->capacity - reply->length,
        format,
        arguments
    );
    va_end(arguments);

    if (written < 0 || (size_t)written >= reply->capacity - reply->length) {
        return false;
    }

    reply->length += (size_t)written;
    return true;
}

static void reset_image_sequence(void)
{
    if (s_staging != NULL) {
        heap_caps_free(s_staging);
        s_staging = NULL;
    }

    memset(&s_image_sequence, 0, sizeof(s_image_sequence));
}

static const char *abort_image(const char *error)
{
    reset_image_sequence();
    return error;
}

static bool valid_base64(const char *text)
{
    if (text == NULL) {
        return false;
    }

    const size_t length = strlen(text);

    if (length % 4 != 0) {
        return false;
    }

    size_t padding = 0;

    for (size_t index = 0; index < length; index++) {
        const unsigned char byte = (unsigned char)text[index];
        const bool alphabet =
            (byte >= 'A' && byte <= 'Z') ||
            (byte >= 'a' && byte <= 'z') ||
            (byte >= '0' && byte <= '9') || byte == '+' || byte == '/';

        if (alphabet && padding == 0) {
            continue;
        }

        if (byte == '=' && index >= length - 2 && padding < 2) {
            padding++;
            continue;
        }

        return false;
    }

    return true;
}

const char *deck_protocol_restore_layout(
    const char *json,
    size_t length,
    uint8_t expected_page
)
{
    cJSON *message = cJSON_ParseWithLength(json, length);

    if (message == NULL) {
        return "layout-invalid";
    }

    deck_protocol_layout_t layout;
    const char *error = decode_layout(message, &layout);

    if (error == NULL && layout.page != expected_page) {
        error = "layout-invalid";
    }

    if (error == NULL) {
        deck_ui_restore_layout(&layout);
    }

    cJSON_Delete(message);
    return error;
}

static const char *handle_layout(
    const cJSON *message,
    const char *raw_line,
    size_t raw_length,
    char *reply,
    size_t reply_capacity
)
{
    deck_protocol_layout_t layout;
    const char *error = decode_layout(message, &layout);

    if (error != NULL) {
        return error;
    }

    if (layout.page == 0) {
        reset_image_sequence();
    }

    error = deck_ui_apply_layout(&layout, raw_line, raw_length);

    if (error != NULL) {
        return error;
    }

    const int key_px = deck_ui_key_px(layout.rows, layout.cols);
    const uint32_t expected_size = (uint32_t)key_px * key_px * 2;
    reply_builder_t builder = {
        .data = reply,
        .capacity = reply_capacity,
    };

    if (!append_reply(
            &builder,
            "{\"type\":\"layout-ack\",\"page\":%d,\"rows\":%d,\"cols\":%d,"
            "\"keyPx\":%d,\"needImages\":[",
            layout.page,
            layout.rows,
            layout.cols,
            key_px
        )) {
        return "reply-too-small";
    }

    bool first = true;

    for (int index = 0; index < layout.rows * layout.cols; index++) {
        const deck_protocol_key_t *key = &layout.keys[index];

        if (!key->used || key->image_crc == 0 ||
            !deck_ui_image_needed(key->image_crc, expected_size)) {
            continue;
        }

        if (!append_reply(
                &builder,
                "%s%d",
                first ? "" : ",",
                index
            )) {
            return "reply-too-small";
        }

        first = false;
    }

    return append_reply(&builder, "]}") ? NULL : "reply-too-small";
}

static const char *handle_key_update(
    const cJSON *message,
    char *reply,
    size_t reply_capacity
)
{
    const cJSON *page = cJSON_GetObjectItemCaseSensitive(message, "page");
    const cJSON *index = cJSON_GetObjectItemCaseSensitive(message, "index");
    const cJSON *clear = cJSON_GetObjectItemCaseSensitive(message, "clear");
    int page_index;
    int key_index;

    if (!parse_integer(page, 0, DECK_MAX_PAGES - 1, &page_index) ||
        !parse_integer(index, 0, DECK_MAX_KEYS - 1, &key_index) ||
        (clear != NULL && !cJSON_IsTrue(clear))) {
        return "key-update-invalid";
    }

    deck_protocol_key_update_t update = {
        .page = (uint8_t)page_index,
        .index = (uint8_t)key_index,
        .clear = clear != NULL,
    };

    if (!update.clear) {
        const cJSON *label =
            cJSON_GetObjectItemCaseSensitive(message, "label");
        const cJSON *color =
            cJSON_GetObjectItemCaseSensitive(message, "color");
        const cJSON *label_color =
            cJSON_GetObjectItemCaseSensitive(message, "labelColor");
        const cJSON *state =
            cJSON_GetObjectItemCaseSensitive(message, "state");
        const cJSON *image_crc =
            cJSON_GetObjectItemCaseSensitive(message, "imageCrc");

        if (label == NULL && color == NULL && label_color == NULL &&
            state == NULL && image_crc == NULL) {
            return "key-update-invalid";
        }

        if (label != NULL) {
            if (!parse_label(label, update.label)) {
                return "key-update-invalid";
            }

        }

        if (color != NULL) {
            if (!parse_color(color, &update.color)) {
                return "key-update-invalid";
            }

            update.has_color = true;
        }

        if (label_color != NULL) {
            if (!parse_color(label_color, &update.label_color)) {
                return "key-update-invalid";
            }

            update.has_label_color = true;
        }

        if (state != NULL) {
            if (!cJSON_IsString(state) || state->valuestring == NULL) {
                return "key-update-invalid";
            }

            if (strcmp(state->valuestring, "on") == 0) {
                update.state = 1;
            } else if (strcmp(state->valuestring, "off") == 0) {
                update.state = 2;
            } else if (strcmp(state->valuestring, "unknown") == 0) {
                update.state = 3;
            } else {
                return "key-update-invalid";
            }

        }

        if (image_crc != NULL) {
            if (!parse_crc(image_crc, &update.image_crc) ||
                update.image_crc == 0) {
                return "key-update-invalid";
            }

        }
    }

    bool need_image;
    const char *error = deck_ui_apply_key_update(&update, &need_image);

    if (error != NULL) {
        return error;
    }

    const int written = snprintf(
        reply,
        reply_capacity,
        "{\"type\":\"key-update-ack\",\"page\":%d,\"index\":%d,"
        "\"needImage\":%s}",
        update.page,
        update.index,
        need_image ? "true" : "false"
    );

    return written >= 0 && (size_t)written < reply_capacity
        ? NULL
        : "reply-too-small";
}

static const char *handle_image(
    const cJSON *message,
    char *reply,
    size_t reply_capacity
)
{
    const cJSON *page = cJSON_GetObjectItemCaseSensitive(message, "page");
    const cJSON *index = cJSON_GetObjectItemCaseSensitive(message, "index");
    const cJSON *seq = cJSON_GetObjectItemCaseSensitive(message, "seq");
    const cJSON *of = cJSON_GetObjectItemCaseSensitive(message, "of");
    const cJSON *width = cJSON_GetObjectItemCaseSensitive(message, "w");
    const cJSON *height = cJSON_GetObjectItemCaseSensitive(message, "h");
    const cJSON *data = cJSON_GetObjectItemCaseSensitive(message, "data");
    const cJSON *mode = cJSON_GetObjectItemCaseSensitive(message, "mode");
    const cJSON *encoding =
        cJSON_GetObjectItemCaseSensitive(message, "encoding");
    int page_index;
    int key_index;
    int sequence_index;
    int sequence_count;
    int image_width;
    int image_height;
    bool rle = false;

    if (!parse_integer(page, 0, DECK_MAX_PAGES - 1, &page_index) ||
        !parse_integer(index, 0, DECK_MAX_KEYS - 1, &key_index) ||
        !parse_integer(seq, 0, DECK_MAX_IMAGE_CHUNKS - 1, &sequence_index) ||
        !parse_integer(of, 1, DECK_MAX_IMAGE_CHUNKS, &sequence_count) ||
        sequence_index >= sequence_count ||
        !parse_integer(width, 1, UINT16_MAX, &image_width) ||
        !parse_integer(height, 1, UINT16_MAX, &image_height) ||
        !cJSON_IsString(data) || data->valuestring == NULL ||
        (mode != NULL &&
         (!cJSON_IsString(mode) || mode->valuestring == NULL ||
          strcmp(mode->valuestring, "ephemeral") != 0))) {
        return abort_image("image-invalid");
    }

    if (encoding != NULL) {
        if (!cJSON_IsString(encoding) || encoding->valuestring == NULL ||
            strcmp(encoding->valuestring, "rle565") != 0) {
            return abort_image("image-invalid");
        }

        rle = true;
    }

    if (!valid_base64(data->valuestring)) {
        return abort_image(rle ? "image-rle-invalid" : "image-invalid");
    }

    const bool ephemeral = mode != NULL;
    uint16_t key_px;
    uint32_t expected_crc;
    const char *error = deck_ui_get_image_target(
        (uint8_t)page_index,
        (uint8_t)key_index,
        ephemeral,
        &key_px,
        &expected_crc
    );
    if (error != NULL || image_width != key_px || image_height != key_px) {
        return abort_image("image-invalid");
    }

    const uint32_t total_size = (uint32_t)key_px * key_px * 2;

    if (total_size == 0 || total_size > DECK_SLOT_BYTES) {
        return abort_image("image-invalid");
    }

    if (sequence_index == 0) {
        reset_image_sequence();
        s_staging = heap_caps_malloc(total_size, MALLOC_CAP_SPIRAM);

        if (s_staging == NULL) {
            return "image-no-memory";
        }

        s_image_sequence = (image_sequence_t) {
            .active = true,
            .page = (uint8_t)page_index,
            .index = (uint8_t)key_index,
            .ephemeral = ephemeral,
            .rle = rle,
            .key_px = key_px,
            .expected_crc = expected_crc,
            .total_seq = (uint32_t)sequence_count,
            .total_size = total_size,
        };
    }

    if (s_staging == NULL || !s_image_sequence.active ||
        s_image_sequence.page != page_index ||
        s_image_sequence.index != key_index ||
        s_image_sequence.ephemeral != ephemeral ||
        s_image_sequence.rle != rle ||
        s_image_sequence.key_px != key_px ||
        s_image_sequence.expected_crc != expected_crc ||
        s_image_sequence.expected_seq != sequence_index ||
        s_image_sequence.total_seq != sequence_count ||
        s_image_sequence.total_size != total_size) {
        return abort_image("image-sequence");
    }

    size_t decoded = 0;
    const size_t data_length = strlen(data->valuestring);
    const size_t remaining =
        s_image_sequence.total_size - s_image_sequence.received;

    if (rle) {
        if (mbedtls_base64_decode(
                s_encoded_chunk,
                sizeof(s_encoded_chunk),
                &decoded,
                (const unsigned char *)data->valuestring,
                data_length
            ) != 0 ||
            decoded == 0 || decoded % 4 != 0) {
            return abort_image("image-rle-invalid");
        }

        for (size_t offset = 0; offset < decoded; offset += 4) {
            const uint32_t count =
                (uint32_t)s_encoded_chunk[offset] |
                ((uint32_t)s_encoded_chunk[offset + 1] << 8);

            if (count == 0 ||
                count > (s_image_sequence.total_size -
                         s_image_sequence.received) / 2) {
                return abort_image("image-rle-invalid");
            }

            for (uint32_t run = 0; run < count; run++) {
                s_staging[s_image_sequence.received++] =
                    s_encoded_chunk[offset + 2];
                s_staging[s_image_sequence.received++] =
                    s_encoded_chunk[offset + 3];
            }
        }
    } else {
        if (mbedtls_base64_decode(
                s_staging + s_image_sequence.received,
                remaining,
                &decoded,
                (const unsigned char *)data->valuestring,
                data_length
            ) != 0) {
            return abort_image("image-invalid");
        }

        s_image_sequence.received += (uint32_t)decoded;
    }

    s_image_sequence.expected_seq++;

    if (s_image_sequence.expected_seq == s_image_sequence.total_seq) {
        const uint32_t received = s_image_sequence.received;

        if (received != total_size) {
            return abort_image("image-size-mismatch");
        }

        if (esp_rom_crc32_le(0, s_staging, total_size) != expected_crc) {
            return abort_image("image-crc-mismatch");
        }

        error = deck_ui_commit_image(
            (uint8_t)page_index,
            (uint8_t)key_index,
            ephemeral,
            s_staging,
            total_size
        );
        reset_image_sequence();

        if (error != NULL) {
            return error;
        }
    }

    const int written = snprintf(
        reply,
        reply_capacity,
        "{\"type\":\"image-ack\",\"page\":%d,\"index\":%d,\"seq\":%d%s}",
        page_index,
        key_index,
        sequence_index,
        ephemeral ? ",\"mode\":\"ephemeral\"" : ""
    );

    return written >= 0 && (size_t)written < reply_capacity
        ? NULL
        : "reply-too-small";
}

static const char *handle_page(const cJSON *message)
{
    const cJSON *index = cJSON_GetObjectItemCaseSensitive(message, "index");
    int page;

    if (!parse_integer(index, 0, DECK_MAX_PAGES - 1, &page)) {
        return "page-invalid";
    }

    return deck_ui_select_page((uint8_t)page);
}

static const char *handle_display(const cJSON *message)
{
    const cJSON *awake = cJSON_GetObjectItemCaseSensitive(message, "awake");
    const cJSON *idle_seconds =
        cJSON_GetObjectItemCaseSensitive(message, "idleTimeoutSeconds");
    const cJSON *brightness =
        cJSON_GetObjectItemCaseSensitive(message, "brightness");
    int idle_timeout;
    int brightness_percent = 0;

    if (!cJSON_IsBool(awake) ||
        !parse_integer(
            idle_seconds,
            0,
            DECK_MAX_IDLE_SECONDS,
            &idle_timeout
        ) ||
        (brightness != NULL &&
         !parse_integer(
             brightness,
             0,
             DECK_MAX_BRIGHTNESS_PERCENT,
             &brightness_percent
         ))) {
        return "display-invalid";
    }

    const deck_protocol_display_t display = {
        .awake = cJSON_IsTrue(awake),
        .has_brightness = brightness != NULL,
        .idle_timeout_seconds = (uint32_t)idle_timeout,
        .brightness_percent = (uint8_t)brightness_percent,
    };

    return deck_ui_apply_display(&display);
}

bool deck_protocol_dispatch(
    const cJSON *message,
    const char *raw_line,
    size_t raw_length,
    char *reply,
    size_t reply_capacity,
    deck_protocol_send_fn send,
    const char **error_out
)
{
    const cJSON *type = cJSON_GetObjectItemCaseSensitive(message, "type");

    if (!cJSON_IsString(type) || type->valuestring == NULL) {
        return false;
    }

    bool has_reply = false;

    if (strcmp(type->valuestring, "layout") == 0) {
        *error_out = handle_layout(
            message,
            raw_line,
            raw_length,
            reply,
            reply_capacity
        );
        has_reply = true;
    } else if (strcmp(type->valuestring, "image") == 0) {
        *error_out = handle_image(message, reply, reply_capacity);
        has_reply = true;
    } else if (strcmp(type->valuestring, "key-update") == 0) {
        *error_out = handle_key_update(message, reply, reply_capacity);
        has_reply = true;
    } else if (strcmp(type->valuestring, "page") == 0) {
        *error_out = handle_page(message);
    } else if (strcmp(type->valuestring, "display") == 0) {
        *error_out = handle_display(message);
    } else {
        return false;
    }

    if (*error_out == NULL && has_reply) {
        send(reply);
    }

    return true;
}

bool deck_protocol_clear_overlays(void)
{
    if (!deck_ui_clear_overlays()) {
        return false;
    }

    reset_image_sequence();
    return true;
}
