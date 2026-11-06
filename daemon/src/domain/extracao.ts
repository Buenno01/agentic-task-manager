import { inflateRawSync, inflateSync } from "node:zlib";

/**
 * Extração de texto de anexos para indexação (RF13), sem dependências externas.
 * Devolve null quando o formato não tem extração (imagens, planilhas, desconhecidos).
 *
 * Limitações (melhor esforço):
 * - PDF: só lê operadores Tj/TJ/'/" de streams (Flate ou sem filtro). Fontes com
 *   codificação própria (Identity-H/CID, subconjuntos com ToUnicode), PDFs
 *   escaneados (imagem), streams em ObjStm e PDFs criptografados rendem texto vazio
 *   ou parcial.
 * - docx: só word/document.xml (corpo); cabeçalhos, rodapés e notas ficam de fora.
 */
export function extrairTexto(nome: string, dados: Buffer): string | null {
  const ext = nome.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  try {
    if (ext === "txt" || ext === "md") return dados.toString("utf8");
    if (ext === "docx") return textoDocx(dados);
    if (ext === "pdf") return textoPdf(dados);
  } catch {
    return ext === "pdf" ? "" : null;
  }
  return null;
}

// ---------- docx ----------

function entradaZip(zip: Buffer, nome: string): Buffer | null {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--)
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) return null;
  const total = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let k = 0; k < total; k++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return null;
    const metodo = zip.readUInt16LE(p + 10);
    const tamComp = zip.readUInt32LE(p + 20);
    const nLen = zip.readUInt16LE(p + 28);
    const extra = zip.readUInt16LE(p + 30);
    const com = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    if (zip.toString("utf8", p + 46, p + 46 + nLen) === nome) {
      const ini = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const bruto = zip.subarray(ini, ini + tamComp);
      if (metodo === 0) return bruto;
      if (metodo === 8) return inflateRawSync(bruto);
      return null;
    }
    p += 46 + nLen + extra + com;
  }
  return null;
}

const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodificarXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTIDADES[e] ?? m;
  });

function textoDocx(dados: Buffer): string | null {
  const xml = entradaZip(dados, "word/document.xml")?.toString("utf8");
  if (xml === undefined) return null;
  let out = "";
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<\/w:p>/g)) {
    if (m[1] !== undefined) out += decodificarXml(m[1]);
    else out += m[0] === "<w:tab/>" ? "\t" : "\n";
  }
  return out.trim();
}

// ---------- pdf ----------

function decodificarBytes(b: number[]): string {
  const buf = Buffer.from(b);
  if (buf[0] === 0xfe && buf[1] === 0xff) return buf.subarray(2).swap16().toString("utf16le");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return buf.toString("latin1");
  }
}

const ESCAPES: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };

/** Extrai texto de um content stream PDF (operadores de texto). */
function textoConteudo(c: string): string {
  let out = "";
  let pend = "";
  let i = 0;
  const fimLinha = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  while (i < c.length) {
    const ch = c[i];
    if (ch === "(") {
      const bytes: number[] = [];
      let nivel = 1;
      i++;
      while (i < c.length && nivel > 0) {
        const x = c[i];
        if (x === "\\") {
          const n = c[i + 1] ?? "";
          if (/[0-7]/.test(n)) {
            const o = c.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)![0];
            bytes.push(parseInt(o, 8) & 255);
            i += 1 + o.length;
            continue;
          }
          if (n === "\n") i += 2;
          else if (n === "\r") i += c[i + 2] === "\n" ? 3 : 2;
          else {
            bytes.push(ESCAPES[n] ?? n.charCodeAt(0));
            i += 2;
          }
          continue;
        }
        if (x === "(") nivel++;
        else if (x === ")" && --nivel === 0) break;
        // c vem de latin1: cada char é um byte
        bytes.push(x.charCodeAt(0) & 255);
        i++;
      }
      i++;
      pend += decodificarBytes(bytes);
    } else if (ch === "<" && c[i + 1] !== "<") {
      const fim = c.indexOf(">", i);
      if (fim < 0) break;
      const hex = c.slice(i + 1, fim).replace(/\s/g, "");
      // Só hex UTF-16BE com BOM é legível; glifos de fontes custom (Identity-H) são ignorados.
      if (/^feff/i.test(hex) && hex.length % 2 === 0) pend += decodificarBytes([...Buffer.from(hex, "hex")]);
      i = fim + 1;
    } else if (ch === "<" || ch === ">") {
      i += 2; // << ou >>
    } else if (ch === "[" || ch === "]") {
      i++;
    } else if (ch === "%") {
      while (i < c.length && c[i] !== "\n" && c[i] !== "\r") i++;
    } else if (/[-+.\d]/.test(ch)) {
      const m = c.slice(i).match(/^[-+]?\d*\.?\d*/)![0];
      if (pend && Number(m) < -200) pend += " "; // kerning grande dentro de TJ = espaço
      i += m.length || 1;
    } else if (/[A-Za-z'"*]/.test(ch)) {
      const op = c.slice(i).match(/^[A-Za-z'"*0-9]+/)?.[0] ?? ch;
      i += op.length;
      if (op === "Tj" || op === "TJ" || op === "'" || op === '"') {
        if (op === "'" || op === '"') fimLinha();
        out += pend;
        pend = "";
      } else if (op === "T*" || op === "Td" || op === "TD" || op === "ET" || op === "Tm") {
        pend = "";
        fimLinha();
      } else if (op !== "BT") pend = "";
    } else if (ch === "/") {
      i++;
      while (i < c.length && !/[\s()<>[\]/%]/.test(c[i])) i++;
    } else i++;
  }
  return out.trim();
}

function textoPdf(dados: Buffer): string {
  const s = dados.toString("latin1");
  const partes: string[] = [];
  for (const m of s.matchAll(/(?<!end)stream\r?\n/g)) {
    const ini = m.index + m[0].length;
    const fim = s.indexOf("endstream", ini);
    if (fim < 0) break;
    const dict = s.slice(Math.max(0, s.lastIndexOf("<<", m.index) ), m.index);
    let corpo = dados.subarray(ini, fim);
    if (dict.includes("FlateDecode")) {
      try {
        corpo = inflateSync(corpo);
      } catch {
        continue;
      }
    } else if (/\/Filter/.test(dict)) continue; // filtros não suportados (LZW, DCT, ...)
    if (!/\b(Tj|TJ)\b/.test(corpo.toString("latin1"))) continue;
    const t = textoConteudo(corpo.toString("latin1"));
    if (t) partes.push(t);
  }
  return partes.join("\n");
}
