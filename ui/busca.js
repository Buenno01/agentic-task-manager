// Busca textual (ticket 13): caixa de busca sobre Tarefas, comentários, Contexto consolidado e anexos.
const API = new URLSearchParams(location.search).get("api") ?? "http://127.0.0.1:3000";
const form = document.getElementById("busca-form");
const saida = document.getElementById("busca-resultados");
const erroBusca = document.getElementById("busca-erro");
const ROTULO = { tarefa: "Tarefa", comentario: "Comentário", consolidado: "Consolidado", anexo: "Anexo" };

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  erroBusca.textContent = "";
  saida.replaceChildren();
  const p = new URLSearchParams({ q: form.q.value });
  const ctx = document.getElementById("filtro-ctx").value;
  if (ctx) p.set("contexto", ctx);
  if (ctx && form.subarvore.checked) p.set("subarvore", "1");
  const token = localStorage.getItem("atm-token");
  const res = await fetch(`${API}/busca?${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    erroBusca.textContent = res.status === 401 ? "Token inválido ou ausente" : (await res.json()).error;
    return;
  }
  const achados = await res.json();
  if (!achados.length) saida.append(Object.assign(document.createElement("li"), { textContent: "Nada encontrado" }));
  // textContent (nunca innerHTML): o snippet vem de texto de usuário.
  for (const a of achados) {
    const li = document.createElement("li");
    li.textContent = `[${ROTULO[a.tipo]}] ${a.snippet}`;
    saida.append(li);
  }
});
