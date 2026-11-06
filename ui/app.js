const API = new URLSearchParams(location.search).get("api") ?? "http://127.0.0.1:3000";
const TOKEN_KEY = "atm-token";
const _fetch = window.fetch.bind(window);
// Todas as requisições à API levam o token guardado no navegador (nunca embutido no código).
const fetch = (url, init = {}) => {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = { ...(init.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  return _fetch(url, { ...init, headers });
};
const lista = document.getElementById("lista");
const erro = document.getElementById("erro");

const nomes = new Map();
const arvore = document.getElementById("arvore");
const resolvido = document.getElementById("resolvido");

function opcoes(select, raizes, vazio) {
  select.replaceChildren(new Option(vazio, ""));
  const visitar = (n, nivel) => {
    select.append(new Option("— ".repeat(nivel) + n.name, n.id));
    n.children.forEach((c) => visitar(c, nivel + 1));
  };
  raizes.forEach((n) => visitar(n, 0));
}

async function carregarContextos() {
  const raizes = await (await fetch(`${API}/contextos/arvore`)).json();
  nomes.clear();
  const render = (n) => {
    nomes.set(n.id, n.name);
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${n.name} (${n.kind})`;
    b.addEventListener("click", async () => {
      const r = await (await fetch(`${API}/contextos/${n.id}/resolvido`)).json();
      resolvido.textContent = JSON.stringify(r, null, 2);
    });
    li.append(b);
    if (n.children.length) {
      const ul = document.createElement("ul");
      ul.append(...n.children.map(render));
      li.append(ul);
    }
    return li;
  };
  arvore.replaceChildren(...raizes.map(render));
  opcoes(document.getElementById("pai"), raizes, "(raiz)");
  opcoes(document.getElementById("ctx-tarefa"), raizes, "(sem Contexto)");
}

document.getElementById("novo-contexto").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  erro.textContent = "";
  const corpo = { name: f.name.value, kind: f.kind.value, parentId: f.parentId.value || null, instructions: f.instructions.value };
  if (f.repository.value) corpo.repository = f.repository.value;
  if (f.testCommands.value) corpo.testCommands = f.testCommands.value.split(";").map((s) => s.trim()).filter(Boolean);
  if (f.concurrencyLimit.value) corpo.concurrencyLimit = Number(f.concurrencyLimit.value);
  const res = await fetch(`${API}/contextos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) });
  if (!res.ok) erro.textContent = (await res.json()).error;
  else f.reset();
  await carregarContextos();
});

const filtroEstado = document.getElementById("filtro-estado");
const filtroCtx = document.getElementById("filtro-ctx");
const inbox = document.getElementById("inbox");
const AGUARDANDO = "Aguardando humano";
// Ações humanas por estado atual (nomes iguais aos de POST /tarefas/:id/:acao).
const ACOES = {
  Novo: ["autorizar", "rejeitar"],
  "Plano pronto para aprovação": ["aprovar", "rejeitar"],
  Rejeitado: ["reabrir"],
};
let soAguardando = false;

// Fase Execução (ticket 08): ações humanas por estado, e conversão com o contrato mínimo.
const ACOES_EXECUCAO = {
  "Na fila": ["iniciar-execucao"],
  "Em execução": ["aguardar-humano-execucao", "validar-execucao"],
  "Aguardando humano": ["retomar-execucao"],
  "Em validação": ["concluir-execucao"],
};
async function converter(id) {
  erro.textContent = "";
  const objetivo = prompt("Objetivo:");
  const repositorioPrincipal = prompt("Repositório principal:");
  const criterios = (prompt("Critérios de aceitação (separados por ;):") ?? "").split(";").map((s) => s.trim()).filter(Boolean);
  if (!objetivo || !repositorioPrincipal) return;
  const res = await fetch(`${API}/tarefas/${id}/converter-execucao`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ objetivo, repositorioPrincipal, criterios }),
  });
  if (!res.ok) erro.textContent = (await res.json()).error;
  await carregar();
}

async function agir(id, acao) {
  erro.textContent = "";
  const motivo = prompt(`Motivo para ${acao} (opcional):`) ?? "";
  const res = await fetch(`${API}/tarefas/${id}/${acao}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ motivo }),
  });
  if (!res.ok) erro.textContent = (await res.json()).error;
  await carregar();
}

async function carregar() {
  await carregarContextos();
  const ctxSel = filtroCtx.value;
  opcoes(filtroCtx, await (await fetch(`${API}/contextos/arvore`)).json(), "(todos os Contextos)");
  filtroCtx.value = ctxSel;
  const res = await fetch(`${API}/tarefas`);
  if (!res.ok) {
    erro.textContent = res.status === 401 ? "Token inválido ou ausente" : "Erro ao carregar tarefas";
    return;
  }
  const todas = await res.json();
  inbox.textContent = `Aguardando humano (${todas.filter((t) => t.state === AGUARDANDO).length})`;
  const tarefas = todas.filter(
    (t) =>
      (soAguardando ? t.state === AGUARDANDO : !filtroEstado.value || t.state === filtroEstado.value) &&
      (!filtroCtx.value || t.contextId === filtroCtx.value),
  );
  lista.replaceChildren(
    ...tarefas.map((t) => {
      const li = document.createElement("li");
      li.append(`[${t.phase} · ${t.state}] ${t.contextId ? "(" + (nomes.get(t.contextId) ?? "?") + ") " : ""}${t.title}${t.description ? " — " + t.description : ""} `);
      const acoes = t.phase === "Execução" ? ACOES_EXECUCAO[t.state] ?? [] : [...(ACOES[t.state] ?? []), ...(t.state === "Rejeitado" ? [] : ["converter-execucao"])];
      for (const acao of acoes) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = acao;
        b.addEventListener("click", () => (acao === "converter-execucao" ? converter(t.id) : agir(t.id, acao)));
        li.append(b, " ");
      }
      return li;
    }),
  );
}

inbox.addEventListener("click", () => {
  soAguardando = !soAguardando;
  carregar();
});
filtroEstado.addEventListener("change", () => {
  soAguardando = false;
  carregar();
});
filtroCtx.addEventListener("change", carregar);

const formToken = document.getElementById("token-form");
formToken.token.value = localStorage.getItem(TOKEN_KEY) ?? "";
formToken.addEventListener("submit", (e) => {
  e.preventDefault();
  localStorage.setItem(TOKEN_KEY, formToken.token.value);
  erro.textContent = "";
  carregar().catch(() => (erro.textContent = "API indisponível"));
});

document.getElementById("nova").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  erro.textContent = "";
  const res = await fetch(`${API}/tarefas`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: f.title.value, description: f.description.value, contextId: f.contextId.value || null }),
  });
  if (!res.ok) erro.textContent = (await res.json()).error;
  else f.reset();
  await carregar();
});

carregar().catch(() => (erro.textContent = "API indisponível"));
