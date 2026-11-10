#!/usr/bin/env bash
# Teste de integração (caixa-preta) de scripts/atualizar.sh. Roda sem Docker real, sem rede e sem tocar no repositório:
#   bash scripts/atualizar.test.sh
# Monta um "GitHub" local (repositório bare com tags), clona como "produção", põe um `docker` falso no PATH
# (registra chamadas, a tag em checkout e ATM_VERSAO) e usa diretórios temporários para o volume do banco e os backups.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/atm-atualizar-teste.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT
FALHAS=0
TOTAL=0

# ---------- docker falso ----------
mkdir -p "$BASE/bin"
cat > "$BASE/bin/docker" <<'FAKE'
#!/usr/bin/env bash
# Registra: <comando> | tag=<tag em checkout> | versao=<ATM_VERSAO>
tag="$(git describe --tags --exact-match HEAD 2>/dev/null || echo -)"
echo "$* | tag=$tag | versao=${ATM_VERSAO:-}" >> "$FAKE_DOCKER_LOG"
case "$*" in
  "compose stop daemon")
    # Parar o daemon descarrega o banco: só quem copia depois da parada enxerga "-fechado".
    [[ -f "$ATM_DB_DIR/atm.db" ]] && printf -- '-fechado' >> "$ATM_DB_DIR/atm.db"
    ;;
  "compose up -d --build --wait")
    n="$(cat "$FAKE_DOCKER_ESTADO/ups" 2>/dev/null || echo 0)"; echo $((n + 1)) > "$FAKE_DOCKER_ESTADO/ups"
    if [[ -n "${FAKE_DOCKER_FALHA_SAUDE:-}" && "$n" -lt "${FAKE_DOCKER_FALHA_SAUDE}" ]]; then
      # A versão doente já migrou o banco e deixou um -wal antes de falhar: o rollback precisa desfazer isso.
      [[ -f "$ATM_DB_DIR/atm.db" ]] && printf -- '-migrado-por-%s' "${ATM_VERSAO:-?}" >> "$ATM_DB_DIR/atm.db"
      [[ -f "$ATM_DB_DIR/atm.db" ]] && echo wal-novo > "$ATM_DB_DIR/atm.db-wal"
      echo "container daemon is unhealthy" >&2; exit 1
    fi
    ;;
esac
exit 0
FAKE
chmod +x "$BASE/bin/docker"

