#!/usr/bin/env bash
# Inicia o TelaViva a partir desta pasta (sem instalar nada, sem FUSE).
# --no-sandbox: o sandbox SUID do Chromium exige root; o app só carrega o seu próprio servidor.
cd "$(dirname "$(readlink -f "$0")")" || exit 1
exec ./telaviva-desktop --no-sandbox "$@"
