/** Slot do painel de detalhe da Tarefa (`?tarefa=<id>`). O ticket 05 substitui o corpo deste componente. */
export function DetalheTarefa({ id }: { id: string }) {
  return (
    <section aria-label="Detalhe da Tarefa" className="p-4 text-sm text-muted-foreground">
      Tarefa {id}
    </section>
  );
}
