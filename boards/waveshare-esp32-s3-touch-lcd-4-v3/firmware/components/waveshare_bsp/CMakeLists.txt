idf_component_register(
    SRCS "waveshare_bsp.c"
    INCLUDE_DIRS "include" "include/bsp"
    PRIV_INCLUDE_DIRS "priv_include"
    REQUIRES esp_driver_i2c esp_driver_gpio esp_lcd tca9554_io_expander esp_io_expander esp_lvgl_port lvgl
    PRIV_REQUIRES esp_timer spiffs esp_psram fatfs esp_lcd_touch esp_lcd_touch_gt911
)
