idf_component_register(
    SRCS "tca9554_io_expander.c"
    INCLUDE_DIRS "include"
    REQUIRES driver
    PRIV_REQUIRES esp_io_expander
)
