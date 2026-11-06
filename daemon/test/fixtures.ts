import { crc32, deflateRawSync, deflateSync } from "node:zlib";

/** Monta um .zip mínimo (um arquivo por entrada, deflate) para fixtures de .docx. */
export function zip(arquivos: Record<string, string>): Buffer {
  const locais: Buffer[] = [];
  const centrais: Buffer[] = [];
  let offset = 0;
  for (const [nome, texto] of Object.entries(arquivos)) {
    const n = Buffer.from(nome);
    const bruto = Buffer.from(texto);
    const comp = deflateRawSync(bruto);
    const crc = crc32(bruto);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0);
    l.writeUInt16LE(20, 4);
    l.writeUInt16LE(8, 8);
    l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(comp.length, 18);
    l.writeUInt32LE(bruto.length, 22);
    l.writeUInt16LE(n.length, 26);
    const local = Buffer.concat([l, n, comp]);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(bruto.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    centrais.push(Buffer.concat([c, n]));
    locais.push(local);
    offset += local.length;
  }
  const dirCentral = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(centrais.length, 8);
  fim.writeUInt16LE(centrais.length, 10);
  fim.writeUInt32LE(dirCentral.length, 12);
  fim.writeUInt32LE(offset, 16);
  return Buffer.concat([...locais, dirCentral, fim]);
}

export function docx(paragrafos: string[]): Buffer {
  const corpo = paragrafos.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("");
  return zip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": `<?xml version="1.0"?><w:document><w:body>${corpo}</w:body></w:document>`,
  });
}

/** PDF mínimo com um stream de conteúdo (comprimido com Flate ou não). */
export function pdf(linhas: string[], comprimir = true): Buffer {
  const conteudo = Buffer.from(
    "BT /F1 12 Tf " + linhas.map((l) => `(${l.replace(/[()\\]/g, "\\$&")}) Tj T*`).join(" ") + " ET",
  );
  const stream = comprimir ? deflateSync(conteudo) : conteudo;
  const filtro = comprimir ? " /Filter /FlateDecode" : "";
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n2 0 obj\n"),
    Buffer.from(`<< /Length ${stream.length}${filtro} >>\nstream\n`),
    stream,
    Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"),
  ]);
}
