#!/usr/bin/env bash
# Verificação manual do adaptador Hermes (ticket 12): roda UMA Tarefa de Execução de exemplo, de ponta a ponta,
# contra um repositório de teste temporário. CHAMA O MODELO REAL (custa dinheiro). Só roda com ATM_TESTE_HERMES=1.
#
# Pré-requisitos: `hermes` instalado e com provedor/chave configurados (`hermes chat -q ok` funciona), git, curl, node>=24,
# `npm ci` feito em daemon/ e mcp/. Opcional: ATM_HERMES_MODEL, ATM_HERMES_MAX_TURNS (padrão 30), ATM_HERMES_RUN_BUDGET (padrão 600).
# Resultado: ao fim imprime a branch criada no clone do Workspace (não há remote, então é uma branch local) e o diff.
set -euo pipefail

if [[ "${ATM_TESTE_HERMES:-}" != "1" ]]; then
  echo "Recusando: este script chama o modelo real. Rode com ATM_TESTE_HERMES=1." >&2
  exit 2
fi
for c in hermes git curl node; do command -v "$c" >/dev/null || { echo "Faltando no PATH: $c" >&2; exit 1; }; done

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/atm-verificar-hermes.XXXXXX")"
PORTA_API="${ATM_VERIFICAR_PORTA_API:-3917}"
PORTA_MCP="${ATM_VERIFICAR_PORTA_MCP:-3918}"
HUMANO="humano-$(openssl rand -hex 12)"
AGENTE="orquestrador-$(openssl rand -hex 12)"
PIDS=()
limpar() {
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
  echo "Arquivos temporários mantidos em: $TMP"
}
trap limpar EXIT

# 1. Repositório de teste (origem local).
ORIGEM="$TMP/origem"
mkdir -p "$ORIGEM"
git -C "$ORIGEM" init -q -b main
git -C "$ORIGEM" config user.name teste && git -C "$ORIGEM" config user.email teste@atm.local
printf 'def soma(a, b):\n    return a - b\n' > "$ORIGEM/calc.py"
printf '# repo de teste\n' > "$ORIGEM/README.md"
git -C "$ORIGEM" add . && git -C "$ORIGEM" commit -q -m inicial

# 2. MCP e daemon (processos locais, ambiente mínimo para cada um; sem ATM_GITHUB_TOKEN: a Execução fica em branch local).
( cd "$RAIZ/mcp" && env -i PATH="$PATH" HOME="$HOME" ATM_API_URL="http://127.0.0.1:$PORTA_API" ATM_AGENT_TOKEN="$AGENTE" \
    ATM_MCP_HOST=127.0.0.1 ATM_MCP_PORT="$PORTA_MCP" node src/main.ts >"$TMP/mcp.log" 2>&1 ) &
PIDS+=($!)
( cd "$RAIZ/daemon" && env -i PATH="$PATH" HOME="$HOME" ${HERMES_HOME:+HERMES_HOME="$HERMES_HOME"} \
    $(env | grep -E '^(ANTHROPIC|OPENAI|OPENROUTER|GOOGLE|GEMINI|NOUS)_API_KEY=' || true) \
    ATM_EXECUTOR=hermes ATM_HERMES_MODEL="${ATM_HERMES_MODEL:-}" \
    ATM_HERMES_MAX_TURNS="${ATM_HERMES_MAX_TURNS:-30}" ATM_HERMES_RUN_BUDGET="${ATM_HERMES_RUN_BUDGET:-600}" \
    ATM_HUMAN_TOKEN="$HUMANO" ATM_AGENT_TOKENS="orquestrador:$AGENTE" ATM_MCP_URL="http://127.0.0.1:$PORTA_MCP/mcp" \
    ATM_PORT="$PORTA_API" ATM_HOST=127.0.0.1 ATM_DB_PATH="$TMP/data/atm.db" ATM_ATTACHMENTS_DIR="$TMP/data/anexos" \
    ATM_WORKSPACES_DIR="$TMP/data/workspaces" ATM_REPOS_DIR="$TMP/data/repos" ATM_LOGS_DIR="$TMP/data/logs" \
    node src/main.ts >"$TMP/daemon.log" 2>&1 ) &
