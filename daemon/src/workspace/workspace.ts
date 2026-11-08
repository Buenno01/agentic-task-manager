import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";

/**
 * Workspace = git worktree de um clone mantido no volume `atm-repos` (ADR-0002, ADR-0006).
 * - Exploração: worktree destacado e SOMENTE LEITURA (permissões de arquivo removidas).
 * - Execução: worktree na branch `atm/<tarefa-id>`, gravável; a branch sobrevive à remoção do worktree.
 * - Repositórios de consulta: worktrees somente leitura, em `<tarefa>/consulta/<nome>`.
 * Sem repositório configurado no Contexto, o Workspace é um repositório git vazio e gravável.
 */
const exec = promisify(execFile);

export type TipoWorkspace = "Exploração" | "Execução";

export interface PedidoWorkspace {
  tarefaId: string;
  tipo: TipoWorkspace;
  /** URL (ou caminho) do repositório principal; `null` = sem repositório. */
  repositorio: string | null;
  /** Repositórios de consulta (somente leitura). */
  consulta?: string[];
}

export interface WorkspacePreparado {
  /** Diretório de trabalho da Rodada. */
  dir: string;
  /** Branch de trabalho (`atm/<tarefa-id>`) na Execução; `null` na Exploração. */
  branch: string | null;
  somenteLeitura: boolean;
  repositorio: string | null;
  consulta: { nome: string; repositorio: string; dir: string }[];
}

export class ErroWorkspace extends Error {}

export const ramoDaTarefa = (tarefaId: string) => `atm/${tarefaId}`;

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new ErroWorkspace(`git ${args[0]} falhou: ${(err.stderr || err.message).trim()}`);
  }
}

/** Remove (recursivamente) a escrita; mantém leitura e travessia. */
function travar(dir: string) {
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) travar(p);
    else chmodSync(p, st.mode & 0o555);
  }
  chmodSync(dir, lstatSync(dir).mode & 0o555);
}

/** Devolve a escrita a uma árvore travada (remoção/limpeza e testes). */
export function destravar(dir: string) {
  if (!existsSync(dir)) return;
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) return;
  if (!st.isDirectory()) {
    chmodSync(dir, st.mode | 0o200);
    return;
  }
  chmodSync(dir, st.mode | 0o700);
  for (const nome of readdirSync(dir)) destravar(join(dir, nome));
}

const slugDe = (url: string) =>
  `${basename(url.replace(/\/+$/, "").replace(/\.git$/, "")).replace(/[^\w.-]/g, "_") || "repo"}-${createHash("sha1").update(url).digest("hex").slice(0, 10)}`;

