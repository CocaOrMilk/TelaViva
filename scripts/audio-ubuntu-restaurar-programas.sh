#!/usr/bin/env bash
set -euo pipefail
if ! command -v pactl >/dev/null || ! command -v python3 >/dev/null; then
  echo 'Instale: sudo apt install pulseaudio-utils python3' >&2
  exit 1
fi
python3 - <<'PY'
import json
import subprocess
import sys

def pactl(*args):
    return subprocess.run(['pactl', *args], text=True, check=True, capture_output=True).stdout

try:
    sinks_raw = json.loads(pactl('-f', 'json', 'list', 'sinks'))
    inputs_raw = json.loads(pactl('-f', 'json', 'list', 'sink-inputs'))
    sinks = list(sinks_raw.values()) if isinstance(sinks_raw, dict) else sinks_raw
    inputs = list(inputs_raw.values()) if isinstance(inputs_raw, dict) else inputs_raw
    virtual = next((s for s in sinks if s.get('name') == 'tela_viva_audio'), None)
    if virtual is None:
        sys.exit('TelaVivaAudio não está ativa.')
    default = pactl('get-default-sink').strip()
    if not default or default == 'tela_viva_audio':
        sys.exit('Selecione fones/alto-falantes reais como saída padrão antes de restaurar.')
    indices = [i['index'] for i in inputs if str(i.get('sink')) == str(virtual['index'])]
    for index in indices:
        subprocess.run(['pactl', 'move-sink-input', str(index), default], check=True)
    print(f'{len(indices)} fluxo(s) de áudio restaurado(s) para {default}.')
except (subprocess.CalledProcessError, json.JSONDecodeError) as exc:
    sys.exit(f'Não foi possível restaurar: {exc}')
PY
