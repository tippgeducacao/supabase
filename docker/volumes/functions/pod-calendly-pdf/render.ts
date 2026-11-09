/**
 * PDF do E-MAIL DE AGENDAMENTO do Calendly (09/11/2026) — o anexo "email de agendamento" da tarefa do
 * episódio no Gestor (pedido da equipe: o Pedagógico só registra e valida; o resto nasce sozinho).
 *
 * O que é: o e-mail que o Calendly manda ao host quando o convidado agenda ("Novo evento: …"), remarca
 * ("Atualizado: …") ou cancela, impresso em PDF: cabeçalho (assunto, data de recebimento, de, para) e o
 * TEXTO do e-mail, na ordem em que ele aparece. Imagens e botões NÃO são reproduzidos (o PDF não é uma
 * foto do e-mail: sem navegador na edge não há como renderizar o HTML do Calendly com o visual dele).
 *
 * ⚠️ Nenhum endereço de link entra no PDF: o e-mail do Calendly traz links de cancelar/remarcar com
 * token do evento, e o PDF fica anexado numa tarefa que várias pessoas abrem. Só o TEXTO visível passa
 * (o `Local: https://…` do Zencastr é texto visível, então sai).
 *
 * jsPDF entra por parâmetro: a edge importa de `npm:` e o teste (vitest) do node_modules; este arquivo
 * não importa nenhum dos dois. Só fonte padrão (Helvetica, WinAnsi): `paraFonteDoPdf` tira o que ela
 * não desenha (emoji, aspas curvas viram retas) em vez de sair "?" no meio do texto.
 */

export interface EmailParaPdf {
  assunto: string | null;
  de_nome: string | null;
  de_email: string | null;
  /** `email_mensagens.to_emails`: lista de {name, email} (ou de strings). */
  para: unknown;
  /** Data do e-mail (ISO). */
  recebido_em: string | null;
  /** 'novo' | 'atualizado' | 'cancelado' */
  acao: string | null;
  convidado_nome: string | null;
  body_html: string | null;
}

// deno-lint-ignore no-explicit-any
type JsPdfCtor = new (opts?: any) => any;

const TZ = "America/Sao_Paulo";

const ENTIDADES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ccedil: "ç", Ccedil: "Ç",
  atilde: "ã", Atilde: "Ã", otilde: "õ", Otilde: "Õ", aacute: "á", Aacute: "Á", eacute: "é", Eacute: "É",
  iacute: "í", Iacute: "Í", oacute: "ó", Oacute: "Ó", uacute: "ú", Uacute: "Ú", acirc: "â", Acirc: "Â",
  ecirc: "ê", Ecirc: "Ê", ocirc: "ô", Ocirc: "Ô", agrave: "à", Agrave: "À", ndash: "–", mdash: "—",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", middot: "·", copy: "©",
};

export function decodificarEntidades(s: string): string {
  return s
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_m, d: string) => codePoint(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]{1,7});/gi, (m, n: string) => ENTIDADES[n] ?? m);
}

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n < 1 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return " ";
  return String.fromCodePoint(n);
}

/**
 * HTML do e-mail → texto em linhas. Quebra em `<br>` e no FIM de bloco (p, div, tr, li, h1-6…), junta
 * as células de uma linha de tabela com espaço, descarta head/style/script/title e comentários e NUNCA
 * lê atributo (nenhum href passa).
 */
