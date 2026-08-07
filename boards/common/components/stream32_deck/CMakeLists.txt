idf_component_register(
    SRCS "deck_affine.c" "deck_artwork.c" "deck_calibrate.c" "deck_clean.c"
         "deck_protocol.c" "deck_settings.c" "deck_storage.c" "deck_ui.c"
    INCLUDE_DIRS "."
    REQUIRES esp_partition esp_timer lvgl nvs_flash
    PRIV_REQUIRES json mbedtls
)
