#!/usr/bin/env python3
import json
import subprocess
import sys

def pactl(*args):
    return subprocess.run(['pactl', *args], text=True, capture_output=True, check=True).stdout

try:
    data = json.loads(pactl('-f', 'json', 'list', 'sink-inputs'))
except (subprocess.CalledProcessError, json.JSONDecodeError) as exc:
    print(f'Não foi possível listar os programas com áudio: {exc}', file=sys.stderr)
    sys.exit(1)

streams = list(data.values()) if isinstance(data, dict) else data
apps = {}
for item in streams:
    props = item.get('properties') or {}
    name = (props.get('application.name') or props.get('media.name') or 'Sem nome').strip()
    binary = (props.get('application.process.binary') or '').strip()
    key = (name, binary)
    apps.setdefault(key, []).append(item.get('index'))

if not apps:
    print('Nenhum aplicativo está reproduzindo áudio agora.')
    print('Inicie algum áudio no jogo ou em uma aba do navegador e tente novamente.')
    sys.exit(0)

items = sorted(apps.items(), key=lambda kv: (kv[0][0].lower(), kv[0][1].lower()))
print('\nSelecione o aplicativo que deve ter seu som transmitido:')
for idx, ((name, binary), input_ids) in enumerate(items, 1):
    blocked = ' [NÃO RECOMENDADO: Discord]' if 'discord' in (name + binary).lower() else ''
    print(f'{idx:>2}. {name} {f"({binary})" if binary else ""} — {len(input_ids)} fluxo(s){blocked}')
print(' 0. Cancelar\n')
try:
    pick = int(input('Número: ').strip())
except (ValueError, EOFError):
    sys.exit('Seleção cancelada.')
if pick == 0:
    sys.exit(0)
if not 1 <= pick <= len(items):
    sys.exit('Opção inválida.')
(name, binary), ids = items[pick - 1]
if 'discord' in (name + binary).lower():
    sys.exit('Por segurança, o assistente não envia o Discord à transmissão.')

moved = 0
for index in ids:
    try:
        subprocess.run(['pactl', 'move-sink-input', str(index), 'tela_viva_audio'], check=True)
        moved += 1
    except subprocess.CalledProcessError:
        print(f'Aviso: o fluxo {index} terminou ou não pôde ser movido.')
print(f'\nConcluído: {moved} fluxo(s) de {name} redirecionado(s) para TelaVivaAudio.')
print('Abra o TelaViva e selecione a entrada TelaVivaFonte.')
print('Se o programa criar um novo fluxo de áudio, execute este assistente novamente.')
print('Cuidado: outras abas do mesmo navegador podem usar a mesma saída.')