export function htmlParaTexto(html: string | null | undefined): string {
  let t = String(html ?? "");
  t = t.replace(/<!--[\s\S]*?-->/g, " ");
  t = t.replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, " ");
  // quebra de linha do CÓDIGO-FONTE (\r\n e recuo) não é quebra de linha do texto: só <br> e o fim de bloco são.
  // (O aviso do Calendly vem com \r\n entre as tags: sem isto, cada rótulo ficava a 4 linhas do seu valor.)
  t = t.replace(/\s+/g, " ");
  t = t.replace(/<br\b[^>]*>/gi, "\n"); // o do Calendly vem com style='…' no próprio <br>
  t = t.replace(/<\/(p|div|table|ul|ol|h[1-6]|blockquote)\s*>/gi, "\n\n");
  t = t.replace(/<\/(tr|li)\s*>/gi, "\n");
  t = t.replace(/<\/(td|th)\s*>/gi, " ");
  t = t.replace(/<[^>]*>/g, " ");
  t = decodificarEntidades(t);
  t = t.replace(/[^\S\n]+/g, " ").split("\n").map((l) => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/** Só o que a Helvetica (WinAnsi) desenha: ASCII + Latin-1; o resto vira o equivalente simples ou "?". */
export function paraFonteDoPdf(s: string): string {
  return s
    .normalize("NFC")
    // emoji e seletores de variação somem (um "?" no meio da frase da resposta do convidado parece erro); o que sobrar
    // fora do Latin-1 (CJK, grego…) vira "?" no fim, para não perder em silêncio que ali havia texto
    .replace(/[\p{Extended_Pictographic}︀-️‍\u{1f3fb}-\u{1f3ff}]/gu, "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[•●▪◦]/g, "-")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/[^\n\x20-\x7e -ÿ]/gu, "?");
}

/** "06/11/2026 14:55" em Brasília. */
export function dataHoraBR(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

const ACAO: Record<string, string> = { novo: "Novo evento", atualizado: "Evento atualizado", cancelado: "Evento cancelado" };
export const rotuloDaAcao = (acao: string | null | undefined): string => ACAO[String(acao ?? "")] ?? "Aviso do Calendly";

/** Destinatários como texto: aceita [{name,email}], ["a@b"] ou um texto solto. */
export function paraComoTexto(para: unknown): string {
  const lista = Array.isArray(para) ? para : para ? [para] : [];
  return lista
    .map((x) => {
      if (typeof x === "string") return x.trim();
      if (x && typeof x === "object") {
        const o = x as { name?: unknown; email?: unknown };
        const nome = String(o.name ?? "").trim();
        const email = String(o.email ?? "").trim();
        return nome && email ? `${nome} <${email}>` : email || nome;
      }
      return "";
    })
    .filter(Boolean)
    .join(", ");
}

/** Nome que a pessoa vê na lista de anexos da tarefa: sem caractere que arquivo não aceita. */
export function nomeArquivoPdf(d: Pick<EmailParaPdf, "acao" | "convidado_nome" | "recebido_em">): string {
  const dia = dataHoraBR(d.recebido_em).slice(0, 10).replace(/\//g, "-");
  const partes = ["E-mail de agendamento (Calendly)", rotuloDaAcao(d.acao), (d.convidado_nome ?? "").trim(), dia]
    .map((x) => x.replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return `${partes.join(" — ")}.pdf`.slice(0, 200);
}

/** Monta o PDF (A4, retrato) e devolve os bytes. */
export function montarPdfEmail({ jsPDF }: { jsPDF: JsPdfCtor }, d: EmailParaPdf): Uint8Array {
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  const LARGURA = 210;
  const ALTURA = 297;
  const M = 18;
  const util = LARGURA - 2 * M;
  const RODAPE = 12;
  let y = M;

  const cinza = () => doc.setTextColor(110, 110, 110);
  const preto = () => doc.setTextColor(25, 25, 25);
  const garantir = (altura: number) => {
    if (y + altura > ALTURA - M - RODAPE) {
      doc.addPage();
      y = M;
    }
  };
  const escrever = (texto: string, tamanho: number, passo: number, negrito = false) => {
    doc.setFont("helvetica", negrito ? "bold" : "normal");
    doc.setFontSize(tamanho);
    const linhas = doc.splitTextToSize(paraFonteDoPdf(texto), util) as string[];
    for (const l of linhas) {
      garantir(passo);
      doc.text(l, M, y);
      y += passo;
    }
  };

  // título
  preto();
  escrever("E-mail de agendamento (Calendly)", 16, 7, true);
  cinza();
  escrever(`${rotuloDaAcao(d.acao)}${d.convidado_nome ? ` · ${d.convidado_nome}` : ""}`, 10.5, 5);
  y += 2;
  doc.setDrawColor(200, 200, 200);
  doc.line(M, y, LARGURA - M, y);
  y += 6;

  // cabeçalho do e-mail
  const cab: Array<[string, string]> = [
    ["Assunto", d.assunto ?? ""],
    ["Recebido em", dataHoraBR(d.recebido_em) ? `${dataHoraBR(d.recebido_em)} (Brasília)` : ""],
    ["De", [d.de_nome, d.de_email && `<${d.de_email}>`].filter(Boolean).join(" ")],
    ["Para", paraComoTexto(d.para)],
  ];
  for (const [rotulo, valor] of cab) {
    if (!valor.trim()) continue;
    const rot = `${rotulo}: `;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    const larguraRotulo = doc.getTextWidth(rot);
    const linhas = doc.splitTextToSize(paraFonteDoPdf(valor), util - larguraRotulo) as string[];
    linhas.forEach((l, i) => {
      garantir(5);
      if (i === 0) {
        doc.setFont("helvetica", "bold");
        preto();
        doc.text(rot, M, y);
      }
      doc.setFont("helvetica", "normal");
      preto();
      doc.text(l, M + larguraRotulo, y);
      y += 5;
    });
  }
  y += 1;
  doc.line(M, y, LARGURA - M, y);
  y += 7;

  // corpo: o texto do e-mail, linha a linha (linha em branco = respiro)
  preto();
  const corpo = htmlParaTexto(d.body_html);
  if (!corpo) {
    cinza();
    escrever("(o e-mail não tem texto para reproduzir)", 10, 5);
  } else {
    for (const linha of corpo.split("\n")) {
      if (!linha.trim()) {
        y += 2.5;
        continue;
      }
      // rótulo do Calendly ("Tipo de evento:", "Convidado:" …) sozinho na linha sai em negrito
      const ehRotulo = /^[^:]{2,40}:$/.test(linha.trim());
      preto();
      escrever(linha.trim(), 10.5, 5, ehRotulo);
    }
  }

  // rodapé em todas as páginas
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    cinza();
    doc.text(
      paraFonteDoPdf("Gerado automaticamente pelo sistema a partir do e-mail recebido. Reproduz só o texto do e-mail (imagens e botões ficam de fora)."),
      M, ALTURA - M + 2,
    );
    doc.text(`Página ${i} de ${total}`, LARGURA - M, ALTURA - M + 2, { align: "right" });
  }

  return new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
}
