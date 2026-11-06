const API = new URLSearchParams(location.search).get("api") ?? "http://127.0.0.1:3000";
const lista = document.getElementById("lista");
const erro = document.getElementById("erro");

async function carregar() {
  const tarefas = await (await fetch(`${API}/tarefas`)).json();
  lista.replaceChildren(
    ...tarefas.map((t) => {
      const li = document.createElement("li");
      li.textContent = `[${t.phase} · ${t.state}] ${t.title}${t.description ? " — " + t.description : ""}`;
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
    body: JSON.stringify({ title: f.title.value, description: f.description.value }),
  });
  if (!res.ok) erro.textContent = (await res.json()).error;
  else f.reset();
  await carregar();
});

carregar().catch(() => (erro.textContent = "API indisponível"));
