#!/usr/bin/env bash
set -euo pipefail

# Para Ubuntu com PipeWire-Pulse/PulseAudio. Esta rotina cria uma saída
# independente e uma fonte virtual que o navegador pode capturar.
# Não envia dados pela internet e não altera o destino do Discord.

if ! command -v pactl >/dev/null; then
  echo 'Instale pactl: sudo apt install pulseaudio-utils pavucontrol' >&2
  exit 1
fi

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/tela-viva"
STATE_FILE="$STATE_DIR/audio-modules.txt"
mkdir -p "$STATE_DIR"

if [ -f "$STATE_FILE" ]; then
  echo "Parece já haver uma rota ativa. Execute scripts/audio-ubuntu-parar.sh antes de criar outra."
  exit 1
fi

DEFAULT_SINK="$(pactl get-default-sink)"
if [ "$DEFAULT_SINK" = 'tela_viva_audio' ] || [ -z "$DEFAULT_SINK" ]; then
  echo 'Selecione um alto-falante/fone real como saída padrão antes de continuar.' >&2
  exit 1
fi

module_ids=()
cleanup_on_error() {
  for module in "${module_ids[@]}"; do pactl unload-module "$module" >/dev/null 2>&1 || true; done
}
trap cleanup_on_error ERR

# Sink virtual é o ÚNICO destino dos programas que serão transmitidos.
SINK_ID="$(pactl load-module module-null-sink sink_name=tela_viva_audio sink_properties=device.description=TelaVivaAudio)"
module_ids+=("$SINK_ID")

# Remapeia o monitor do sink como entrada identificável no navegador.
SOURCE_ID="$(pactl load-module module-remap-source master=tela_viva_audio.monitor source_name=tela_viva_fonte source_properties=device.description=TelaVivaFonte)"
module_ids+=("$SOURCE_ID")

# Permite que você ouça localmente os sons dos programas roteados.
LOOPBACK_ID="$(pactl load-module module-loopback source=tela_viva_audio.monitor sink="$DEFAULT_SINK" latency_msec=100)"
module_ids+=("$LOOPBACK_ID")

printf '%s\n' "${module_ids[@]}" > "$STATE_FILE"
trap - ERR
printf '\nAudio isolado criado com sucesso!\n'
printf 'Saída para programas compartilhados: TelaVivaAudio\n'
printf 'Fonte a escolher no site: TelaVivaFonte\n'
printf 'Saída onde o Discord DEVE permanecer: %s\n\n' "$DEFAULT_SINK"
printf 'Abra o pavucontrol > Reprodução, toque som nos programas desejados\n'
printf 'e mude APENAS ESSES PROGRAMAS para TelaVivaAudio.\n'
printf 'Deixe Discord na saída real/padrão.\n\n'
printf 'Para encerrar, rode scripts/audio-ubuntu-parar.sh\n'
