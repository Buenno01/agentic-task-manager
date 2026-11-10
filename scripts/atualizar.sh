#!/usr/bin/env bash
# Atualiza a produção local (este clone) para uma tag de release: scripts/atualizar.sh [tag]
# Sem argumento, usa a maior tag semântica (vX.Y.Z) do origin. Roda no HOST; o daemon nunca recebe docker.sock.
#
# Fluxo: fetch --tags -> resolve a tag -> (já é a atual? informa e sai) -> para o daemon -> copia o atm.db para o
# diretório de backups -> checkout da tag -> `docker compose up -d --build --wait` com ATM_VERSAO=<tag>
# -> (só após sucesso) poda backups antigos e grava o estado.
# Recusa rodar com árvore suja ou sem `origin`. Opera sempre sobre o clone onde o script está.
#
# Ambiente (todos opcionais):
#   ATM_BACKUP_DIR  onde ficam os backups (padrão: ~/atm-backups)
#   ATM_DB_DIR      diretório com o atm.db a copiar. Sem ele, o banco é lido do contêiner parado
#                   (`docker compose cp daemon:/data/db/atm.db`), ou seja, do volume atm-db.
#   ATM_BACKUPS_MANTER  quantos backups manter (padrão: 5); a poda só roda depois de uma atualização bem-sucedida
#   ATM_ESTADO_DIR  diretório run: ultima-atualizacao.json e o lock (padrão: <clone>/run, o mesmo do Compose e do
#                   instalador). Criado aqui (chmod 775) antes do `up`, para o Docker não criá-lo como root.
#
# Rollback: se `up --wait` falhar, para o daemon, restaura o backup (inverso da cópia), volta o checkout para a
# versão anterior e sobe de novo. Códigos de saída: 0 sucesso/no-op; 1 erro (inclui "rollback realizado");
# 3 rollback FALHOU (backup preservado, estado indeterminado).
#
# Falha DEPOIS de parar o daemon e ANTES do `up` (backup, checkout): o daemon é religado na versão anterior
# (resultado "erro"; se a religação falhar, "erro_rollback", código 3). Nunca deixa a produção parada em silêncio.
# Concorrência: flock em $ATM_ESTADO_DIR/.atualizar.lock; a segunda execução sai com código 1 sem parar nada.
#
# Arquivo de estado ($ATM_ESTADO_DIR/ultima-atualizacao.json), gravado em sucesso, erro, rollback e erro_rollback:
#   {"resultado":"sucesso|erro|rollback|erro_rollback","tag_de":"v1.0.0","tag_para":"v1.1.0","motivo":"...",
#    "em":"2026-01-01T12:00:00Z" (UTC, ISO 8601),"versao_rodando":"v1.0.0|v1.1.0|indeterminada","backup":"/caminho"}
#
# Backup e WAL: o banco usa journal_mode=WAL. Com o daemon parado de forma limpa (SIGTERM, a última conexão fecha)
# o SQLite faz checkpoint e remove -wal/-shm, então copiar só o atm.db basta. Se o daemon morrer à força, o -wal
# pode sobrar: por segurança o backup também copia atm.db-wal/-shm quando existirem, e o restore os restaura
# (ou remove os do volume se o backup não os tem, pois um -wal alheio corromperia o banco restaurado).
set -euo pipefail

BACKUPS_MANTER="${ATM_BACKUPS_MANTER:-5}"

# Estado da atualização em curso, compartilhado entre as funções.
estado_dir=""; TAG_DE=""; TAG_PARA=""; VERSAO_RODANDO=""; backup=""; backup_dir=""; atual_ref=""; atual_rev=""

erro() { echo "atualizar: $*" >&2; }

# Copia o banco (e -wal/-shm, se existirem) para <destino>, <destino>-wal, <destino>-shm.
copiar_banco_para() {
  local destino="$1" suf
  if [[ -n "${ATM_DB_DIR:-}" ]]; then
    cp "$ATM_DB_DIR/atm.db" "$destino" || return 1
    for suf in wal shm; do
      if [[ -f "$ATM_DB_DIR/atm.db-$suf" ]]; then cp "$ATM_DB_DIR/atm.db-$suf" "$destino-$suf" || return 1; fi
    done
  else
    docker compose cp daemon:/data/db/atm.db "$destino" || return 1
    for suf in wal shm; do docker compose cp "daemon:/data/db/atm.db-$suf" "$destino-$suf" >/dev/null 2>&1 || true; done
  fi
  return 0
}

