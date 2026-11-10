import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TIPOS_CONTEXTO, type ContextoNo, type NovoContexto, type TipoContexto } from "@/lib/api";
import { useCriarContexto } from "@/lib/queries";

const campo = "grid gap-1.5";
const selectCls = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm dark:bg-input/30";

function achatar(nos: ContextoNo[], nivel = 0): { id: string; rotulo: string }[] {
  return nos.flatMap((n) => [{ id: n.id, rotulo: `${"— ".repeat(nivel)}${n.name}` }, ...achatar(n.children, nivel + 1)]);
}

/** Formulário de criação. Validação (nome, tipo, limite) é do daemon; o erro dele aparece aqui. */
export function ContextoForm({
  open,
  onOpenChange,
  arvore,
  paiInicial,
  aoCriar,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  arvore: ContextoNo[];
  paiInicial?: string;
  aoCriar?: (id: string) => void;
}) {
  const criar = useCriarContexto();
  const [nome, setNome] = useState("");
  const [tipo, setTipo] = useState<TipoContexto>("projeto");
  const [pai, setPai] = useState(paiInicial ?? "");
  const [repo, setRepo] = useState("");
  const [comandos, setComandos] = useState("");
  const [limite, setLimite] = useState("");
  const [instrucoes, setInstrucoes] = useState("");

  function enviar(e: React.FormEvent) {
    e.preventDefault();
    const corpo: NovoContexto = { name: nome, kind: tipo };
    if (pai) corpo.parentId = pai;
    if (repo.trim()) corpo.repository = repo;
    const cmds = comandos.split("\n").map((l) => l.trim()).filter(Boolean);
    if (cmds.length) corpo.testCommands = cmds;
    if (limite.trim()) corpo.concurrencyLimit = Number(limite);
    if (instrucoes.trim()) corpo.instructions = instrucoes;
    criar.mutate(corpo, {
      onSuccess: (c) => {
        onOpenChange(false);
        setNome("");
        setRepo("");
        setComandos("");
        setLimite("");
        setInstrucoes("");
        aoCriar?.(c.id);
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form className="grid gap-4" onSubmit={enviar}>
          <DialogHeader>
            <DialogTitle>Novo Contexto</DialogTitle>
            <DialogDescription>Filhos herdam do pai: configuração é sobrescrita, instruções se somam.</DialogDescription>
          </DialogHeader>
          <div className={campo}>
            <Label htmlFor="ctx-nome">Nome</Label>
            <Input id="ctx-nome" value={nome} onChange={(e) => setNome(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className={campo}>
              <Label htmlFor="ctx-tipo">Tipo</Label>
              <select id="ctx-tipo" className={selectCls} value={tipo} onChange={(e) => setTipo(e.target.value as TipoContexto)}>
                {TIPOS_CONTEXTO.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div className={campo}>
              <Label htmlFor="ctx-pai">Contexto pai</Label>
              <select id="ctx-pai" className={selectCls} value={pai} onChange={(e) => setPai(e.target.value)}>
                <option value="">(nenhum)</option>
                {achatar(arvore).map((o) => (
                  <option key={o.id} value={o.id}>{o.rotulo}</option>
                ))}
              </select>
            </div>
          </div>
          <div className={campo}>
            <Label htmlFor="ctx-repo">Repositório</Label>
            <Input id="ctx-repo" value={repo} onChange={(e) => setRepo(e.target.value)} />
          </div>
          <div className={campo}>
            <Label htmlFor="ctx-cmds">Comandos de teste (um por linha)</Label>
            <textarea id="ctx-cmds" rows={2} className="rounded-md border border-input bg-transparent px-3 py-2 text-sm dark:bg-input/30" value={comandos} onChange={(e) => setComandos(e.target.value)} />
          </div>
          <div className={campo}>
            <Label htmlFor="ctx-limite">Limite de concorrência</Label>
            <Input id="ctx-limite" type="number" min={1} value={limite} onChange={(e) => setLimite(e.target.value)} />
          </div>
          <div className={campo}>
            <Label htmlFor="ctx-instr">Instruções</Label>
            <textarea id="ctx-instr" rows={3} className="rounded-md border border-input bg-transparent px-3 py-2 text-sm dark:bg-input/30" value={instrucoes} onChange={(e) => setInstrucoes(e.target.value)} />
          </div>
          {criar.error && <p role="alert" className="text-sm text-destructive">{criar.error.message}</p>}
          <DialogFooter>
            <Button type="submit" disabled={criar.isPending}>Criar Contexto</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
