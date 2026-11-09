import { Link } from "@tanstack/react-router";
import type { ContextoNo } from "@/lib/api";
import { cn } from "@/lib/utils";

function No({ no, nivel, selecionado, aoEscolher }: { no: ContextoNo; nivel: number; selecionado?: string; aoEscolher?: () => void }) {
  const ativo = no.id === selecionado;
  return (
    <li>
      <Link
        to="/"
        search={{ contexto: no.id }}
        
        onClick={aoEscolher}
        style={{ paddingLeft: `${0.5 + nivel * 0.9}rem` }}
        className={cn("flex items-center gap-2 rounded-md py-1.5 pr-2 text-sm hover:bg-accent", ativo && "bg-accent font-medium")}
      >
        <span className="truncate">{no.name}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{no.kind}</span>
      </Link>
      {no.children.length > 0 && (
        <ul>
          {no.children.map((f) => (
            <No key={f.id} no={f} nivel={nivel + 1} selecionado={selecionado} aoEscolher={aoEscolher} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Árvore de Contextos; a seleção vive na URL (?contexto=id). */
export function ArvoreContextos({ nos, selecionado, aoEscolher }: { nos: ContextoNo[]; selecionado?: string; aoEscolher?: () => void }) {
  return (
    <nav aria-label="Contextos">
      <ul>
        <li>
          <Link
            to="/"
            search={{}}
            onClick={aoEscolher}
            className={cn("flex rounded-md px-2 py-1.5 text-sm hover:bg-accent", !selecionado && "bg-accent font-medium")}
          >
            Todos os Contextos
          </Link>
        </li>
        {nos.map((n) => (
          <No key={n.id} no={n} nivel={0} selecionado={selecionado} aoEscolher={aoEscolher} />
        ))}
      </ul>
      {nos.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">Nenhum Contexto ainda.</p>}
    </nav>
  );
}
