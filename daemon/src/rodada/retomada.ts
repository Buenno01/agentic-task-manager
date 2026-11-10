import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Checkpoint } from "../db/rodadas.ts";
import type { TipoRodada } from "../executor/executor.ts";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return "";
  }
}

/** HEAD do Workspace (gravado pelo sistema em todo Checkpoint); null se não houver commit/repositório. */
export async function headSha(dir: string): Promise<string | null> {
  return (await git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"])).trim() || null;
}

/** Arquivos alterados desde `sha` (commits, mudanças não commitadas e arquivos novos).
 * Sem `sha`, considera os commits que ainda não estão em nenhum remoto (o trabalho feito no Workspace). */
export async function arquivosAlteradosDesde(dir: string, sha: string | null): Promise<string[]> {
  const out = new Set<string>();
  if (sha) {
    for (const l of (await git(dir, ["diff", "--name-only", sha])).split("\n")) if (l) out.add(l);
  } else {
    for (const l of (await git(dir, ["log", "--name-only", "--format=", "HEAD", "--not", "--remotes"])).split("\n")) if (l) out.add(l);
  }
  for (const l of (await git(dir, ["status", "--porcelain", "-uall"])).split("\n")) if (l.trim()) out.add(l.slice(3));
  return [...out].sort();
}

const LIMITE_DIFF = 20_000;

/** Diff do Workspace contra `sha` (inclui o que ainda não foi commitado). */
export async function diffDesde(dir: string, sha: string): Promise<string> {
  const d = await git(dir, ["diff", sha]);
  return d.length > LIMITE_DIFF ? `${d.slice(0, LIMITE_DIFF)}\n[... diff truncado em ${LIMITE_DIFF} caracteres]` : d;
}

export interface EntradaPrompt {
  tipo: TipoRodada;
  tarefa: { id: string; title: string; description: string };
  /** Checkpoints da Tarefa (todas as Rodadas), do mais antigo ao mais recente. */
  checkpoints: Checkpoint[];
  /** Texto do Contexto consolidado vigente ("" se não houver). */
  consolidado: string;
  /** Diff do Workspace desde o SHA de referência ("" se não houver). */
  diff: string;
  /** Arquivos alterados/novos no Workspace desde o SHA de referência. */
  arquivos: string[];
}

/** Checkpoint de referência da retomada: o último gravado pelo agente; sem ele, o último automático. */
export function checkpointDeReferencia(cps: Checkpoint[]): Checkpoint | undefined {
  return [...cps].reverse().find((c) => c.origem === "agente") ?? cps[cps.length - 1];
}

const lista = (itens: string[]) => (itens.length ? itens.map((i) => `- ${i}`).join("\n") : "- (nenhum)");

/**
 * Prompt da Rodada (ADR-0004). Primeira Rodada: só a Tarefa e o Contexto consolidado.
 * Retomada: o último Checkpoint, o diff desde o SHA e o Contexto consolidado.
 * Sem Checkpoint, recomeça do zero, mas o Workspace é preservado.
 */
export function montarPrompt(e: EntradaPrompt): string {
  const ref = checkpointDeReferencia(e.checkpoints);
  const partes = [
    `# Tarefa ${e.tarefa.id}: ${e.tarefa.title}`,
    e.tarefa.description,
    `Rodada de ${e.tipo}. Use as ferramentas MCP checkpoint, perguntar e entregar.`,
    `## Contexto consolidado\n${e.consolidado.trim() || "(vazio)"}`,
  ];
  if (!e.checkpoints.length) {
    if (e.arquivos.length)
      partes.push(
        `## Retomada\nSem Checkpoint anterior: recomece do zero. O Workspace foi preservado e já tem alterações; confira o estado antes de refazer.\nArquivos alterados:\n${lista(e.arquivos)}`,
      );
    return partes.join("\n\n");
  }
  const r = ref!;
  const ultimo = e.checkpoints[e.checkpoints.length - 1];
  partes.push(
    [
      `## Retomada a partir do último Checkpoint (${r.origem}, SHA ${r.sha ?? "desconhecido"})`,
      `Progresso: ${r.progresso ?? "(sem anotação do agente; Checkpoint automático)"}`,
      `Decisões:\n${lista(r.decisoes)}`,
      `Arquivos tocados:\n${lista(r.arquivosTocados.length ? r.arquivosTocados : ultimo.arquivosTocados)}`,
      `Próximos passos:\n${lista(r.proximosPassos)}`,
      `## Diff desde o SHA ${r.sha ?? ""}\n${e.diff.trim() || "(sem alterações)"}`,
      ...(e.arquivos.length ? [`Arquivos alterados desde o SHA:\n${lista(e.arquivos)}`] : []),
    ].join("\n\n"),
  );
  return partes.join("\n\n");
}
