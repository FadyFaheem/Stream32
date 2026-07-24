cmake_minimum_required(VERSION 3.16)

# Board-independent deck protocol/UI/storage shared by every firmware.
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../../common/components")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

set(PROJECT_VER "0.1.8")
project(stream32_elecrow_crowpanel_advanced_10_1_esp32_p4)
