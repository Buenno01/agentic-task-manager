// Subtarefas (RF3): mostra as Subtarefas da mãe com a situação de resolução e
// permite aprovar/rejeitar/editar uma Subtarefa. `chamar` vem de app.js (leva o token).
export function anexarSubtarefas(li, t, chamar, recarregar, mostrarErro) {
  const r = t.resolucaoSubtarefas;
  if (r && r.total) {
    const s = document.createElement("div");
    s.className = "subtarefas";
    s.textContent = `Subtarefas: ${r.aprovadas} aprovadas, ${r.rejeitadas} rejeitadas de ${r.total} — ${r.resolvida ? "mãe resolvida" : "mãe pendente"}`;
    li.append(s);
  }
  if (t.maeId) {
    const e = document.createElement("button");
    e.type = "button";
    e.textContent = "editar subtarefa";
    e.addEventListener("click", async () => {
      const title = prompt("Título:", t.title);
      if (title) await executar(() => chamar(`/tarefas/${t.id}`, "PATCH", { title }), recarregar, mostrarErro);
    });
    li.append(e, " ");
    if (t.state === "Novo") {
      const a = document.createElement("button");
      a.type = "button";
      a.textContent = "aprovar-subtarefa";
      a.addEventListener("click", () => executar(() => chamar(`/tarefas/${t.id}/aprovar-subtarefa`, "POST", {}), recarregar, mostrarErro));
      li.append(a, " ");
    }
  }
}

async function executar(fn, recarregar, mostrarErro) {
  mostrarErro("");
  const res = await fn();
  if (!res.ok) mostrarErro((await res.json()).error);
  await recarregar();
}
