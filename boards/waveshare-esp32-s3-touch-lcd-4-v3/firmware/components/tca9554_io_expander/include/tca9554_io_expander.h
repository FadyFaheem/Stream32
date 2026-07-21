/*
 * TCA9554 IO Expander Driver (using new I2C master API)
 * Compatible with TI PW554 chip found on some Waveshare boards
 */

#pragma once

#include <stdint.h>
#include "esp_err.h"
#include "driver/i2c_master.h"
#include "esp_io_expander.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Create a TCA9554 IO expander object
 *
 * @param[in]  i2c_bus    I2C bus handle. Obtained from `i2c_new_master_bus()`
 * @param[in]  dev_addr   I2C device address of chip (0x20-0x27 for TCA9554)
 * @param[out] handle_ret Handle to created IO expander object
 *
 * @return
 *      - ESP_OK: Success, otherwise returns ESP_ERR_xxx
 */
esp_err_t tca9554_io_expander_new(i2c_master_bus_handle_t i2c_bus, uint32_t dev_addr, esp_io_expander_handle_t *handle_ret);

/**
 * @brief I2C addresses for TCA9554 (depends on A0, A1, A2 pins)
 */
#define TCA9554_I2C_ADDRESS_000    (0x20)
#define TCA9554_I2C_ADDRESS_001    (0x21)
#define TCA9554_I2C_ADDRESS_010    (0x22)
#define TCA9554_I2C_ADDRESS_011    (0x23)
#define TCA9554_I2C_ADDRESS_100    (0x24)
#define TCA9554_I2C_ADDRESS_101    (0x25)
#define TCA9554_I2C_ADDRESS_110    (0x26)
#define TCA9554_I2C_ADDRESS_111    (0x27)

#ifdef __cplusplus
}
#endif
