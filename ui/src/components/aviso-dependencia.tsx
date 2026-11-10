import { LinkIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { DependenciaPendente } from "@/lib/api-subtarefas";

/** Aviso brando de Dependência pendente: ícone com tooltip. Informa, nunca bloqueia nem intercepta cliques da linha. */
export function AvisoDependencia({ titulo, pendentes }: { titulo: string; pendentes: DependenciaPendente[] }) {
  if (pendentes.length === 0) return null;
  const texto = `Depende de ${pendentes.map((p) => `${p.title} (${p.state})`).join("; ")}`;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`Dependência pendente: ${titulo}`}
            className="flex h-6 shrink-0 items-center rounded px-1 text-amber-500 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <LinkIcon className="size-3.5" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent>{texto}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
