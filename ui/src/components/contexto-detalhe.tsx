import { useConsolidado, useContextoResolvido } from "@/lib/queries";

/** Contexto consolidado e configuração herdada do nó selecionado (a resolução é do daemon). */
export function ContextoDetalhe({ id }: { id: string }) {
  const resolvido = useContextoResolvido(id);
  const consolidado = useConsolidado(id);
  const r = resolvido.data;
  const c = consolidado.data;
  return (
    <section aria-label="Contexto selecionado" className="grid gap-4 p-4 text-sm">
      {r && (
        <>
          <h2 className="text-base font-semibold">{r.path.map((p) => p.name).join(" › ")}</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Repositório</dt>
            <dd>{r.repository ?? "—"}</dd>
            <dt className="text-muted-foreground">Comandos de teste</dt>
            <dd>{r.testCommands?.length ? r.testCommands.join("; ") : "—"}</dd>
            <dt className="text-muted-foreground">Limite de concorrência</dt>
            <dd>{r.concurrencyLimit ?? "—"}</dd>
          </dl>
        </>
      )}
      <div>
        <h3 className="mb-1 font-medium">
          Contexto consolidado {c && c.version > 0 && <span className="text-xs text-muted-foreground">(versão {c.version})</span>}
        </h3>
        {c && (c.text ? <p className="whitespace-pre-wrap">{c.text}</p> : <p className="text-muted-foreground">Ainda não há Contexto consolidado.</p>)}
      </div>
    </section>
  );
}
