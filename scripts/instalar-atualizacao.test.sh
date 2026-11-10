#!/usr/bin/env bash
# Teste de scripts/instalar-atualizacao.sh e scripts/desinstalar-atualizacao.sh com `systemctl` falso (sem systemd real):
#   bash scripts/instalar-atualizacao.test.sh
set -uo pipefail
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/atm-instalar-teste.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT
FALHAS=0; TOTAL=0
ok() { TOTAL=$((TOTAL + 1)); if [[ "$1" == 0 ]]; then echo "ok   - $2"; else FALHAS=$((FALHAS + 1)); echo "FAIL - $2"; fi; }
tem() { grep -qF -- "$2" "$1"; }

cat > "$BASE/systemctl" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_SYSTEMCTL_LOG"
FAKE
chmod +x "$BASE/systemctl"

# Clone de "produção" falso: só precisa dos scripts e modelos copiados.
CLONE="$BASE/prod clone-sem-espaco"; CLONE="${CLONE// /_}"
mkdir -p "$CLONE/scripts"; cp -r "$RAIZ/scripts/." "$CLONE/scripts/"
UNITS="$BASE/units"; export FAKE_SYSTEMCTL_LOG="$BASE/systemctl.log"; : > "$FAKE_SYSTEMCTL_LOG"
export SYSTEMD_USER_DIR="$UNITS" ATM_SYSTEMCTL="$BASE/systemctl"
RUN="$CLONE/run"

bash "$CLONE/scripts/instalar-atualizacao.sh" >"$BASE/out1" 2>&1; ok $? "instalador roda com sucesso"
[[ -f "$UNITS/atm-atualizar.path" && -f "$UNITS/atm-atualizar.service" ]]; ok $? "gera .path e .service"
tem "$UNITS/atm-atualizar.path" "PathExists=$RUN/pedido-atualizacao"; ok $? ".path vigia o pedido no run do clone"
tem "$UNITS/atm-atualizar.path" "WantedBy=default.target"; ok $? ".path é instalável"
tem "$UNITS/atm-atualizar.service" "ExecStartPre=/bin/rm -f $RUN/pedido-atualizacao"; ok $? ".service remove o pedido antes de rodar"
tem "$UNITS/atm-atualizar.service" "ExecStart=$CLONE/scripts/atualizar.sh"; ok $? ".service roda atualizar.sh do clone"
tem "$UNITS/atm-atualizar.service" "Environment=ATM_ESTADO_DIR=$RUN"; ok $? ".service define ATM_ESTADO_DIR"
! grep -q '@[A-Z_]*@' "$UNITS"/atm-atualizar.*; ok $? "nenhum placeholder sobrando"
[[ -f "$RUN/configurada" ]]; ok $? "grava o marcador configurada"
tem "$FAKE_SYSTEMCTL_LOG" "--user daemon-reload"; ok $? "daemon-reload"
tem "$FAKE_SYSTEMCTL_LOG" "--user enable --now atm-atualizar.path"; ok $? "enable --now da .path"

cp "$UNITS/atm-atualizar.path" "$BASE/p1"; cp "$UNITS/atm-atualizar.service" "$BASE/s1"
bash "$CLONE/scripts/instalar-atualizacao.sh" >"$BASE/out2" 2>&1; ok $? "segunda execução (idempotente) sucesso"
cmp -s "$UNITS/atm-atualizar.path" "$BASE/p1" && cmp -s "$UNITS/atm-atualizar.service" "$BASE/s1"; ok $? "units idênticas após reinstalar"
[[ -f "$RUN/configurada" ]]; ok $? "marcador segue presente"

# Run dir customizado
ATM_ESTADO_DIR="$BASE/outro-run" bash "$CLONE/scripts/instalar-atualizacao.sh" >/dev/null 2>&1
tem "$UNITS/atm-atualizar.path" "PathExists=$BASE/outro-run/pedido-atualizacao" && [[ -f "$BASE/outro-run/configurada" ]]; ok $? "ATM_ESTADO_DIR altera o run dir"
rm -rf "$BASE/outro-run"; bash "$CLONE/scripts/instalar-atualizacao.sh" >/dev/null 2>&1

# --sem-systemctl
: > "$FAKE_SYSTEMCTL_LOG"
bash "$CLONE/scripts/instalar-atualizacao.sh" --sem-systemctl >/dev/null 2>&1; ok $? "--sem-systemctl roda"
[[ ! -s "$FAKE_SYSTEMCTL_LOG" ]]; ok $? "--sem-systemctl não chama systemctl"

# Desinstalar
: > "$FAKE_SYSTEMCTL_LOG"
bash "$CLONE/scripts/desinstalar-atualizacao.sh" >"$BASE/out3" 2>&1; ok $? "desinstalador roda com sucesso"
[[ ! -e "$UNITS/atm-atualizar.path" && ! -e "$UNITS/atm-atualizar.service" ]]; ok $? "remove as units"
[[ ! -e "$RUN/configurada" ]]; ok $? "remove o marcador"
tem "$FAKE_SYSTEMCTL_LOG" "--user disable --now atm-atualizar.path"; ok $? "disable --now da .path"
bash "$CLONE/scripts/desinstalar-atualizacao.sh" >/dev/null 2>&1; ok $? "desinstalar de novo é no-op"

# Caminho com espaço é recusado
ESP="$BASE/com espaco"; mkdir -p "$ESP/scripts"; cp -r "$RAIZ/scripts/." "$ESP/scripts/"
bash "$ESP/scripts/instalar-atualizacao.sh" >/dev/null 2>&1; [[ $? -ne 0 && ! -e "$UNITS/atm-atualizar.path" ]]; ok $? "recusa caminho com espaço"

echo "$((TOTAL - FALHAS))/$TOTAL passaram"
[[ "$FALHAS" -eq 0 ]]