export function criarWorkspaces(cfg: { reposDir: string; workspacesDir: string }) {
  // Operações no mesmo clone são serializadas (git não gosta de worktree/fetch concorrentes).
  const filas = new Map<string, Promise<unknown>>();
  function serial<T>(chave: string, fn: () => Promise<T>): Promise<T> {
    const r = (filas.get(chave) ?? Promise.resolve()).catch(() => {}).then(fn);
    filas.set(chave, r);
    return r;
  }

  /** Garante o clone (bare) em `atm-repos`, atualiza e devolve o diretório e a ref da branch padrão. */
  async function clone(url: string): Promise<{ dir: string; base: string }> {
    const dir = join(cfg.reposDir, `${slugDe(url)}.git`);
    return serial(dir, async () => {
      if (!existsSync(join(dir, "HEAD"))) {
        mkdirSync(cfg.reposDir, { recursive: true });
        try {
          await git(cfg.reposDir, ["clone", "--bare", "--quiet", "--", url, dir]);
        } catch (e) {
          rmSync(dir, { recursive: true, force: true });
          throw new ErroWorkspace(`Não foi possível clonar o repositório "${url}": ${(e as Error).message}`);
        }
        await git(dir, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
        await git(dir, ["config", "user.name", "atm"]);
        await git(dir, ["config", "user.email", "atm@atm.local"]);
      }
      // Sem rede/remoto o clone existente continua utilizável.
      await git(dir, ["fetch", "--quiet", "--prune", "origin"]).catch(() => {});
      const padrao = (await git(dir, ["symbolic-ref", "--short", "HEAD"])).trim();
      const base = `refs/remotes/origin/${padrao}`;
      const ok = await git(dir, ["rev-parse", "--verify", "--quiet", base]).catch(() => "");
      if (!ok) throw new ErroWorkspace(`Repositório "${url}" sem a branch padrão "${padrao}" (vazio?)`);
      return { dir, base };
    });
  }

  const ehWorktree = (dir: string) => existsSync(join(dir, ".git"));

  async function removerWorktree(repoDir: string, dir: string) {
    destravar(dir);
    await serial(repoDir, async () => {
      await git(repoDir, ["worktree", "remove", "--force", dir]).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
      await git(repoDir, ["worktree", "prune"]).catch(() => {});
    });
  }

  async function worktreeLeitura(url: string, dir: string) {
    const c = await clone(url);
    if (ehWorktree(dir)) await removerWorktree(c.dir, dir); // sempre recria a partir da base atual
    mkdirSync(join(dir, ".."), { recursive: true });
    await serial(c.dir, () => git(c.dir, ["worktree", "add", "--detach", "--quiet", dir, c.base]));
    travar(dir);
  }

  async function worktreeExecucao(url: string, dir: string, ramo: string) {
    const c = await clone(url);
    if (ehWorktree(dir)) return; // retomada: o Workspace preservado continua valendo
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, ".."), { recursive: true });
    await serial(c.dir, async () => {
      const existe = await git(c.dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${ramo}`]).catch(() => "");
      if (existe) await git(c.dir, ["worktree", "add", "--quiet", dir, ramo]);
      else await git(c.dir, ["worktree", "add", "--quiet", "-b", ramo, dir, c.base]);
    });
  }

  async function vazio(dir: string) {
    if (ehWorktree(dir)) return;
    mkdirSync(dir, { recursive: true });
    await git(dir, ["init", "--quiet"]);
    await git(dir, ["-c", "user.name=atm", "-c", "user.email=atm@atm.local", "commit", "--quiet", "--allow-empty", "-m", "início"]);
  }

  return {
    /** Prepara (ou reaproveita) o Workspace da Tarefa para o tipo de Rodada pedido. */
    async preparar(p: PedidoWorkspace): Promise<WorkspacePreparado> {
      const base = join(cfg.workspacesDir, p.tarefaId);
      const exec_ = p.tipo === "Execução";
      const dir = join(base, exec_ ? "execucao" : "exploracao");
      const consulta: WorkspacePreparado["consulta"] = [];
      let branch: string | null = null;
      if (!p.repositorio) await vazio(dir);
      else if (exec_) {
        branch = ramoDaTarefa(p.tarefaId);
        await worktreeExecucao(p.repositorio, dir, branch);
      } else await worktreeLeitura(p.repositorio, dir);
      const usados = new Set<string>();
      for (const url of p.consulta ?? []) {
        if (url === p.repositorio) continue;
        let nome = slugDe(url).replace(/-[0-9a-f]{10}$/, "");
        if (usados.has(nome)) nome = slugDe(url);
        usados.add(nome);
        const alvo = join(base, "consulta", nome);
        await worktreeLeitura(url, alvo);
        consulta.push({ nome, repositorio: url, dir: alvo });
      }
      return { dir, branch, somenteLeitura: !exec_ && !!p.repositorio, repositorio: p.repositorio, consulta };
    },

    /** Remove os worktrees da Tarefa (a branch `atm/<tarefa-id>` é preservada). */
    async remover(tarefaId: string): Promise<void> {
      const base = join(cfg.workspacesDir, tarefaId);
      const dirs = [join(base, "exploracao"), join(base, "execucao")];
      const consultaDir = join(base, "consulta");
      if (existsSync(consultaDir)) for (const n of readdirSync(consultaDir)) dirs.push(join(consultaDir, n));
      for (const d of dirs) {
        if (!ehWorktree(d)) continue;
        const repoDir = (await git(d, ["rev-parse", "--git-common-dir"]).catch(() => "")) as string;
        if (repoDir) await removerWorktree(repoDir.startsWith("/") ? repoDir : join(d, repoDir), d);
      }
      destravar(base);
      rmSync(base, { recursive: true, force: true });
    },
  };
}

export type Workspaces = ReturnType<typeof criarWorkspaces>;
