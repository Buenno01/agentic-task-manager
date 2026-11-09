import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@/App";

describe("tema", () => {
  it("abre escuro por padrão e o toggle alterna para claro e persiste a preferência", async () => {
    render(<App />);
    expect(document.documentElement).toHaveClass("dark");

    await userEvent.click(screen.getByRole("button", { name: /alternar tema/i }));

    expect(document.documentElement).not.toHaveClass("dark");
    expect(localStorage.getItem("atm-tema")).toBe("claro");
  });

  it("restaura a preferência salva ao abrir", () => {
    localStorage.setItem("atm-tema", "claro");
    render(<App />);
    expect(document.documentElement).not.toHaveClass("dark");
  });
});
