// Dependências brandas (RF5): aviso explícito, "Forçar início" e declarar/remover dependência.
// `chamar(caminho, metodo, corpo)` é fornecido por app.js (já leva o token).
export function anexarDependencias(li, t, chamar, recarregar, mostrarErro) {
  const pendentes = t.dependenciasPendentes ?? [];
  if (pendentes.length) {
    const aviso = document.createElement("strong");
    aviso.className = "aviso-dependencia";
    aviso.textContent = `⚠ Dependência pendente: ${pendentes.map((d) => `${d.title ?? d.id} (${d.state})`).join(", ")} `;
    li.append(aviso);
    if (t.state === "Autorizada para explorar") {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Forçar início";
      b.addEventListener("click", async () => {
        const motivo = prompt("Motivo para forçar o início (opcional):") ?? "";
        await executar(() => chamar(`/tarefas/${t.id}/forcar-inicio`, "POST", { motivo }), recarregar, mostrarErro);
      });
      li.append(b, " ");
    }
  }
  const dep = document.createElement("button");
  dep.type = "button";
  dep.textContent = "Depende de…";
  dep.addEventListener("click", async () => {
    const id = prompt("ID da Tarefa da qual esta depende:");
    if (id) await executar(() => chamar(`/tarefas/${t.id}/dependencias`, "POST", { dependeDe: id }), recarregar, mostrarErro);
  });
  li.append(dep, " ");
  for (const a of t.dependeDe ?? []) {
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = `remover dependência ${a.slice(0, 8)}`;
    x.addEventListener("click", () => executar(() => chamar(`/tarefas/${t.id}/dependencias/${a}`, "DELETE"), recarregar, mostrarErro));
    li.append(x, " ");
  }
}

async function executar(fn, recarregar, mostrarErro) {
  mostrarErro("");
  const res = await fn();
  if (!res.ok) mostrarErro((await res.json()).error);
  await recarregar();
}