# Inverso de copiar_banco_para.
restaurar_banco_de() {
  local origem="$1" suf
  if [[ -n "${ATM_DB_DIR:-}" ]]; then
    rm -f "$ATM_DB_DIR/atm.db-wal" "$ATM_DB_DIR/atm.db-shm"
    cp "$origem" "$ATM_DB_DIR/atm.db" || return 1
    for suf in wal shm; do
      if [[ -f "$origem-$suf" ]]; then cp "$origem-$suf" "$ATM_DB_DIR/atm.db-$suf" || return 1; fi
    done
  else
    docker compose run --rm --no-deps --entrypoint rm daemon -f /data/db/atm.db-wal /data/db/atm.db-shm || return 1
    docker compose cp "$origem" daemon:/data/db/atm.db || return 1
    for suf in wal shm; do
      if [[ -f "$origem-$suf" ]]; then docker compose cp "$origem-$suf" "daemon:/data/db/atm.db-$suf" || return 1; fi
    done
  fi
  return 0
}

# Retenção: nomes começam por data/hora, então a ordem lexical é a cronológica. Leva junto -wal/-shm do backup.
podar_backups() {
  local antigos f
  antigos="$(ls -1 "$backup_dir"/atm-*.db 2>/dev/null | sort | head -n "-$BACKUPS_MANTER" || true)"
  while IFS= read -r f; do
    [[ -z "$f" ]] || rm -f -- "$f" "$f-wal" "$f-shm"
  done <<<"$antigos"
  return 0
}

json_str() {
  local v="$1"
  v="${v//\\/\\\\}"; v="${v//\"/\\\"}"; v="${v//$'\n'/ }"; v="${v//$'\t'/ }"; v="${v//$'\r'/ }"
  printf '"%s"' "$v"
}

# gravar_estado <resultado> <motivo>: escrita atômica; falhar ao gravar só avisa (não muda o desfecho).
gravar_estado() {
  local resultado="$1" motivo="$2" dir="$estado_dir" tmp
  if ! { mkdir -p "$dir" && tmp="$(mktemp "$dir/.estado.XXXXXX")"; } 2>/dev/null; then
    erro "aviso: não consegui gravar o arquivo de estado em $dir"; return 0
  fi
  printf '{\n  "resultado": %s,\n  "tag_de": %s,\n  "tag_para": %s,\n  "motivo": %s,\n  "em": %s,\n  "versao_rodando": %s,\n  "backup": %s\n}\n' \
    "$(json_str "$resultado")" "$(json_str "$TAG_DE")" "$(json_str "$TAG_PARA")" "$(json_str "$motivo")" \
    "$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)")" "$(json_str "${VERSAO_RODANDO:-$TAG_PARA}")" "$(json_str "$backup")" > "$tmp" \
    && chmod 644 "$tmp" && mv -f "$tmp" "$dir/ultima-atualizacao.json" \
    || erro "aviso: não consegui gravar o arquivo de estado em $dir"
  return 0
}

# Volta ao estado anterior: para, restaura o backup, volta o checkout, sobe a versão anterior.
rollback() {
  local motivo="$1" falha=""
  erro "a versão $TAG_PARA não subiu saudável ($motivo); iniciando rollback para $TAG_DE"
  docker compose stop daemon || true
  if ! restaurar_banco_de "$backup"; then
    falha="não consegui restaurar o banco do backup"
  elif ! git checkout --quiet "$atual_rev"; then
    falha="não consegui voltar o checkout para $TAG_DE"
  else
    export ATM_VERSAO="$atual_ref"
    docker compose up -d --build --wait >&2 || falha="a versão anterior $TAG_DE também não subiu saudável"
  fi
  if [[ -n "$falha" ]]; then
    VERSAO_RODANDO="indeterminada"
    gravar_estado erro_rollback "$motivo; rollback falhou: $falha"
    erro "ROLLBACK FALHOU: $falha. Motivo original: $motivo."
    erro "O backup do banco anterior à atualização foi PRESERVADO em $backup (não apague)."
    erro "Estado: checkout em $(git describe --tags --always HEAD 2>/dev/null || echo desconhecido); serviços possivelmente parados ou não saudáveis; intervenção manual necessária."
    return 3
  fi
  VERSAO_RODANDO="$TAG_DE"
  gravar_estado rollback "$motivo"
  erro "ROLLBACK realizado: $TAG_PARA não ficou saudável ($motivo). Banco restaurado de $backup. Rodando: $TAG_DE."
  return 1
}

