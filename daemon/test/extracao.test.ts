import { test } from "node:test";
import assert from "node:assert/strict";
import { extrairTexto } from "../src/domain/extracao.ts";
import { docx, pdf } from "./fixtures.ts";

test("txt e md: texto direto", () => {
  assert.equal(extrairTexto("nota.txt", Buffer.from("olá mundo")), "olá mundo");
  assert.equal(extrairTexto("LEIAME.MD", Buffer.from("# Título")), "# Título");
});

test("docx: texto dos parágrafos de word/document.xml", () => {
  const t = extrairTexto("spec.docx", docx(["Contrato de licença", "Cláusula &amp; prazo"]));
  assert.match(t!, /Contrato de licença/);
  assert.match(t!, /Cláusula & prazo/);
});

test("pdf: texto de streams Flate e não comprimidos, com escapes", () => {
  const a = extrairTexto("a.pdf", pdf(["Relatório trimestral", "valor (R$ 10)"]));
  assert.match(a!, /Relatório trimestral/);
  assert.match(a!, /valor \(R\$ 10\)/);
  assert.match(extrairTexto("b.pdf", pdf(["sem compressão"], false))!, /sem compressão/);
});

test("pdf: operador TJ com arrays", () => {
  const bruto = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length 40 >>\nstream\nBT [(Ola) -20 (Mundo)] TJ ET\nendstream\nendobj\n");
  assert.match(extrairTexto("c.pdf", bruto)!, /OlaMundo/);
});

test("imagens, planilhas e formatos desconhecidos: sem extração", () => {
  assert.equal(extrairTexto("foto.png", Buffer.from([0x89, 0x50])), null);
  assert.equal(extrairTexto("tabela.xlsx", Buffer.from("x")), null);
  assert.equal(extrairTexto("x.bin", Buffer.from("x")), null);
});

test("arquivo corrompido não lança: sem texto", () => {
  assert.equal(extrairTexto("ruim.docx", Buffer.from("não é zip")), null);
  assert.equal(extrairTexto("ruim.pdf", Buffer.from("não é pdf")), "");
});
