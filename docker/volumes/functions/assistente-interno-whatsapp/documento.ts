// Gera um PDF do conteúdo que o cérebro escreveu e ENVIA no WhatsApp do dono.
// pdf-lib = ESM puro (roda no Deno). NÃO há headless browser no edge, então o layout é
// montado à mão (quebra de linha/página manual) — simples e previsível.
//
// LAYOUT ESTILO "ATA / RELATÓRIO" (pedido do dono 2026-07-21, com print de referência):
// título + subtítulo, BLOCO DE IDENTIFICAÇÃO (Assunto/Participantes/… em linhas rótulo→valor),
// SEÇÕES em caixa alta com filete, subtítulos por tema/pessoa, bullets e listas numeradas,
// rodapé com "Página X de Y".
//
// DOCUMENTO LONGO (2026-08-03, caso "relatório do evento em 2 folhas"): o conteúdo pode vir
// com HIERARQUIA explícita, e aí o PDF ganha capa, sumário e partes em página própria:
//   "# Parte"      → PARTE (página nova + título grande) — só em documento com 2+ partes
//   "## Seção"     → SEÇÃO (caixa alta + filete)
//   "### Subtítulo"→ subtítulo
//   "> citação"    → bloco citado (recuo + barra lateral)
//   "*Título*"     → seção (se estiver em SECOES) ou subtítulo — formato ANTIGO, preservado
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
    .replace(/^[ \t]*•[ \t]*/gm, "- ") // bullet Unicode do modelo vira "-" ANTES do strip Latin-1
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, ""); // fora do Latin-1 (emoji etc.) → remove
}

function slug(s: string): string {
  return (sanitize(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)) || "documento";
}

const semAcento = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Seções de 1º nível da ata/análise — casadas por IGUALDADE EXATA (normalizada), nunca por
 *  prefixo: um TEMA como "*Análise das capas*" ou "*Decisões sobre o catálogo*" tem que continuar
 *  SUBTÍTULO, senão a hierarquia da ata desmonta (achado da revisão adversarial). Parentético
 *  serve pras variantes do prompt: "Pendências (em aberto)", "Decisões (o que foi acordado)". */
const SECOES = new Set([
  "identificacao", "resumo executivo", "contexto", "pauta e discussoes",
  "principais pontos discutidos", "decisoes", "decisoes o que foi acordado",
  "pendencias", "pendencias em aberto", "em aberto", "em aberto a definir",
  "tarefas por responsavel", "prazos e datas", "prazos e datas citados", "proximos passos",
  "o que e o video", "conteudo", "analise",
]);
const ehSecao = (t: string) =>
  SECOES.has(semAcento(t).replace(/[():]/g, " ").replace(/\s+/g, " ").trim());

export type PdfOpts = {
  /** Linha cinza abaixo do título (default: "PPGVET Educacao · <data de hoje>"). */
  subtitulo?: string;
  /** Linhas fixas do cabeçalho, antes das que vierem no conteúdo. Ex.: [["Recebido em","21/07 16:36"]] */
  info?: Array<[string, string]>;
};

/** Um item do documento já classificado — o parser roda ANTES de desenhar (o sumário
 *  precisa saber as seções e a capa precisa saber se o doc é longo). */
type Item =
  | { t: "parte"; txt: string }
  | { t: "secao"; txt: string }
  | { t: "sub"; txt: string }
  | { t: "campo"; rot: string; val: string }
  | { t: "bullet"; txt: string }
  | { t: "num"; n: string; txt: string }
  | { t: "quote"; txt: string }
  | { t: "p"; txt: string }
  | { t: "vazio" }
  | { t: "ident" };

