idf_component_register(
    SRCS "main.c" "deck_storage.c" "deck_ui.c"
    INCLUDE_DIRS "."
    REQUIRES
        esp_app_format
        esp_driver_usb_serial_jtag
        esp_hw_support
        esp_partition
        json
        mbedtls
        waveshare_bsp
)
