idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    REQUIRES
        esp_app_format
        esp_driver_usb_serial_jtag
        esp_hw_support
        json
        waveshare_bsp
)
