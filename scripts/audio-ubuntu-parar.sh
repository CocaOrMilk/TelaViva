#!/usr/bin/env bash
set -euo pipefail
STATE_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/tela-viva/audio-modules.txt"
if [ ! -f "$STATE_FILE" ]; then
  echo 'Não há módulos TelaViva registrados para encerrar.'
  exit 0
fi
# Primeiro encerra loopback e source, por último a saída virtual.
mapfile -t ids < "$STATE_FILE"
for ((i=${#ids[@]}-1; i>=0; i--)); do
  pactl unload-module "${ids[i]}" >/dev/null 2>&1 || true
done
rm "$STATE_FILE"
echo 'Roteamento de áudio TelaViva encerrado.'