PIDS+=($!)

API="http://127.0.0.1:$PORTA_API"
for _ in $(seq 1 50); do curl -fs "$API/health" >/dev/null 2>&1 && break; sleep 0.2; done
curl -fs "$API/health" >/dev/null || { echo "Daemon não subiu; veja $TMP/daemon.log" >&2; exit 1; }

chamar() { # metodo caminho [corpo]
  curl -fsS -X "$1" "$API$2" -H "authorization: Bearer $HUMANO" -H 'content-type: application/json' ${3:+-d "$3"}
}
campo() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]))' "$1"; }

# 3. Contexto + Tarefa de Execução já "Na fila" + Rodada.
CTX=$(chamar POST /contextos "{\"name\":\"Repo de teste\",\"kind\":\"repositorio\",\"repository\":\"file://$ORIGEM\"}" | campo id)
TAREFA=$(chamar POST /tarefas "{\"title\":\"Corrigir soma\",\"description\":\"A função soma em calc.py subtrai em vez de somar. Corrija e faça commit numa branch com mensagem clara. Ao terminar, use a ferramenta entregar do MCP com um resumo.\",\"phase\":\"Execução\",\"objetivo\":\"soma(2,3) retorna 5\",\"repositorioPrincipal\":\"file://$ORIGEM\",\"criterios\":[\"soma(2,3) == 5\"],\"contextId\":\"$CTX\"}" | campo id)
echo "Tarefa $TAREFA criada; iniciando Rodada de Execução (isto chama o modelo)…"
chamar POST "/tarefas/$TAREFA/rodadas" >/dev/null

ESTADO=""
for _ in $(seq 1 $(( ${ATM_HERMES_RUN_BUDGET:-600} / 2 + 30 ))); do
  ESTADO=$(chamar GET "/tarefas/$TAREFA/rodadas" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.length?r[r.length-1].estado:"?")})')
  [[ "$ESTADO" != "em andamento" && "$ESTADO" != "?" ]] && break
  sleep 2
done
echo "Rodada: $ESTADO"
RODADA=$(chamar GET "/tarefas/$TAREFA/rodadas" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).at(-1);console.log(r.id)})')
echo "--- Rodada (eventos e uso) ---"
chamar GET "/rodadas/$RODADA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(JSON.stringify({estado:r.estado,branch:r.branch,workspace:r.workspace,segmentos:r.segmentos,tokens:r.tokens,erro:r.erro,eventos:(r.eventos||[]).map(e=>e.tipo)},null,2))})'
echo "--- Tarefa ---"
chamar GET "/tarefas/$TAREFA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s);console.log(t.phase,"·",t.state)})'

# 4. Branch local gerada no Workspace.
WS=$(find "$TMP/data/workspaces" -mindepth 1 -maxdepth 2 -name .git -printf '%h\n' 2>/dev/null | head -1 || true)
if [[ -n "$WS" ]]; then
  echo "--- Workspace: $WS ---"
  git -C "$WS" branch --show-current
  git -C "$WS" log --oneline -5
  git -C "$WS" diff main... --stat 2>/dev/null || git -C "$WS" show --stat HEAD
else
  echo "Workspace não encontrado em $TMP/data/workspaces" >&2
fi

[[ "$ESTADO" == "concluída" ]] || { echo "FALHOU: Rodada terminou como '$ESTADO'. Logs: $TMP/daemon.log, $TMP/mcp.log" >&2; exit 1; }
echo "OK. Confira manualmente: calc.py corrigido, commit na branch, uso de tokens registrado (ou 'uso desconhecido')."
