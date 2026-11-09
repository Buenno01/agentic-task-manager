import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSessao } from "@/lib/api-provider";

/** Aberto enquanto não há token aceito; sem fechar por fora (a UI não funciona sem ele). */
export function TokenDialog() {
  const { temToken, recusado, salvarToken } = useSessao();
  const [valor, setValor] = useState("");
  return (
    <Dialog open={!temToken}>
      <DialogContent showCloseButton={false} onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valor.trim()) {
              salvarToken(valor);
              setValor("");
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Token de acesso</DialogTitle>
            <DialogDescription>
              {recusado
                ? "Token recusado pela API. Confira o valor e informe novamente."
                : "Informe o token do humano para falar com a API. Ele fica salvo neste navegador."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="token">Token</Label>
            <Input id="token" type="password" autoComplete="off" value={valor} onChange={(e) => setValor(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!valor.trim()}>Salvar</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