function parsear(conteudo: string): Item[] {
  const itens: Item[] = [];
  let emIdent = false;
  for (const bruto of sanitize(conteudo).split("\n")) {
    const l = bruto.trimEnd();
    if (!l.trim()) { itens.push({ t: "vazio" }); continue; }

    const h = l.match(/^(#{1,3})\s+(.+)$/);
    const marcado = l.trim().match(/^\*+\s*(.+?)\s*\*+:?$/);

    if (h || marcado) {
      const txt = (h ? h[2] : marcado![1]).trim();
      // "Identificação" nunca vira título: o conteúdo dela É o cabeçalho do documento.
      if (semAcento(txt).startsWith("identificacao")) { emIdent = true; itens.push({ t: "ident" }); continue; }
      emIdent = false;
      if (h) {
        itens.push(h[1].length === 1 ? { t: "parte", txt } : h[1].length === 2 ? { t: "secao", txt } : { t: "sub", txt });
      } else {
        itens.push(ehSecao(txt) ? { t: "secao", txt } : { t: "sub", txt });
      }
      continue;
    }

    // Dentro da Identificação: "Campo: valor" vira linha do cabeçalho. Linha fora do padrão vira
    // parágrafo mas NÃO fecha o bloco (senão um deslize do modelo derrubaria os campos seguintes).
    if (emIdent) {
      const campo = l.match(/^\s*\*?([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ /()]{2,30})\*?\s*:\s*(.+)$/);
      if (campo) { itens.push({ t: "campo", rot: campo[1].trim(), val: campo[2].trim() }); continue; }
    }

    const quote = l.match(/^\s*>\s?(.*)$/);
    if (quote) { itens.push({ t: "quote", txt: quote[1].replace(/\*/g, "") }); continue; }

    const bullet = l.match(/^\s*[-*•]\s+(.+)$/);
    if (bullet) { itens.push({ t: "bullet", txt: bullet[1].replace(/\*/g, "") }); continue; }

    const num = l.match(/^\s*(\d{1,2})[.)]\s+(.+)$/);
    if (num) { itens.push({ t: "num", n: num[1], txt: num[2].replace(/\*/g, "") }); continue; }

    itens.push({ t: "p", txt: l.replace(/\*/g, "") });
  }
  return itens;
}

export async function gerarPdf(titulo: string, conteudo: string, opts: PdfOpts = {}): Promise<Uint8Array> {
  // Import DINÂMICO de propósito: se o pdf-lib falhar em carregar no runtime do edge, só ESTA
  // ferramenta quebra (erro tratado) — um import no topo derrubaria o bot inteiro no boot.
  const { PDFDocument, StandardFonts, rgb } = await import("https://esm.sh/pdf-lib@1.17.1");

  const doc = await PDFDocument.create();
  const fonte = await doc.embedFont(StandardFonts.Helvetica);
  const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
  const [W, H] = [595.28, 841.89]; // A4
  const M = 56;
  const LARG = W - M * 2;
  const ROD = 34; // reserva do rodapé

  const TINTA = rgb(0.09, 0.10, 0.13);
  const CINZA = rgb(0.42, 0.45, 0.50);
  const ACENTO = rgb(0.05, 0.42, 0.35);
  const FILETE = rgb(0.84, 0.86, 0.87);

  const itens = parsear(conteudo);
  const partes = itens.filter((i) => i.t === "parte") as Array<{ t: "parte"; txt: string }>;
  const secoes = itens.filter((i) => i.t === "secao") as Array<{ t: "secao"; txt: string }>;
  // Documento LONGO ganha capa + sumário. Curto (ata do dia a dia) segue igual — zero regressão.
  const longo = partes.length >= 2 || secoes.length >= 8;

  const paginas: any[] = [];
  const novaPagina = () => { const p = doc.addPage([W, H]); paginas.push(p); return p; };
  let page = novaPagina();
  let y = H - M;
  /** Páginas que NÃO levam rodapé (capa). */
  const semRodape = new Set<number>();

  /** Token maior que a coluna (URL longa) é FATIADO — senão sangra pra fora da página. */
  const fatiar = (p: string, f: any, size: number, larg: number): string[] => {
    if (f.widthOfTextAtSize(p, size) <= larg) return [p];
    const partes: string[] = [];
    let atual = "";
    for (const ch of p) {
      if (atual && f.widthOfTextAtSize(atual + ch, size) > larg) { partes.push(atual); atual = ch; }
      else atual += ch;
    }
    if (atual) partes.push(atual);
    return partes;
  };
  const quebra = (txt: string, f: any, size: number, larg: number): string[] => {
    const out: string[] = [];
    for (const par of String(txt).split("\n")) {
      let linha = "";
      for (const cru of par.split(/\s+/)) {
        for (const p of fatiar(cru, f, size, larg)) {
          const teste = linha ? `${linha} ${p}` : p;
          if (linha && f.widthOfTextAtSize(teste, size) > larg) { out.push(linha); linha = p; }
          else linha = teste;
        }
      }
      out.push(linha);
    }
    return out;
  };
  const cabe = (altura: number) => { if (y - altura < M + ROD) { page = novaPagina(); y = H - M; } };

  /** Escreve texto com quebra de linha/página. `x`/`larg` permitem recuo (bullets, valores). */
  const escrever = (
    txt: string,
    o: { f?: any; size?: number; cor?: any; x?: number; larg?: number; gap?: number } = {},
  ) => {
    const f = o.f ?? fonte, size = o.size ?? 10.5, x = o.x ?? M;
    const larg = o.larg ?? (LARG - (x - M)), gap = o.gap ?? 4;
    for (const l of quebra(txt, f, size, larg)) {
      cabe(size + gap);
      page.drawText(l, { x, y: y - size, size, font: f, color: o.cor ?? TINTA });
      y -= size + gap;
    }
  };
  const filete = (cor = FILETE, esp = 0.7) => {
    cabe(8);
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: esp, color: cor });
    y -= 8;
  };

  const subtituloTxt = sanitize(opts.subtitulo || `PPGVET Educacao  ·  ${fmtData(hojeSP())}`);

  // ── Capa (só documento longo) ──────────────────────────────────────────────
  if (longo) {
    semRodape.add(0);
    y = H * 0.62;
    page.drawLine({ start: { x: M, y: y + 34 }, end: { x: M + 78, y: y + 34 }, thickness: 2.6, color: ACENTO });
    escrever(sanitize(titulo).toUpperCase(), { f: negrito, size: 27, gap: 8 });
    y -= 6;
    escrever(subtituloTxt, { f: fonte, size: 11, cor: CINZA, gap: 6 });
    const resumoCapa = `${partes.length ? `${partes.length} partes · ` : ""}${secoes.length} secoes`;
    escrever(resumoCapa, { f: fonte, size: 9.5, cor: CINZA, gap: 6 });
    page = novaPagina();
    y = H - M;
  }

  // ── Cabeçalho (documento curto: título direto no topo da 1ª página) ────────
  if (!longo) {
    escrever(sanitize(titulo).toUpperCase(), { f: negrito, size: 20, gap: 5 });
    escrever(subtituloTxt, { f: fonte, size: 9, cor: CINZA, gap: 10 });
    filete(ACENTO, 1.6);
  }

  // ── Bloco de identificação (rótulo → valor), estilo ata ────────────────────
  const LARG_ROT = 116;
  let temInfo = false;
  const linhaInfo = (rotulo: string, valor: string) => {
    const linhas = quebra(sanitize(valor), fonte, 10.5, LARG - LARG_ROT);
    let rotuloDesenhado = false;
    for (const l of linhas) {
      cabe(14); // pagina POR LINHA — um Participantes gigante não pode desenhar por cima do rodapé
      if (!rotuloDesenhado) {
        page.drawText(sanitize(rotulo).toUpperCase(), { x: M, y: y - 9, size: 7.6, font: negrito, color: CINZA });
        rotuloDesenhado = true;
      }
      page.drawText(l, { x: M + LARG_ROT, y: y - 10.5, size: 10.5, font: fonte, color: TINTA });
      y -= 14;
    }
    y -= 2;
    temInfo = true;
  };

  for (const [rot, val] of opts.info ?? []) {
    if (!String(val ?? "").trim()) continue;
    linhaInfo(rot, String(val));
  }

  // ── Sumário (só documento longo) ───────────────────────────────────────────
  // Fica ANTES do corpo e sem nº de página: o layout é fluido (uma linha a mais muda tudo),
  // então prometer página seria mentira. Serve como mapa do documento.
  const desenharSumario = () => {
    y -= 6;
    escrever("SUMARIO", { f: negrito, size: 10.5, cor: ACENTO, gap: 4 });
    filete(FILETE, 0.7);
    let parteAtual = "";
    for (const it of itens) {
      if (it.t === "parte") {
        parteAtual = it.txt;
        y -= 4;
        escrever(sanitize(it.txt).toUpperCase(), { f: negrito, size: 9.5, gap: 3 });
      } else if (it.t === "secao") {
        escrever(sanitize(it.txt), { f: fonte, size: 9.5, cor: CINZA, x: M + (parteAtual ? 14 : 0), gap: 3 });
      }
    }
    y -= 4;
  };

  // ── Corpo ──────────────────────────────────────────────────────────────────
  let primeiraSecao = true;
  let identAberta = false;
  let sumarioFeito = false;

  const fecharIdent = () => {
    if (identAberta) { identAberta = false; if (temInfo) { y -= 2; filete(FILETE, 0.7); } }
  };

  for (const it of itens) {
    switch (it.t) {
      case "ident":
        identAberta = true; primeiraSecao = false;
        break;

      case "campo":
        linhaInfo(it.rot, it.val);
        break;

      case "parte": {
        fecharIdent();
        if (longo && !sumarioFeito) { desenharSumario(); sumarioFeito = true; }
        // Parte SEMPRE começa em página nova (menos se a atual está praticamente vazia).
        if (y < H - M - 24) { page = novaPagina(); y = H - M; }
        y -= 10;
        page.drawLine({ start: { x: M, y: y + 16 }, end: { x: M + 54, y: y + 16 }, thickness: 2.2, color: ACENTO });
        escrever(sanitize(it.txt).toUpperCase(), { f: negrito, size: 16, gap: 6 });
        y -= 4;
        filete(ACENTO, 1.2);
        primeiraSecao = true;
        break;
      }

      case "secao":
        fecharIdent();
        if (longo && !sumarioFeito) { desenharSumario(); sumarioFeito = true; }
        y -= primeiraSecao ? 4 : 12;
        primeiraSecao = false;
        cabe(64); // título de seção nunca fica órfão no pé da página (precisa caber com algum conteúdo)
        escrever(sanitize(it.txt).toUpperCase(), { f: negrito, size: 10.5, cor: ACENTO, gap: 4 });
        filete(FILETE, 0.7);
        break;

      case "sub":
        fecharIdent();
        y -= 7;
        cabe(46); // idem para o subtítulo (tema/pessoa) e sua primeira linha
        escrever(it.txt, { f: negrito, size: 11.5, gap: 4 });
        break;

      case "quote": {
        y -= 3;
        const linhas = quebra(it.txt, fonte, 10.5, LARG - 30);
        cabe(linhas.length * 15 + 6);
        const topo = y;
        for (const l of linhas) {
          page.drawText(l, { x: M + 22, y: y - 10.5, size: 10.5, font: fonte, color: rgb(0.25, 0.27, 0.31) });
          y -= 15;
        }
        page.drawLine({
          start: { x: M + 6, y: topo - 2 }, end: { x: M + 6, y: y + 4 },
          thickness: 2.4, color: ACENTO,
        });
        y -= 4;
        break;
      }

      case "bullet":
        cabe(15);
        page.drawText("-", { x: M + 4, y: y - 10.5, size: 10.5, font: fonte, color: ACENTO });
        escrever(it.txt, { x: M + 16, gap: 3.5 });
        break;

      case "num":
        cabe(15);
        page.drawText(`${it.n}.`, { x: M + 2, y: y - 10.5, size: 10.5, font: negrito, color: ACENTO });
        escrever(it.txt, { x: M + 20, gap: 3.5 });
        break;

      case "vazio":
        y -= 5;
        break;

      default:
        escrever((it as any).txt, { gap: 4.5 });
    }
  }

  // ── Rodapé (só faz sentido no fim: precisa do total de páginas) ────────────
  paginas.forEach((p, i) => {
    if (semRodape.has(i)) return;
    const t = `Pagina ${i + 1} de ${paginas.length}`;
    p.drawLine({ start: { x: M, y: M - 6 }, end: { x: W - M, y: M - 6 }, thickness: 0.5, color: FILETE });
    p.drawText(t, { x: (W - fonte.widthOfTextAtSize(t, 8)) / 2, y: M - 18, size: 8, font: fonte, color: CINZA });
  });

  return await doc.save();
}

