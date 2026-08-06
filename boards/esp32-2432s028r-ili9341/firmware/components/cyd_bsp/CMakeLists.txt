idf_component_register(
    SRCS "cyd_bsp.c"
    INCLUDE_DIRS "include" "include/bsp"
    REQUIRES lvgl
    PRIV_REQUIRES esp_driver_gpio esp_driver_ledc esp_driver_spi esp_lcd esp_lcd_ili9341 esp_lcd_touch esp_lcd_touch_xpt2046 esp_lvgl_port
)
