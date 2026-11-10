#!/usr/bin/env bash
# Atualiza a produção local (este clone) para uma tag de release: scripts/atualizar.sh [tag]
# Sem argumento, usa a maior tag semântica (vX.Y.Z) do origin. Roda no HOST; o daemon nunca recebe docker.sock.
#
# Fluxo: fetch --tags -> resolve a tag -> (já é a atual? informa e sai) -> para o daemon -> copia o atm.db para o
# diretório de backups -> checkout da tag -> `docker compose up -d --build --wait` com ATM_VERSAO=<tag>.
# Recusa rodar com árvore suja ou sem `origin`. Opera sempre sobre o clone onde o script está.
#
# Ambiente (todos opcionais):
#   ATM_BACKUP_DIR  onde ficam os backups (padrão: ~/atm-backups)
#   ATM_DB_DIR      diretório com o atm.db a copiar. Sem ele, o banco é lido do contêiner parado
#                   (`docker compose cp daemon:/data/db/atm.db`), ou seja, do volume atm-db.
#   ATM_BACKUPS_MANTER  quantos backups manter (padrão: 5)
set -euo pipefail

BACKUPS_MANTER="${ATM_BACKUPS_MANTER:-5}"

erro() { echo "atualizar: $*" >&2; }

main() {
  local raiz alvo atual atual_ref backup_dir
  raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$raiz"
  backup_dir="${ATM_BACKUP_DIR:-$HOME/atm-backups}"

  git rev-parse --git-dir >/dev/null 2>&1 || { erro "$raiz não é um repositório git"; return 1; }
  git remote get-url origin >/dev/null 2>&1 || { erro "remote 'origin' não configurado em $raiz (este não parece ser o clone de produção)"; return 1; }
  if [[ -n "$(git status --porcelain)" ]]; then
    erro "o clone tem alterações locais não commitadas; recusando para não perder trabalho nem subir código que não é de uma tag"
    return 1
  fi

  git fetch --tags --force --quiet origin || { erro "falha ao buscar tags do origin"; return 1; }

  if [[ $# -ge 1 && -n "$1" ]]; then
    alvo="$1"
  else
    alvo="$(git tag --list --sort=-v:refname | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' | head -n1 || true)"
    [[ -n "$alvo" ]] || { erro "nenhuma tag de versão (vX.Y.Z) encontrada no origin"; return 1; }
  fi
  git rev-parse -q --verify "refs/tags/$alvo^{commit}" >/dev/null || { erro "tag '$alvo' não existe no origin; nada foi alterado"; return 1; }

  atual="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"
  if [[ "$(git rev-parse HEAD)" == "$(git rev-parse "$alvo^{commit}")" ]]; then
    echo "Produção já está em ${atual:-$alvo}; nada a fazer."
    return 0
  fi
  atual_ref="${atual:-sem-tag-$(git rev-parse --short HEAD)}"

  echo "Atualizando $atual_ref -> $alvo"
  docker compose stop daemon

  mkdir -p "$backup_dir"
  local backup="$backup_dir/atm-$(date +%Y%m%d-%H%M%S)-$atual_ref.db"
  if [[ -n "${ATM_DB_DIR:-}" ]]; then
    cp "$ATM_DB_DIR/atm.db" "$backup" || { erro "falha ao copiar o banco de $ATM_DB_DIR"; return 1; }
  else
    docker compose cp daemon:/data/db/atm.db "$backup" || { erro "falha ao copiar o banco do volume atm-db"; return 1; }
  fi
  echo "Backup: $backup"
  # Retenção: nomes começam por data/hora, então a ordem lexical é a cronológica.
  local antigos
  antigos="$(ls -1 "$backup_dir"/atm-*.db 2>/dev/null | sort | head -n "-$BACKUPS_MANTER" || true)"
  [[ -z "$antigos" ]] || xargs -d '\n' rm -f -- <<<"$antigos"

  git checkout --quiet "$alvo"
  export ATM_VERSAO="$alvo"
  docker compose up -d --build --wait || { erro "a versão $alvo não subiu saudável (rollback: ticket 02)"; return 1; }
  echo "Produção agora em $alvo."
}

# Função + exit explícito: o checkout pode trocar este arquivo no meio da execução.
main "$@"
exit $?