// ── Rascunho de documento longo (escrito em PARTES) ──────────────────────────
// ⚠️ VIVE NO BANCO (`assistente_rascunhos`), não em memória. A versão anterior usava um Map no
// isolate do edge e quebrava em 3 cenários prováveis num documento que leva minutos: o isolate
// reciclar no meio (partes somem, mas o fechamento diz "enviado" e o bot ANUNCIA sucesso com o
// PDF pela metade); o dono mandar outra mensagem no meio ("tá saindo?" — é outra requisição,
// possivelmente outro isolate); e rascunho velho sobrando e sendo prependado ao documento
// seguinte. Chave = (canon, parte_num): um documento por dono de cada vez.
const TTL_RASCUNHO_MS = 2 * 3600 * 1000;

async function lerRascunho(ctx: Ctx): Promise<{ titulo: string; partes: string[] } | null> {
  const { data } = await ctx.admin
    .from("assistente_rascunhos")
    .select("titulo, parte_num, conteudo")
    .eq("canon", ctx.canon)
    .order("parte_num", { ascending: true });
  if (!data?.length) return null;
  // O título da PRIMEIRA parte prevalece (o modelo às vezes varia o título entre as chamadas).
  return { titulo: String(data[0].titulo), partes: data.map((d: any) => String(d.conteudo)) };
}

