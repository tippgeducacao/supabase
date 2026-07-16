// Gera um PDF do conteúdo que o cérebro escreveu e ENVIA no WhatsApp do dono.
// pdf-lib = ESM puro (roda no Deno). NÃO há headless browser no edge, então o layout é
// montado à mão (quebra de linha/página manual) — simples e previsível.
import type { Ctx } from "./db.ts";
import { enviarDocumento } from "./wa.ts";
import { hojeSP, fmtData } from "./datas.ts";

// getPublicUrl dentro do container devolve o host INTERNO (kong:8000) — o WhatsApp não alcança.
// Mesma pegadinha do crm-webchat/whatsapp-send-media.
const PUBLIC_SUPABASE_URL = Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site";
const toPublicUrl = (u: string) => u.replace(/^https?:\/\/(supabase-)?kong:8000/i, PUBLIC_SUPABASE_URL);

/** As StandardFonts do pdf-lib são WinAnsi (Latin-1): acento PT-BR ok, emoji/travessão NÃO. */
function sanitize(s: string): string {
  return String(s || "")
    .replace(/[—–]/g, "-").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, "...")
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, ""); // fora do Latin-1 (emoji etc.) → remove
}

function slug(s: string): string {
  return (sanitize(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)) || "documento";
}

export async function gerarPdf(titulo: string, conteudo: string): Promise<Uint8Array> {
  // Import DINÂMICO de propósito: se o pdf-lib falhar em carregar no runtime do edge, só ESTA
  // ferramenta quebra (erro tratado) — um import no topo derrubaria o bot inteiro no boot.
  const { PDFDocument, StandardFonts, rgb } = await import("https://esm.sh/pdf-lib@1.17.1");

  const doc = await PDFDocument.create();
  const fonte = await doc.embedFont(StandardFonts.Helvetica);
  const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
  const [W, H] = [595.28, 841.89]; // A4
  const M = 56;
  const LARG = W - M * 2;
  let page = doc.addPage([W, H]);
  let y = H - M;

  const quebra = (txt: string, f: any, size: number): string[] => {
    const out: string[] = [];
    for (const par of txt.split("\n")) {
      let linha = "";
      for (const p of par.split(/\s+/)) {
        const teste = linha ? `${linha} ${p}` : p;
        if (linha && f.widthOfTextAtSize(teste, size) > LARG) { out.push(linha); linha = p; }
        else linha = teste;
      }
      out.push(linha);
    }
    return out;
  };
  const escrever = (txt: string, f: any, size: number, gap = 4, cor = rgb(0.1, 0.1, 0.12)) => {
    for (const l of quebra(txt, f, size)) {
      if (y - size < M) { page = doc.addPage([W, H]); y = H - M; }
      page.drawText(l, { x: M, y: y - size, size, font: f, color: cor });
      y -= size + gap;
    }
  };

  escrever(sanitize(titulo), negrito, 18, 6);
  escrever(`${fmtData(hojeSP())}  ·  PPGVET Educacao`, fonte, 9, 16, rgb(0.45, 0.45, 0.5));

  for (const bruto of sanitize(conteudo).split("\n")) {
    const l = bruto.trimEnd();
    if (!l.trim()) { y -= 6; continue; }
    if (/^#{1,3}\s+/.test(l)) { y -= 6; escrever(l.replace(/^#{1,3}\s+/, ""), negrito, 13, 5); continue; }
    if (/^[-*•]\s+/.test(l)) { escrever("• " + l.replace(/^[-*•]\s+/, ""), fonte, 11, 3); continue; }
    escrever(l.replace(/\*\*/g, ""), fonte, 11, 4);
  }
  return await doc.save();
}

export async function gerarEnviarPdf(input: any, ctx: Ctx) {
  const titulo = String(input?.titulo || "Documento").trim();
  const conteudo = String(input?.conteudo || "").trim();
  if (!conteudo) return { status: "sem_conteudo", mensagem: "Preciso do conteúdo do documento." };
  if (!ctx.linha || !ctx.numero) return { status: "erro", mensagem: "Sem linha de WhatsApp para enviar o arquivo." };

  const bytes = await gerarPdf(titulo, conteudo);
  const nome = `${slug(titulo)}.pdf`;
  const caminho = `assistente/${ctx.canon}/${Date.now()}-${nome}`;

  const { error } = await ctx.admin.storage.from("gt-doc-assets")
    .upload(caminho, bytes, { contentType: "application/pdf", upsert: true });
  if (error) throw new Error(`upload falhou: ${error.message}`);

  const { data: pub } = ctx.admin.storage.from("gt-doc-assets").getPublicUrl(caminho);
  const url = toPublicUrl(pub?.publicUrl ?? "");
  if (!url) throw new Error("sem URL pública do arquivo");

  await enviarDocumento(ctx.linha, ctx.numero, url, nome, titulo);
  return {
    status: "enviado", arquivo: nome, url,
    mensagem: `✅ PDF "${nome}" gerado e enviado aqui no WhatsApp.`,
    _instrucao: "O arquivo JÁ foi enviado ao dono. Responda em 1 linha avisando — NÃO repita o conteúdo inteiro.",
  };
}
