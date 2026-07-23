idf_component_register(
    SRCS "deck_protocol.c" "deck_storage.c" "deck_ui.c"
    INCLUDE_DIRS "."
    REQUIRES esp_partition esp_timer lvgl
    PRIV_REQUIRES json mbedtls
)