async function limparRascunho(ctx: Ctx) {
  await ctx.admin.from("assistente_rascunhos").delete().eq("canon", ctx.canon);
}

/** Fecha o documento pendente com o que já foi escrito. Chamado quando o loop de ferramentas
 *  se esgota com rascunho aberto — melhor entregar o parcial MARCADO do que descartar tudo. */
export async function fecharRascunhoPendente(ctx: Ctx): Promise<string | null> {
  const r = await lerRascunho(ctx);
  if (!r) return null;
  const aviso =
    "\n\n## Documento incompleto\n" +
    "Este PDF foi fechado automaticamente com as partes que deram tempo de ser escritas. " +
    "Peça a continuação para completar o restante.";
  try {
    const out: any = await gerarEnviarPdf({ titulo: r.titulo, conteudo: aviso }, ctx);
    return out?.status === "enviado"
      ? `📄 Te mandei o PDF "${out.arquivo}" com o que consegui montar até aqui — o documento ficou grande e ` +
        `precisei fechar antes do fim. Me diz "continua o documento" que eu monto o restante.`
      : null;
  } catch {
    await limparRascunho(ctx); // nunca deixa rascunho órfão envenenando o próximo documento
    return null;
  }
}

export async function gerarEnviarPdf(input: any, ctx: Ctx) {
  const titulo = String(input?.titulo || "Documento").trim();
  const conteudo = String(input?.conteudo || "").trim();
  const continua = input?.continuar === true || input?.continua === true;
  if (!conteudo) return { status: "sem_conteudo", mensagem: "Preciso do conteúdo do documento." };
  if (!ctx.linha || !ctx.numero) return { status: "erro", mensagem: "Sem linha de WhatsApp para enviar o arquivo." };

  // TTL: rascunho abandonado (dono desistiu, edge caiu) não pode contaminar o próximo documento.
  await ctx.admin.from("assistente_rascunhos").delete()
    .eq("canon", ctx.canon)
    .lt("criado_em", new Date(Date.now() - TTL_RASCUNHO_MS).toISOString());

  const acumulado = await lerRascunho(ctx);

  // Documento em PARTES: acumula e só gera o PDF quando o modelo fecha (continuar = false).
  if (continua) {
    const proxima = (acumulado?.partes.length ?? 0) + 1;
    const { error } = await ctx.admin.from("assistente_rascunhos").insert({
      canon: ctx.canon, titulo: acumulado?.titulo ?? titulo, parte_num: proxima, conteudo,
    });
    if (error) throw new Error(`não consegui guardar a parte ${proxima}: ${error.message}`);
    const chars = (acumulado?.partes.join("\n").length ?? 0) + conteudo.length;
    return {
      status: "parte_recebida",
      partes: proxima,
      caracteres_acumulados: chars,
      mensagem: `Parte ${proxima} guardada (${chars} caracteres no total). O PDF ainda NÃO foi enviado.`,
      _instrucao:
        "NÃO responda ao dono ainda e NÃO diga que enviou. Chame gerar_pdf de novo com a PRÓXIMA parte. " +
        "Na ÚLTIMA parte, use continuar=false para fechar e enviar o PDF.",
    };
  }

  const texto = acumulado ? [...acumulado.partes, conteudo].join("\n") : conteudo;
  const tituloFinal = acumulado?.titulo ?? titulo;
  await limparRascunho(ctx);

  const bytes = await gerarPdf(tituloFinal, texto);
  const nome = `${slug(tituloFinal)}.pdf`;
  const caminho = `assistente/${ctx.canon}/${Date.now()}-${nome}`;

  const { error } = await ctx.admin.storage.from("gt-doc-assets")
    .upload(caminho, bytes, { contentType: "application/pdf", upsert: true });
  if (error) throw new Error(`upload falhou: ${error.message}`);

  const { data: pub } = ctx.admin.storage.from("gt-doc-assets").getPublicUrl(caminho);
  const url = toPublicUrl(pub?.publicUrl ?? "");
  if (!url) throw new Error("sem URL pública do arquivo");

  await enviarDocumento(ctx.linha, ctx.numero, url, nome, tituloFinal);
  return {
    status: "enviado", arquivo: nome, url, caracteres: texto.length,
    mensagem: `✅ PDF "${nome}" gerado e enviado aqui no WhatsApp.`,
    _instrucao: "O arquivo JÁ foi enviado ao dono. Responda em 1 linha avisando — NÃO repita o conteúdo inteiro.",
  };
}
