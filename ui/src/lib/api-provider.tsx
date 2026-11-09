import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { MissingTokenError, NetworkError, clearToken, getToken, isUnauthorized, saveToken } from "@/lib/api";

export const POLLING_MS = 5000;

/** Defaults de dados: polling de 5 s, pausado com a aba oculta; sem retry (o polling já retenta). */
export function createQueryClient(
  opts: { refetchIntervalMs?: number; onError?: (e: unknown) => void; onSuccess?: () => void } = {},
) {
  return new QueryClient({
    queryCache: new QueryCache({ onError: (e) => opts.onError?.(e), onSuccess: () => opts.onSuccess?.() }),
    mutationCache: new MutationCache({ onError: (e) => opts.onError?.(e), onSuccess: () => opts.onSuccess?.() }),
    defaultOptions: {
      queries: {
        refetchInterval: opts.refetchIntervalMs ?? POLLING_MS,
        refetchIntervalInBackground: false,
        retry: false,
      },
    },
  });
}

interface Sessao {
  /** Há token salvo e aceito até agora. */
  temToken: boolean;
  /** O último pedido foi recusado com 401. */
  recusado: boolean;
  /** A API não respondeu no último pedido. */
  offline: boolean;
  salvarToken: (t: string) => void;
}
const Ctx = createContext<Sessao | null>(null);
export const useSessao = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSessao fora do ApiProvider");
  return c;
};

export function ApiProvider({ children, refetchIntervalMs }: { children: ReactNode; refetchIntervalMs?: number }) {
  const [token, setToken] = useState(getToken);
  const [recusado, setRecusado] = useState(false);
  const [offline, setOffline] = useState(false);
  const clientRef = useRef<QueryClient>(null);
  clientRef.current ??= createQueryClient({
    refetchIntervalMs,
    onError: (e) => {
      if (isUnauthorized(e)) {
        clearToken();
        setToken(null);
        setRecusado(true);
      } else if (e instanceof NetworkError) setOffline(true);
      else if (e instanceof MissingTokenError) setToken(null);
    },
    onSuccess: () => {
      setOffline(false);
      setRecusado(false);
    },
  });
  const client = clientRef.current;
  const sessao = useMemo<Sessao>(
    () => ({
      temToken: !!token,
      recusado,
      offline,
      salvarToken: (t) => {
        saveToken(t.trim());
        setToken(t.trim());
        setRecusado(false);
        void client.invalidateQueries();
      },
    }),
    [token, recusado, offline, client],
  );
  return (
    <QueryClientProvider client={client}>
      <Ctx.Provider value={sessao}>{children}</Ctx.Provider>
    </QueryClientProvider>
  );
}
