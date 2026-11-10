import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTema } from "@/lib/theme";

export function ThemeToggle() {
  const { tema, alternar } = useTema();
  return (
    <Button variant="ghost" size="icon" onClick={alternar} aria-label="Alternar tema">
      {tema === "escuro" ? <Sun /> : <Moon />}
    </Button>
  );
}