# Falha entre `stop daemon` e `up`: religa a versão anterior (o banco não foi tocado; o checkout volta se mudou).
falha_antes_do_up() {
  local motivo="$1" falha=""
  erro "$motivo; religando o daemon em $TAG_DE"
  [[ -z "$backup" ]] || rm -f -- "$backup" "$backup-wal" "$backup-shm"
  if [[ "$(git rev-parse HEAD)" != "$atual_rev" ]] && ! git checkout --quiet "$atual_rev"; then
    falha="não consegui voltar o checkout para $TAG_DE"
  else
    export ATM_VERSAO="$atual_ref"
    docker compose up -d --build --wait >&2 || falha="a versão anterior $TAG_DE não subiu saudável"
  fi
  if [[ -n "$falha" ]]; then
    VERSAO_RODANDO="indeterminada"
    gravar_estado erro_rollback "$motivo; religação falhou: $falha"
    erro "FALHOU: $falha. Motivo original: $motivo. Produção possivelmente parada; intervenção manual necessária."
    return 3
  fi
  VERSAO_RODANDO="$TAG_DE"
  gravar_estado erro "$motivo"
  erro "Atualização para $TAG_PARA NÃO realizada: $motivo. Rodando: $TAG_DE."
  return 1
}

main() {
  local raiz alvo atual
  raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$raiz"
  backup_dir="${ATM_BACKUP_DIR:-$HOME/atm-backups}"
  estado_dir="${ATM_ESTADO_DIR:-$raiz/run}"

  # Diretório run criado aqui (dono = usuário do host) antes de qualquer `up`: se o Docker o criasse, seria root.
  if [[ ! -d "$estado_dir" ]]; then
    mkdir -p "$estado_dir" && chmod 775 "$estado_dir" || { erro "não consegui criar $estado_dir"; return 1; }
  fi
  exec 9>"$estado_dir/.atualizar.lock" || { erro "não consegui abrir o lock em $estado_dir"; return 1; }
  flock -n 9 || { erro "outra atualização já está em andamento (lock $estado_dir/.atualizar.lock); nada foi alterado"; return 1; }

  git rev-parse --git-dir >/dev/null 2>&1 || { erro "$raiz não é um repositório git"; return 1; }
  git remote get-url origin >/dev/null 2>&1 || { erro "remote 'origin' não configurado em $raiz (este não parece ser o clone de produção)"; return 1; }
  if [[ -n "$(git status --porcelain)" ]]; then
    erro "o clone tem alterações locais não commitadas; recusando para não perder trabalho nem subir código que não é de uma tag"
    return 1
  fi

  git fetch --tags --quiet origin || { erro "falha ao buscar tags do origin"; return 1; }

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
  atual_rev="$(git rev-parse HEAD)"
  TAG_DE="$atual_ref"; TAG_PARA="$alvo"

  echo "Atualizando $atual_ref -> $alvo"
  docker compose stop daemon || { falha_antes_do_up "não consegui parar o daemon"; return $?; }

  mkdir -p "$backup_dir" || { falha_antes_do_up "não consegui criar o diretório de backups $backup_dir"; return $?; }
  backup="$backup_dir/atm-$(date +%Y%m%d-%H%M%S)-$atual_ref.db"
  copiar_banco_para "$backup" || { falha_antes_do_up "falha ao copiar o banco para o backup"; return $?; }
  echo "Backup: $backup"

  git checkout --quiet "$alvo" || { falha_antes_do_up "não consegui fazer checkout de $alvo"; return $?; }
  export ATM_VERSAO="$alvo"
  local log_up status
  log_up="$(mktemp)"
  set +e
  docker compose up -d --build --wait 2>&1 | tee "$log_up" >&2
  status="${PIPESTATUS[0]}"
  set -e
  if [[ "$status" -ne 0 ]]; then
    local motivo
    motivo="$(grep -v '^[[:space:]]*$' "$log_up" | tail -n1 || true)"; rm -f "$log_up"
    rollback "${motivo:-docker compose up --wait falhou (código $status)}"
    return $?
  fi
  rm -f "$log_up"

  # Poda só depois do sucesso: enquanto uma atualização falha, nenhum backup é apagado.
  podar_backups
  VERSAO_RODANDO="$alvo"
  gravar_estado sucesso ""
  echo "Produção agora em $alvo."
}

# Função + exit explícito: o checkout pode trocar este arquivo no meio da execução.
main "$@"
exit $?
