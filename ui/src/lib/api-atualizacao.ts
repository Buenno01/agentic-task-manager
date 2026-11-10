import { api } from "@/lib/api";

// Espelha daemon/src/api/atualizacao.ts (só humano). Só transporte: sem regra de negócio.
export interface UltimaAtualizacao {
  resultado: "sucesso" | "erro" | "rollback" | "erro_rollback";
  tag_de: string;
  tag_para: string;
  motivo: string;
  em: string;
  versao_rodando: string;
  backup: string;
}
export interface EstadoAtualizacao {
  versao: string | null;
  configurada: boolean;
  estado: "disponivel" | "indisponivel";
  pedidoPendente: boolean;
  ultima: UltimaAtualizacao | null;
}

export const estadoAtualizacao = () => api<EstadoAtualizacao>("/atualizacao");
export const pedirAtualizacao = () => api<{ aceito: boolean; jaPendente: boolean }>("/atualizacao/pedido", { method: "POST" });
