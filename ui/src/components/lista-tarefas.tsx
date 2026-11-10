import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { AvisoDependencia } from "@/components/aviso-dependencia";
import { TarefaForm } from "@/components/tarefa-form";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NIVEIS, type ContextoNo, type Tarefa } from "@/lib/api";
import { maeDe, pendentesDe, subtarefasDe } from "@/lib/api-subtarefas";
import { useDefinirPrioridade, useTarefas } from "@/lib/queries";
import type { SearchRaiz } from "@/lib/router";
import { ESTADO_AGUARDANDO, ESTADOS, agrupar, aparenciaEstado, aparenciaPrioridade, contarAguardando, nivelDe } from "@/lib/tarefas";
import { cn } from "@/lib/utils";

const rota = getRouteApi("/");
export const TITULO_BASE = "Agentic Task Manager";
const selectCls = "h-8 rounded-md border border-input bg-transparent px-2 text-xs dark:bg-input/30";

function PrioridadePopover({ tarefa }: { tarefa: Tarefa }) {
  const [aberto, setAberto] = useState(false);
  const definir = useDefinirPrioridade();
  const atual = nivelDe(tarefa);
  const { icone: Icone, cor } = aparenciaPrioridade(atual);
  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Prioridade de ${tarefa.title}: ${atual}`}
          className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icone className={cn("size-3.5", cor)} aria-hidden />
          <span className="hidden sm:inline">{atual}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent>
        {NIVEIS.map((n) => {
          const { icone: I, cor: c } = aparenciaPrioridade(n);
          return (
            <button
              key={n}
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
              onClick={() => {
                if (n !== atual) definir.mutate({ id: tarefa.id, nivel: n });
                setAberto(false);
              }}
            >
              <I className={cn("size-3.5", c)} aria-hidden />
              {n}
              {n === atual && <CheckIcon className="ml-auto size-3.5" aria-hidden />}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

function Linha({ tarefa, aberta, aoAbrir, filhas, abertaId, aoAbrirId }: {
  tarefa: Tarefa;
  aberta: boolean;
  aoAbrir: () => void;
  filhas: Tarefa[];
  abertaId?: string;
  aoAbrirId: (id: string) => void;
}) {
  const { icone: Icone, cor } = aparenciaEstado(tarefa.state);
  const [expandida, setExpandida] = useState(true);
  const pendentes = pendentesDe(tarefa);
  return (
    <li>
      <div className={cn("flex h-8 items-center gap-1 rounded-md pr-1 hover:bg-accent/60", aberta && "bg-accent")}>
        {filhas.length > 0 && (
          <button
            type="button"
            aria-expanded={expandida}
            aria-label={`${expandida ? "Recolher" : "Expandir"} Subtarefas de ${tarefa.title}`}
            onClick={() => setExpandida(!expandida)}
            className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            {expandida ? <ChevronDownIcon className="size-3.5" aria-hidden /> : <ChevronRightIcon className="size-3.5" aria-hidden />}
          </button>
        )}
        <button
          type="button"
          data-linha
          aria-label={`Abrir ${tarefa.title}`}
          onClick={aoAbrir}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icone className={cn("size-4 shrink-0", cor)} aria-hidden />
          <span className="truncate">{tarefa.title}</span>
        </button>
        <AvisoDependencia titulo={tarefa.title} pendentes={pendentes} />
        <PrioridadePopover tarefa={tarefa} />
      </div>
      {filhas.length > 0 && expandida && (
        <ul className="ml-6 border-l pl-1">
          {filhas.map((f) => (
            <Linha key={f.id} tarefa={f} aberta={f.id === abertaId} aoAbrir={() => aoAbrirId(f.id)} filhas={[]} abertaId={abertaId} aoAbrirId={aoAbrirId} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Lista densa agrupada por estado. Filtros, inbox e Tarefa aberta vivem na URL; estado nunca é editável aqui. */
export function ListaTarefas({ arvore }: { arvore: ContextoNo[] }) {
  const { contexto, estado, prioridade, subcontextos, tarefa: aberta } = rota.useSearch();
  const navigate = useNavigate();
  const [criando, setCriando] = useState(false);
  const { data, isPending } = useTarefas(contexto, subcontextos !== false);
  // Inbox (contador e título da aba) é global: todas as Tarefas, independentemente do Contexto e dos filtros.
  const globais = useTarefas();

  const todas = data ?? [];
  const aguardando = contarAguardando(globais.data ?? []);
  const visiveis = todas.filter((t) => (!estado || t.state === estado) && (!prioridade || nivelDe(t) === prioridade));
  // Subtarefa aparece sob a mãe quando a mãe também está visível; senão vai ao topo (filtros não a escondem).
  const idsVisiveis = new Set(visiveis.map((t) => t.id));
  const topo = visiveis.filter((t) => !(maeDe(t) && idsVisiveis.has(maeDe(t)!)));
  const filhasDe = (m: Tarefa) => {
    const ids = new Set(subtarefasDe(m).map((s) => s.id));
    return visiveis.filter((t) => ids.has(t.id) || maeDe(t) === m.id);
  };
  const grupos = agrupar(topo);

  useEffect(() => {
    document.title = aguardando > 0 ? `(${aguardando}) ${TITULO_BASE}` : TITULO_BASE;
    return () => {
      document.title = TITULO_BASE;
    };
  }, [aguardando]);

  const mudar = (patch: Partial<SearchRaiz>) => void navigate({ to: "/", search: (prev) => ({ ...prev, ...patch }) });

  function teclas(e: React.KeyboardEvent<HTMLElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const alvo = e.target as HTMLElement;
    if (!alvo.hasAttribute("data-linha")) return;
    const linhas = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-linha]")];
    const i = linhas.indexOf(alvo) + (e.key === "ArrowDown" ? 1 : -1);
    if (i < 0 || i >= linhas.length) return;
    e.preventDefault();
    linhas[i].focus();
  }

  return (
    <section aria-label="Tarefas" className="flex h-full min-h-0 flex-col" onKeyDown={teclas}>
      <div className="flex flex-wrap items-center gap-2 border-b p-2">
        <Button
          size="sm"
          variant={estado === ESTADO_AGUARDANDO ? "default" : "outline"}
          onClick={() => mudar({ estado: estado === ESTADO_AGUARDANDO ? undefined : ESTADO_AGUARDANDO })}
        >
          Aguardando humano
          <span className={cn("rounded-full px-1.5 text-xs", aguardando > 0 ? "bg-amber-500 text-black" : "bg-muted text-muted-foreground")}>
            {aguardando}
          </span>
        </Button>
        <label className="flex items-center gap-1 text-xs">
          Estado
          <select className={selectCls} value={estado ?? ""} onChange={(e) => mudar({ estado: e.target.value || undefined })}>
            <option value="">Todos</option>
            {ESTADOS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs">
          Prioridade
          <select
            className={selectCls}
            value={prioridade ?? ""}
            onChange={(e) => mudar({ prioridade: (e.target.value || undefined) as SearchRaiz["prioridade"] })}
          >
            <option value="">Todas</option>
            {NIVEIS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {contexto && (
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={subcontextos !== false}
              onChange={(e) => mudar({ subcontextos: e.target.checked ? undefined : false })}
            />
            Incluir sub-Contextos
          </label>
        )}
        <Button size="sm" className="ml-auto" onClick={() => setCriando(true)}>
          <PlusIcon /> Nova Tarefa
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {grupos.map((g) => {
          const { icone: Icone, cor } = aparenciaEstado(g.estado);
          return (
            <section key={g.estado} aria-label={g.estado} className="mb-3">
              <h3 className="flex items-center gap-2 px-2 py-1 text-xs font-semibold text-muted-foreground">
                <Icone className={cn("size-3.5", cor)} aria-hidden />
                {g.estado}
                <span className="font-normal">{g.tarefas.length}</span>
              </h3>
              <ul>
                {g.tarefas.map((t) => (
                  <Linha
                    key={t.id}
                    tarefa={t}
                    aberta={t.id === aberta}
                    aoAbrir={() => mudar({ tarefa: t.id })}
                    filhas={filhasDe(t)}
                    abertaId={aberta}
                    aoAbrirId={(id) => mudar({ tarefa: id })}
                  />
                ))}
              </ul>
            </section>
          );
        })}
        {!isPending && grupos.length === 0 && <p className="p-2 text-sm text-muted-foreground">Nenhuma Tarefa encontrada.</p>}
      </div>
      <TarefaForm key={criando ? (contexto ?? "") : "fechado"} open={criando} onOpenChange={setCriando} arvore={arvore} contextoInicial={contexto} />
    </section>
  );
}
