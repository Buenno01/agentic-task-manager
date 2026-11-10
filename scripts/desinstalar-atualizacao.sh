#!/usr/bin/env bash
# Remove as units systemd --user de atualização e o marcador `configurada` (volta ao modo headless puro).
#   scripts/desinstalar-atualizacao.sh [--sem-systemctl]
# Mesmo ambiente do instalador: ATM_ESTADO_DIR, SYSTEMD_USER_DIR, ATM_SYSTEMCTL. Idempotente.
set -euo pipefail
raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run="${ATM_ESTADO_DIR:-$raiz/run}"
dest="${SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
sctl="${ATM_SYSTEMCTL:-systemctl}"
if [[ "${1:-}" != "--sem-systemctl" ]]; then
  "$sctl" --user disable --now atm-atualizar.path || true
fi
rm -f "$dest/atm-atualizar.path" "$dest/atm-atualizar.service" "$run/configurada" "$run/pedido-atualizacao"
if [[ "${1:-}" != "--sem-systemctl" ]]; then "$sctl" --user daemon-reload || true; fi
echo "Atualização pela UI desinstalada (units removidas de $dest; marcador removido de $run)."
