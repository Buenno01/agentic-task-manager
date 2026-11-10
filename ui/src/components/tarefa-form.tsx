import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ContextoNo } from "@/lib/api";
import { useCriarTarefa } from "@/lib/queries";

const selectCls = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm dark:bg-input/30";

function achatar(nos: ContextoNo[], nivel = 0): { id: string; rotulo: string }[] {
  return nos.flatMap((n) => [{ id: n.id, rotulo: `${"— ".repeat(nivel)}${n.name}` }, ...achatar(n.children, nivel + 1)]);
}

/** Criação de Tarefa pela lista. Toda Tarefa nasce em Exploração, "Novo": a regra e a validação são do daemon. */
export function TarefaForm({
  open,
  onOpenChange,
  arvore,
  contextoInicial,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  arvore: ContextoNo[];
  contextoInicial?: string;
}) {
  const criar = useCriarTarefa();
  const [titulo, setTitulo] = useState("");
  const [descricao, setDescricao] = useState("");
  const [contexto, setContexto] = useState(contextoInicial ?? "");

  function enviar(e: React.FormEvent) {
    e.preventDefault();
    criar.mutate(
      { title: titulo, description: descricao, ...(contexto ? { contextId: contexto } : {}) },
      {
        onSuccess: () => {
          setTitulo("");
          setDescricao("");
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={enviar}>
          <DialogHeader>
            <DialogTitle>Nova Tarefa</DialogTitle>
            <DialogDescription>A Tarefa entra na Exploração, como "Novo".</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="tar-titulo">Título</Label>
            <Input id="tar-titulo" value={titulo} onChange={(e) => setTitulo(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tar-desc">Descrição</Label>
            <textarea
              id="tar-desc"
              rows={3}
              className="rounded-md border border-input bg-transparent px-3 py-2 text-sm dark:bg-input/30"
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tar-ctx">Contexto</Label>
            <select id="tar-ctx" className={selectCls} value={contexto} onChange={(e) => setContexto(e.target.value)}>
              <option value="">(nenhum)</option>
              {achatar(arvore).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.rotulo}
                </option>
              ))}
            </select>
          </div>
          {criar.error && (
            <p role="alert" className="text-sm text-destructive">
              {criar.error.message}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={criar.isPending}>
              Criar Tarefa
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