# ---------- cenário ----------
# novo_cenario <nome> [tags...]: cria remoto bare + produção clonada na primeira tag, com diretórios temporários.
novo_cenario() {
  local nome="$1"; shift
  local tags=("$@"); [[ ${#tags[@]} -eq 0 ]] && tags=(v1.0.0 v1.2.0 v1.10.0)
  C="$BASE/$nome"; mkdir -p "$C/estado" "$C/db" "$C/backups"
  git init -q --bare -b main "$C/remoto.git"
  git init -q -b main "$C/dev"
  (
    cd "$C/dev"
    git config user.email t@t; git config user.name t
    mkdir scripts; cp "$RAIZ/scripts/atualizar.sh" scripts/ 2>/dev/null
    echo "services: {}" > docker-compose.yml
    printf '.env\n' > .gitignore
    git add -A; git commit -qm base
    local t
    for t in "${tags[@]}"; do echo "$t" > VERSAO; git add -A; git commit -qm "release $t"; git tag "$t"; done
    git remote add origin "$C/remoto.git"; git push -q origin main --tags
  )
  git clone -q "$C/remoto.git" "$C/prod"
  git -C "$C/prod" checkout -q "${tags[0]}"
  printf "banco-v0" > "$C/db/atm.db"
  : > "$C/docker.log"
  export PATH="$BASE/bin:$PATH_ORIG"
  export FAKE_DOCKER_LOG="$C/docker.log" FAKE_DOCKER_ESTADO="$C/estado"
  export ATM_DB_DIR="$C/db" ATM_BACKUP_DIR="$C/backups" ATM_ESTADO_DIR="$C/run"
  unset FAKE_DOCKER_FALHA_SAUDE
}
PATH_ORIG="$PATH"

atualizar() { # roda o script DA PRODUÇÃO; guarda saída e código
  OUT="$(cd "$C/prod" && bash scripts/atualizar.sh "$@" 2>&1)"; COD=$?
}
tag_prod() { git -C "$C/prod" describe --tags --exact-match HEAD 2>/dev/null || echo -; }
backups() { ls "$C/backups" 2>/dev/null | sort; }

verificar() { # verificar <descrição> <condição bash>
  TOTAL=$((TOTAL + 1))
  if eval "$2"; then echo "  ok   - $1"; else echo "  FALHA - $1"; FALHAS=$((FALHAS + 1)); echo "         saída: $OUT" | head -5; fi
}
cenario() { echo; echo "# $1"; }

# ---------- cenários ----------
cenario "sem argumento: vai para a maior tag semântica (v1.10.0, não v1.2.0)"
novo_cenario feliz
atualizar
verificar "código 0" '[[ $COD -eq 0 ]]'
verificar "checkout em v1.10.0" '[[ "$(tag_prod)" == v1.10.0 ]]'
verificar "chamou up -d --build --wait" 'grep -q "^compose up -d --build --wait |" "$C/docker.log"'
verificar "ATM_VERSAO=v1.10.0 passada ao compose" 'grep -q "^compose up -d --build --wait | tag=v1.10.0 | versao=v1.10.0$" "$C/docker.log"'

cenario "tag explícita"
novo_cenario explicita
atualizar v1.2.0
verificar "código 0 e checkout em v1.2.0" '[[ $COD -eq 0 && "$(tag_prod)" == v1.2.0 ]]'
verificar "ATM_VERSAO=v1.2.0" 'grep -q "versao=v1.2.0$" "$C/docker.log"'

cenario "tag inexistente: falha clara e nada muda"
novo_cenario inexistente
atualizar v9.9.9
verificar "código ≠ 0" '[[ $COD -ne 0 ]]'
verificar "mensagem cita a tag" 'grep -q "v9.9.9" <<<"$OUT"'
verificar "continua em v1.0.0" '[[ "$(tag_prod)" == v1.0.0 ]]'
verificar "nada parado/subido" '! grep -q "stop\|up" "$C/docker.log"'
verificar "sem backup" '[[ -z "$(backups)" ]]'

cenario "já está na tag-alvo: no-op informativo"
novo_cenario noop
atualizar v1.0.0
verificar "código 0" '[[ $COD -eq 0 ]]'
verificar "mensagem informativa" 'grep -qi "já está" <<<"$OUT"'
verificar "sem chamadas ao docker" '[[ ! -s "$C/docker.log" ]]'
verificar "sem backup" '[[ -z "$(backups)" ]]'

cenario "árvore suja: recusa antes de qualquer parada"
novo_cenario suja
echo mexi >> "$C/prod/VERSAO"
atualizar
verificar "código ≠ 0" '[[ $COD -ne 0 ]]'
verificar "continua em v1.0.0 sem docker" '[[ ! -s "$C/docker.log" ]] && [[ "$(git -C "$C/prod" rev-parse HEAD)" == "$(git -C "$C/prod" rev-parse v1.0.0)" ]]'
verificar "alteração local preservada" 'grep -q mexi "$C/prod/VERSAO"'

cenario "sem origin: recusa"
novo_cenario semorigin
git -C "$C/prod" remote remove origin
atualizar
verificar "código ≠ 0 e sem docker" '[[ $COD -ne 0 && ! -s "$C/docker.log" ]]'
verificar "mensagem cita origin" 'grep -q origin <<<"$OUT"'

cenario "daemon parado antes da cópia; backup com data e tag anterior"
novo_cenario backup
atualizar
verificar "stop daemon vem antes do up" '[[ "$(grep -n "^compose stop daemon" "$C/docker.log" | cut -d: -f1)" -lt "$(grep -n "^compose up" "$C/docker.log" | cut -d: -f1)" ]]'
verificar "um único backup" '[[ "$(backups | wc -l)" -eq 1 ]]'
verificar "nome: atm-AAAAMMDD-HHMMSS-v1.0.0.db" '[[ "$(backups)" =~ ^atm-[0-9]{8}-[0-9]{6}-v1\.0\.0\.db$ ]]'
verificar "backup tem o banco já descarregado pela parada" '[[ "$(cat "$C/backups/$(backups)")" == "banco-v0-fechado" ]]'
verificar "checkout só depois do backup (stop ocorreu em v1.0.0)" 'grep -q "^compose stop daemon | tag=v1.0.0 " "$C/docker.log"'

cenario "retenção: só os 5 mais recentes"
novo_cenario poda
for d in 20200101 20200102 20200103 20200104 20200105; do echo "velho-$d" > "$C/backups/atm-$d-120000-v0.9.0.db"; done
atualizar
verificar "código 0" '[[ $COD -eq 0 ]]'
verificar "restam 5" '[[ "$(backups | wc -l)" -eq 5 ]]'
verificar "o mais antigo foi removido" '[[ ! -e "$C/backups/atm-20200101-120000-v0.9.0.db" ]]'
verificar "o novo está entre os mantidos" 'backups | grep -q "v1.0.0.db$"'

estado() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$C/run/ultima-atualizacao.json" "$1" 2>/dev/null; }

cenario "sucesso grava o arquivo de estado"
novo_cenario estado_ok
atualizar v1.2.0
verificar "resultado=sucesso, tag_de/tag_para" '[[ "$(estado resultado)" == sucesso && "$(estado tag_de)" == v1.0.0 && "$(estado tag_para)" == v1.2.0 ]]'
verificar "hora ISO UTC" '[[ "$(estado em)" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$ ]]'

cenario "saúde falha na versão nova: rollback"
novo_cenario rollback
export FAKE_DOCKER_FALHA_SAUDE=1
atualizar v1.2.0
verificar "código ≠ 0 e ≠ do erro de rollback (3)" '[[ $COD -ne 0 && $COD -ne 3 ]]'
verificar "banco voltou ao conteúdo do backup" '[[ "$(cat "$C/db/atm.db")" == "banco-v0-fechado" && "$(cat "$C/backups/$(backups | head -n1)")" == "banco-v0-fechado" ]]'
verificar "checkout voltou para v1.0.0" '[[ "$(tag_prod)" == v1.0.0 ]]'
verificar "subiu de novo com ATM_VERSAO=v1.0.0" 'grep -q "^compose up -d --build --wait | tag=v1.0.0 | versao=v1.0.0$" "$C/docker.log"'
verificar "mensagem: rollback, motivo e versão rodando" 'grep -qi "rollback" <<<"$OUT" && grep -q "unhealthy" <<<"$OUT" && grep -q "Rodando: v1.0.0" <<<"$OUT"'
verificar "estado: rollback v1.0.0 -> v1.2.0 com motivo" '[[ "$(estado resultado)" == rollback && "$(estado tag_de)" == v1.0.0 && "$(estado tag_para)" == v1.2.0 && "$(estado motivo)" == *unhealthy* && "$(estado versao_rodando)" == v1.0.0 ]]'

cenario "rollback também falha: código 3, backup preservado"
novo_cenario erro_rollback
export FAKE_DOCKER_FALHA_SAUDE=2
atualizar v1.2.0
verificar "código 3" '[[ $COD -eq 3 ]]'
verificar "mensagem nomeia o backup preservado e o estado" 'grep -q "PRESERVADO em $C/backups/atm-" <<<"$OUT" && grep -qi "ROLLBACK FALHOU" <<<"$OUT" && grep -q "Estado:" <<<"$OUT"'
verificar "backup existe com o conteúdo original" '[[ "$(cat "$C/backups/$(backups | head -n1)")" == "banco-v0-fechado" ]]'
verificar "estado: erro_rollback, versão indeterminada" '[[ "$(estado resultado)" == erro_rollback && "$(estado versao_rodando)" == indeterminada && "$(estado backup)" == "$C/backups/"* ]]'

cenario "backups não são podados enquanto a atualização falha"
novo_cenario sem_poda
for d in 20200101 20200102 20200103 20200104 20200105; do echo "velho-$d" > "$C/backups/atm-$d-120000-v0.9.0.db"; done
export FAKE_DOCKER_FALHA_SAUDE=1
atualizar v1.2.0
verificar "rollback ocorreu" '[[ $COD -eq 1 ]]'
verificar "os 5 antigos + o novo (6) continuam" '[[ "$(backups | wc -l)" -eq 6 ]]'
export FAKE_DOCKER_FALHA_SAUDE=2
novo_cenario sem_poda2
for d in 20200101 20200102 20200103 20200104 20200105; do echo "velho-$d" > "$C/backups/atm-$d-120000-v0.9.0.db"; done
export FAKE_DOCKER_FALHA_SAUDE=2
atualizar v1.2.0
verificar "nem no erro de rollback" '[[ "$(backups | wc -l)" -eq 6 ]]'

cenario "backup leva -wal/-shm quando o daemon não os limpou, e o restore os desfaz"
novo_cenario wal
echo wal-v0 > "$C/db/atm.db-wal"
export FAKE_DOCKER_FALHA_SAUDE=1
atualizar v1.2.0
verificar "backup do -wal existe" '[[ "$(cat "$C/backups/$(backups | grep "db$" | head -n1)-wal")" == wal-v0 ]]'
verificar "-wal restaurado" '[[ "$(cat "$C/db/atm.db-wal")" == wal-v0 ]]'
novo_cenario sem_wal
export FAKE_DOCKER_FALHA_SAUDE=1
atualizar v1.2.0
verificar "backup sem -wal: o -wal deixado pela versão nova é removido no restore" '[[ ! -e "$C/db/atm.db-wal" && "$(cat "$C/db/atm.db")" == "banco-v0-fechado" ]]'

echo
if [[ $FALHAS -eq 0 ]]; then echo "OK: $TOTAL verificações"; else echo "FALHOU: $FALHAS de $TOTAL"; exit 1; fi
