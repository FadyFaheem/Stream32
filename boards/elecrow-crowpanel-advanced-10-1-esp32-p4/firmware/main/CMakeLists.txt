idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    REQUIRES
        elecrow_bsp
        esp_app_format
        esp_driver_uart
        esp_hw_support
        json
        stream32_deck
)
