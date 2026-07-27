idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    REQUIRES
        elecrow_bsp
        esp_app_format
        esp_driver_uart
        esp_hw_support
        esp_tinyusb
        json
        stream32_deck
)
