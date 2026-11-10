import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ModoEntrega } from "../domain/contexto.ts";

const exec = promisify(execFile);

/** Falha de entrega que o chamador devolve como 409 (sem token, sem repositório, push recusado...). */
export class ErroEntrega extends Error {}

export interface PedidoPr {
  repositorio: string;
  branch: string;
  base: string;
  titulo: string;
  corpo: string;
  /** Token de escopo mínimo (ADR-0001): push de branch e abrir PR; nunca merge. Não pode ir para a URL do remoto. */
  token: string;
  /** Diretório do Workspace (de onde sai o push). */
  workspace: string;
}

/** Cria o PR (e faz o push da branch) e devolve a URL. Injetável; o padrão fala com o GitHub. */
export type CriarPr = (p: PedidoPr) => Promise<{ url: string }>;

export interface Entrega {
  modo: ModoEntrega;
  branch: string;
  sha: string;
  prUrl: string | null;
}

export interface PedidoEntrega {
  tarefaId: string;
  titulo: string;
  resumo: string;
  workspace: string;
  repositorio: string | null;
  modo: ModoEntrega | null;
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-c", "user.name=atm", "-c", "user.email=atm@atm.local", ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    // O token nunca aparece em mensagens de erro.
    throw new ErroEntrega(`git ${args[0]} falhou: ${(err.stderr || err.message).trim()}`);
  }
}

/** `owner/repo` de uma URL do GitHub (https ou ssh). */
function repoGitHub(url: string): string {
  const m = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (!m) throw new ErroEntrega(`Repositório "${url}" não é do GitHub; use a entrega por branch local`);
  return m[1];
}

/** Padrão: push com GIT_ASKPASS (o token só vai no ambiente do processo git) e PR pela API do GitHub. */
export const criarPrGitHub: CriarPr = async (p) => {
  const slug = repoGitHub(p.repositorio);
  const dir = mkdtempSync(join(tmpdir(), "atm-askpass-"));
  try {
    const askpass = join(dir, "askpass.sh");
    writeFileSync(askpass, '#!/bin/sh\ncase "$1" in\n  Username*) echo x-access-token ;;\n  *) echo "$ATM_GIT_TOKEN" ;;\nesac\n');
    chmodSync(askpass, 0o700);
    await git(p.workspace, ["-c", "credential.helper=", "push", "--quiet", "origin", p.branch], {
      GIT_ASKPASS: askpass,
      ATM_GIT_TOKEN: p.token,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const r = await fetch(`https://api.github.com/repos/${slug}/pulls`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${p.token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "atm",
    },
    body: JSON.stringify({ title: p.titulo, head: p.branch, base: p.base, body: p.corpo }),
  });
  const corpo = (await r.json().catch(() => ({}))) as { html_url?: string; message?: string };
  if (!r.ok || !corpo.html_url) throw new ErroEntrega(`GitHub recusou o PR (${r.status}): ${corpo.message ?? "sem detalhe"}`);
  return { url: corpo.html_url };
};

export interface DepsEntrega {
  criarPr?: CriarPr;
  /** Token do GitHub (padrão: ATM_GITHUB_TOKEN). */
  token?: () => string | undefined;
}

/** Entrega da Execução: commita o que sobrou no Workspace e registra branch+SHA (local) ou abre PR. Nunca faz merge. */
export function criarEntrega(d: DepsEntrega = {}) {
  const criarPr = d.criarPr ?? criarPrGitHub;
  const token = d.token ?? (() => process.env.ATM_GITHUB_TOKEN);
  return async (p: PedidoEntrega): Promise<Entrega> => {
    const modo: ModoEntrega = p.modo ?? "branch-local";
    const tk = token()?.trim();
    if (modo === "pr") {
      if (!p.repositorio) throw new ErroEntrega("Entrega por PR exige repositório no Contexto");
      if (!tk) throw new ErroEntrega("Entrega por PR exige ATM_GITHUB_TOKEN (token de escopo mínimo, ADR-0001)");
    }
    if (await git(p.workspace, ["status", "--porcelain"])) {
      await git(p.workspace, ["add", "-A"]);
      await git(p.workspace, ["commit", "--quiet", "-m", `feat: ${p.titulo || p.tarefaId}`]);
    }
    const sha = await git(p.workspace, ["rev-parse", "HEAD"]);
    const branch = await git(p.workspace, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (modo === "branch-local") return { modo, branch, sha, prUrl: null };
    // Branch padrão = HEAD do clone (o worktree compartilha o git dir comum).
    const comum = resolve(p.workspace, await git(p.workspace, ["rev-parse", "--git-common-dir"]));
    const base = await git(comum, ["symbolic-ref", "--short", "HEAD"]).catch(() => "main");
    const { url } = await criarPr({
      repositorio: p.repositorio!,
      branch,
      base,
      titulo: p.titulo,
      corpo: p.resumo,
      token: tk!,
      workspace: p.workspace,
    });
    return { modo, branch, sha, prUrl: url };
  };
}
export type EntregarExecucao = ReturnType<typeof criarEntrega>;
