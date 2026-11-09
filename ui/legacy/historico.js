// Histórico da Tarefa (RF3, RF9): linha do tempo + novo comentário. Autônomo; aberto por evento "abrir-historico".
const API = new URLSearchParams(location.search).get("api") ?? "http://127.0.0.1:3000";
const secao = document.getElementById("historico");
const titulo = document.getElementById("historico-titulo");
const linha = document.getElementById("historico-linha");
const form = document.getElementById("comentario-form");
const erroH = document.getElementById("historico-erro");
let atual = null;

const api = (path, init = {}) => {
  const token = localStorage.getItem("atm-token");
  return fetch(`${API}${path}`, { ...init, headers: { ...(init.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
};

function descrever(e) {
  if (e.texto !== undefined) return `${e.tipo}${e.respondeA ? " (resposta à pergunta " + e.respondeA.slice(0, 8) + ")" : ""}: ${e.texto}`;
  return `${e.tipo}: ${e.de} → ${e.para}${e.motivo ? " — " + e.motivo : ""}`;
}

async function carregarHistorico() {
  const res = await api(`/tarefas/${atual.id}/eventos`);
  if (!res.ok) return void (erroH.textContent = (await res.json()).error);
  const itens = await res.json();
  linha.replaceChildren(
    ...itens.map((e) => {
      const li = document.createElement("li");
      li.textContent = `${new Date(e.em).toLocaleString()} · ${e.autor} · ${descrever(e)}`;
      const perguntas = form.respondeA;
      if (e.tipo === "pergunta") perguntas.append(new Option(`${e.autor}: ${e.texto}`, e.id));
      return li;
    }),
  );
}

document.addEventListener("abrir-historico", async (ev) => {
  atual = ev.detail;
  secao.hidden = false;
  titulo.textContent = `Histórico: ${atual.title}`;
  erroH.textContent = "";
  form.respondeA.replaceChildren(new Option("(não é resposta)", ""));
  await carregarHistorico();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  erroH.textContent = "";
  const corpo = { tipo: form.tipo.value, texto: form.texto.value };
  if (form.respondeA.value) corpo.respondeA = form.respondeA.value;
  const res = await api(`/tarefas/${atual.id}/comentarios`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) });
  if (!res.ok) return void (erroH.textContent = (await res.json()).error);
  form.texto.value = "";
  form.respondeA.replaceChildren(new Option("(não é resposta)", ""));
  await carregarHistorico();
});
