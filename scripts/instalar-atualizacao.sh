#!/usr/bin/env bash
# Instala as units systemd --user que ligam o botão "Atualizar" ao scripts/atualizar.sh deste clone (produção):
#   scripts/instalar-atualizacao.sh [--sem-systemctl]
# Gera atm-atualizar.path/.service em $SYSTEMD_USER_DIR (padrão ~/.config/systemd/user) com os caminhos reais,
# faz daemon-reload, `enable --now` da .path e grava o marcador `configurada` no diretório run. Idempotente.
# Ambiente: ATM_ESTADO_DIR (run dir; padrão <clone>/run), SYSTEMD_USER_DIR, ATM_SYSTEMCTL (padrão systemctl).
set -euo pipefail
raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run="${ATM_ESTADO_DIR:-$raiz/run}"
dest="${SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
sctl="${ATM_SYSTEMCTL:-systemctl}"
usar_systemctl=1
[[ "${1:-}" == "--sem-systemctl" ]] && usar_systemctl=0

for p in "$raiz" "$run"; do
  if [[ "$p" =~ [[:space:]%\$\"\'\\] ]]; then
    echo "instalar-atualizacao: caminho não suportado em units systemd (espaço ou % \$ aspas \\): $p" >&2; exit 1
  fi
done
[[ -x "$raiz/scripts/atualizar.sh" ]] || { echo "instalar-atualizacao: $raiz/scripts/atualizar.sh não encontrado/executável" >&2; exit 1; }

mkdir -p "$dest" "$run"
for u in path service; do
  sed -e "s|@CLONE@|$raiz|g" -e "s|@RUN_DIR@|$run|g" "$raiz/scripts/systemd/atm-atualizar.$u.in" > "$dest/atm-atualizar.$u.tmp"
  mv -f "$dest/atm-atualizar.$u.tmp" "$dest/atm-atualizar.$u"
done
if [[ "$usar_systemctl" -eq 1 ]]; then
  "$sctl" --user daemon-reload
  "$sctl" --user enable --now atm-atualizar.path
else
  echo "instalar-atualizacao: --sem-systemctl: units geradas, mas não habilitadas"
fi
: > "$run/configurada"
echo "Atualização pela UI configurada. Units em $dest; run dir $run; script $raiz/scripts/atualizar.sh"
