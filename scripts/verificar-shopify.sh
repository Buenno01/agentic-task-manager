#!/usr/bin/env bash
# Verificação manual da integração Shopify (Fase 3): roda UMA Coleta com a loja e o token reais e confere pedidos,
# produtos e, se disponível, sessões e conversão. SOMENTE LEITURA na loja (token read_orders/read_products/read_analytics).
# A suíte automática nunca usa rede; este é o único ponto que fala com a Shopify de verdade. Só roda com ATM_TESTE_SHOPIFY=1.
#
# Pré-requisitos: curl, node>=24, `npm ci` feito em daemon/.
# Entrada (ambiente): ATM_SHOPIFY_SHOP (ex.: minha-loja.myshopify.com), ATM_SHOPIFY_TOKEN (token da Admin API, só leitura).
# Opcional: ATM_SHOPIFY_TIMEZONE (padrão America/Sao_Paulo), ATM_SHOPIFY_API_VERSION (AAAA-MM), ATM_SHOPIFY_JANELA (dias recoletados, padrão 3).
# O token nunca é impresso; as saídas e os logs são checados contra vazamento ao final.
# Resultado: "OK" ou a causa da falha (as mesmas categorias da Tarefa de ação humana do RF24: token, escopo, loja, analytics).
set -euo pipefail

if [[ "${ATM_TESTE_SHOPIFY:-}" != "1" ]]; then
  echo "Recusando: este script fala com a loja Shopify real. Rode com ATM_TESTE_SHOPIFY=1." >&2
  exit 2
fi
for c in curl node openssl; do command -v "$c" >/dev/null || { echo "Faltando no PATH: $c" >&2; exit 1; }; done
: "${ATM_SHOPIFY_SHOP:?Defina ATM_SHOPIFY_SHOP (ex.: minha-loja.myshopify.com)}"
: "${ATM_SHOPIFY_TOKEN:?Defina ATM_SHOPIFY_TOKEN (token da Admin API, somente leitura)}"

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/atm-verificar-shopify.XXXXXX")"
PORTA_API="${ATM_VERIFICAR_PORTA_API:-3927}"
HUMANO="humano-$(openssl rand -hex 12)"
AGENTE="orquestrador-$(openssl rand -hex 12)"
FUSO="${ATM_SHOPIFY_TIMEZONE:-America/Sao_Paulo}"
JANELA="${ATM_SHOPIFY_JANELA:-3}"
API="http://127.0.0.1:$PORTA_API"
PID=""
limpar() {
  [[ -n "$PID" ]] && kill "$PID" 2>/dev/null || true
  echo "Arquivos temporários mantidos em: $TMP"
}
trap limpar EXIT

# 1. Daemon local com banco temporário. O agendador fica desligado: só a Coleta disparada aqui roda.
( cd "$RAIZ/daemon" && env -i PATH="$PATH" HOME="$HOME" \
    ATM_SHOPIFY_TOKEN="$ATM_SHOPIFY_TOKEN" ATM_COLETA_AGENDADOR=0 \
    ATM_HUMAN_TOKEN="$HUMANO" ATM_AGENT_TOKENS="orquestrador:$AGENTE" \
    ATM_PORT="$PORTA_API" ATM_HOST=127.0.0.1 ATM_DB_PATH="$TMP/data/atm.db" ATM_ATTACHMENTS_DIR="$TMP/data/anexos" \
    ATM_WORKSPACES_DIR="$TMP/data/workspaces" ATM_REPOS_DIR="$TMP/data/repos" ATM_LOGS_DIR="$TMP/data/logs" \
    node src/main.ts >"$TMP/daemon.log" 2>&1 ) &
PID=$!
for _ in $(seq 1 50); do curl -fs "$API/health" >/dev/null 2>&1 && break; sleep 0.2; done
curl -fs "$API/health" >/dev/null || { echo "Daemon não subiu; veja $TMP/daemon.log" >&2; exit 1; }

chamar() { # metodo caminho [corpo]
  curl -fsS -X "$1" "$API$2" -H "authorization: Bearer $HUMANO" -H 'content-type: application/json' ${3:+-d "$3"}
}
campo() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]))' "$1"; }

