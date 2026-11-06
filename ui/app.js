const API = new URLSearchParams(location.search).get("api") ?? "http://127.0.0.1:3000";
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

async function carregar() {
  await carregarContextos();
  const tarefas = await (await fetch(`${API}/tarefas`)).json();
  lista.replaceChildren(
    ...tarefas.map((t) => {
      const li = document.createElement("li");
      li.textContent = `[${t.phase} · ${t.state}] ${t.contextId ? "(" + (nomes.get(t.contextId) ?? "?") + ") " : ""}${t.title}${t.description ? " — " + t.description : ""}`;
      return li;
    }),
  );
}

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
