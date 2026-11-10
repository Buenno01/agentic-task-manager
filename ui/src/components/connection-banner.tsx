import { WifiOff } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useSessao } from "@/lib/api-provider";

export function ConnectionBanner() {
  const { offline } = useSessao();
  if (!offline) return null;
  return (
    <Alert variant="destructive" className="m-6 w-auto">
      <WifiOff />
      <AlertTitle>API indisponível</AlertTitle>
      <AlertDescription>Não foi possível conectar à API. Tentando novamente a cada 5 s.</AlertDescription>
    </Alert>
  );
}