# 2. Contexto + Coletor Shopify (o segredo só entra como NOME de variável; o valor vai no ambiente do daemon).
CTX=$(chamar POST /contextos '{"name":"Loja (verificação)","kind":"loja"}' | campo id)
PARAMS="{\"shop\":\"$ATM_SHOPIFY_SHOP\",\"timezone\":\"$FUSO\"${ATM_SHOPIFY_API_VERSION:+,\"apiVersion\":\"$ATM_SHOPIFY_API_VERSION\"}}"
COLETOR=$(chamar POST /coletores "{\"contextId\":\"$CTX\",\"source\":\"shopify\",\"tokenEnv\":\"ATM_SHOPIFY_TOKEN\",\"recollectWindowDays\":$JANELA,\"params\":$PARAMS}" | campo id)
echo "Coletor $COLETOR criado para $ATM_SHOPIFY_SHOP ($FUSO); disparando Coleta (lê a loja real)…"

# 3. Coleta e espera.
COLETA=$(chamar POST "/coletores/$COLETOR/coletas" '{}' | campo id)
ESTADO="em andamento"
for _ in $(seq 1 150); do
  ESTADO=$(chamar GET "/coletas/$COLETA" | campo state)
  [[ "$ESTADO" != "em andamento" ]] && break
  sleep 2
done

# 4. Relatório e veredito (stdout do node; o token nunca é lido aqui).
RELATORIO=$(
  {
    chamar GET "/coletas/$COLETA"
    echo
    chamar GET "/coletores/$COLETOR/consolidado"
    echo
    chamar GET "/coletores/$COLETOR/produtos"
    echo
    chamar GET "/coletores/$COLETOR/lacunas"
    echo
    chamar GET "/tarefas"
  } | node -e '
    const l = require("node:fs").readFileSync(0, "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x));
    const [coleta, cons, prod, lacunas, tarefas] = l;
    const por = (m) => cons.filter((c) => c.metric === m);
    const comValor = (m) => por(m).filter((c) => c.value !== null);
    const resumo = (m) => `${comValor(m).length}/${por(m).length} dias com valor`;
    console.log(`Coleta: ${coleta.state}${coleta.partial ? " (parcial)" : ""}${coleta.error ? " · erro: " + coleta.error : ""}`);
    console.log(`Pedidos (orders): ${resumo("orders")} · receita líquida: ${resumo("netRevenue")} · ticket médio: ${resumo("averageTicket")}`);
    console.log(`Sessões: ${resumo("sessions")} · conversão: ${resumo("conversion")}`);
    console.log(`Produtos (quebra): ${prod.length} linhas`);
    console.log(`Lacunas abertas: ${lacunas.filter((x) => !x.recoveredAt).map((x) => `${x.period}[${x.partial ? "parcial:" + x.cause : x.cause ?? "falha"}]`).join(", ") || "nenhuma"}`);
    const humanas = tarefas.filter((t) => /Shopify|Coletor|coleta/i.test(t.title ?? ""));
    for (const t of humanas) console.log(`Tarefa gerada: ${t.title} (${t.state})`);
    // veredito: código de saída 0 = ok; 3 = falha com causa; 4 = ok sem dados.
    const abertas = lacunas.filter((x) => !x.recoveredAt);
    const causa = abertas.find((x) => !x.partial);
    if (coleta.state !== "concluída" || causa) { console.log("VEREDITO falha"); process.exit(3); }
    if (comValor("orders").length === 0 && prod.length === 0) { console.log("VEREDITO sem-dados"); process.exit(4); }
    console.log(abertas.some((x) => x.partial) ? "VEREDITO ok-sem-analytics" : "VEREDITO ok");
  ' 2>&1
) && SAIDA=0 || SAIDA=$?
echo "$RELATORIO"

# 5. Segredo não pode ter vazado nem para a saída, nem para os logs, nem para o banco.
if echo "$RELATORIO" | grep -qF -- "$ATM_SHOPIFY_TOKEN" \
   || grep -rqF -- "$ATM_SHOPIFY_TOKEN" "$TMP/daemon.log" "$TMP/data" 2>/dev/null; then
  echo "FALHOU: o token apareceu na saída, nos logs ou no banco. NÃO use este token em produção sem investigar." >&2
  exit 1
fi
echo "Segredo: não encontrado na saída, nos logs nem no banco."

case "$SAIDA" in
  0) echo "OK. Confira manualmente alguns números contra o painel da Shopify (pedidos e receita de um dia)." ;;
  3) echo "FALHOU: veja a causa acima (token expirado/401 = 'token'; 403 ou escopo faltando = 'escopo'; 404 = 'loja'). Logs: $TMP/daemon.log" >&2; exit 1 ;;
  4) echo "SEM DADOS: a Coleta funcionou, mas a loja não teve pedidos nem produtos no período. Aumente ATM_SHOPIFY_JANELA." >&2; exit 1 ;;
  *) echo "FALHOU: erro ao montar o relatório (código $SAIDA). Logs: $TMP/daemon.log" >&2; exit 1 ;;
esac
