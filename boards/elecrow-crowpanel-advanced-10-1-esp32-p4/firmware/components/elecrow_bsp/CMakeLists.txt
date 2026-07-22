idf_component_register(
    SRCS "elecrow_bsp.c"
    INCLUDE_DIRS "include" "include/bsp"
    REQUIRES lvgl
    PRIV_REQUIRES esp_driver_gpio esp_driver_i2c esp_driver_ledc esp_hw_support esp_lcd esp_lcd_ek79007 esp_lcd_touch_gt911 esp_lvgl_port
)
