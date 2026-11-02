#!/usr/bin/env bash
# Compila o helper de áudio do Windows a partir do Linux (mingw-w64: sudo apt install g++-mingw-w64-x86-64-posix)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../../build/win
x86_64-w64-mingw32-g++-posix -O2 -std=c++17 -Wall -Wno-unknown-pragmas -static -static-libgcc -static-libstdc++ \
  -o ../../build/win/tv-audio-win.exe tv-audio-win.cpp -lole32 -loleaut32 -luuid -lmmdevapi -lwinmm -lpropsys
ls -la ../../build/win/tv-audio-win.exe
