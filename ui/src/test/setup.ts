import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./server";

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
// jsdom não tem estas APIs; o cmdk (command palette) precisa delas.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= () => {};
afterEach(() => {
  cleanup();
  server.resetHandlers();
  localStorage.clear();
  document.documentElement.className = "";
});
afterAll(() => server.close());
