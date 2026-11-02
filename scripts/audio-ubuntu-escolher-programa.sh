#!/usr/bin/env bash
set -euo pipefail

# Redireciona o som de um aplicativo escolhido para TelaVivaAudio. Não
# captura a tela nem concede permissões ao site; só modifica o roteamento
# de áudio do usuário local via PipeWire-Pulse/PulseAudio.
if ! command -v pactl >/dev/null || ! command -v python3 >/dev/null; then
  echo 'Instale: sudo apt install pulseaudio-utils python3 pavucontrol' >&2
  exit 1
fi
if ! pactl list short sinks | awk '{print $2}' | grep -Fxq 'tela_viva_audio'; then
  echo 'A saída TelaVivaAudio ainda não existe.' >&2
  echo 'Execute primeiro: bash scripts/audio-ubuntu-iniciar.sh' >&2
  exit 1
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python3 "$SCRIPT_DIR/audio-ubuntu-escolher-programa.py"
