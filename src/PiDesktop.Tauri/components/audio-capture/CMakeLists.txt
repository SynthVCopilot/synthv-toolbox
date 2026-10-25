cmake_minimum_required(VERSION 3.20)

# Electron 45 still launches on macOS 12; the tap code is gated behind @available(macOS 14.2).
set(CMAKE_OSX_DEPLOYMENT_TARGET "12.0" CACHE STRING "")
# Static CRT so the shipped executable does not need the Visual C++ redistributable.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")

project(audio_capture LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(WIN32)
  if(NOT MSVC)
    message(FATAL_ERROR "The Windows capture executable needs MSVC for the WRL and WASAPI headers.")
  endif()
  add_executable(audio-capture src/windows_process_loopback.cpp)
  target_compile_definitions(audio-capture PRIVATE UNICODE _UNICODE)
  target_compile_options(audio-capture PRIVATE /W4 /permissive-)
  target_link_libraries(audio-capture PRIVATE mmdevapi runtimeobject ole32)
elseif(APPLE)
  enable_language(OBJCXX)
  add_executable(audio-capture src/macos_process_tap.mm)
  target_compile_options(audio-capture PRIVATE -fobjc-arc -Wall -Wextra)
  target_link_libraries(audio-capture PRIVATE "-framework CoreAudio" "-framework AudioToolbox" "-framework Foundation")
else()
  message(FATAL_ERROR "Process audio capture is implemented for Windows and macOS only.")
endif()

set_target_properties(audio-capture PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_CURRENT_SOURCE_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_SOURCE_DIR}/bin")
