idf_component_register(
    SRCS "deck_storage.c" "deck_ui.c"
    INCLUDE_DIRS "."
    REQUIRES esp_partition json lvgl
    PRIV_REQUIRES mbedtls
)
