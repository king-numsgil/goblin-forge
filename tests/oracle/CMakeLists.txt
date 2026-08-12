# The C++ oracle.
#
# REWRITE-PLAN §9.1: if the semantics are meant to be C++'s, then C++ is the
# oracle. Each case is written twice — once in Goblin, once in C++ — with both
# programs printing a trace of every construction, copy, move and destruction,
# and the two traces are required to be identical.
#
# That is worth more than any number of hand-written expectations, because the
# question "what *should* this print?" stops being a judgement call.
#
# CMake finds the compiler, so nothing here probes Visual Studio's registry or
# assumes a Developer Command Prompt. `cases/` is globbed rather than listed:
# a case that is added and not built is a case that silently stops being an
# oracle.

cmake_minimum_required(VERSION 3.20)
project(goblin_oracle CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# The traces compare object lifetimes, and a copy the optimiser elides is a
# trace line that does not appear. C++17 makes *some* elision mandatory, which
# is a real difference from Goblin and is recorded as such where it shows up —
# but nothing beyond that should be silently removed.
set(CMAKE_CXX_EXTENSIONS OFF)

file(GLOB ORACLE_CASES CONFIGURE_DEPENDS
  "${CMAKE_CURRENT_SOURCE_DIR}/cases/*.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/layout/*.cpp")

# The struct-ABI library, linked into compiled Goblin programs. A *real*
# `extern "C"` library rather than a mock: the whole point is that a C compiler
# decides the register assignment and this compiler has to agree with it.
add_library(gfcabi STATIC "${CMAKE_CURRENT_SOURCE_DIR}/cabi/cabi.cpp")
set_target_properties(gfcabi PROPERTIES
  ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib"
  ARCHIVE_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/lib"
  ARCHIVE_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/lib"
  POSITION_INDEPENDENT_CODE ON)

foreach(case_path IN LISTS ORACLE_CASES)
  get_filename_component(case_name "${case_path}" NAME_WE)
  add_executable("${case_name}" "${case_path}")
  target_include_directories("${case_name}" PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/include")
  set_target_properties("${case_name}" PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/bin")
endforeach()
