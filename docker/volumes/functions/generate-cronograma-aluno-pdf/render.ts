/**
 * PDF "CRONOGRAMA DO ALUNO", versão da EDGE (o que vai no cabeçalho do D+1 da integração).
 *
 * ⚠️ PORTE de src/services/pedagogico/cronogramaAlunoPdf.ts, a engine do navegador usada na aba
 * Cronograma do aluno do Pedagógico e no botão "Baixar cronograma do aluno" do comercial. O
 * layout é o MESMO: logo, faixa rosa "CRONOGRAMA DE AULAS", cards de início das aulas ao vivo e
 * de duração, aviso amarelo, tabela por mês (AULA / DATA-DIA / HORÁRIO / EMENTA, sem professor)
 * e, no fim, a tabela "MÓDULOS PRÁTICOS PRESENCIAIS" com a tarja de semipresencial. Mudou o
 * modelo lá (decisões do diretor de 09/07 e 31/08 já mexeram nele)? Mude aqui na mesma tarefa.
 *
 * O que muda em relação ao navegador, e por quê:
 *  - jsPDF e autoTable entram por parâmetro. A edge importa de `npm:`, o teste (vitest) importa
 *    do node_modules; este arquivo não importa nenhum dos dois e roda nos dois lugares.
 *  - O logo vem de ./logos.ts (base64) e sai pela MARCA do curso (`ped_pos_graduacoes.marca`):
 *    curso de público não veterinário ('ppg') nunca recebe o logo PPGVET.
 *  - `addImage` com compressão "FAST" e logo de 480 px. O PDF do navegador grava o PNG de
 *    1920x1080 cru e pesa ~8,38 MB; este fica em ~120 KB, o que importa num anexo de WhatsApp.
 *    ⚠️ `addImage` (e `addFont`/`html`) só recebe o data URL CONSTANTE de ./logos.ts: nunca
 *    caminho, URL ou valor vindo do banco. No build Node do jsPDF, caminho vira leitura de
 *    arquivo local embutida no PDF (CVE-2025-68428), e o GET desta edge é público.
 *  - Sem travessão nos textos fixos (placeholder, rodapé, tarja do EAD): é texto que o aluno lê.
 *    Texto que vem do banco (título, ementa) sai como o Pedagógico cadastrou.
 *  - Devolve os BYTES em vez de `doc.save()`.
 *
 * Só dado da TURMA entra no PDF: nada do aluno (nome, CPF, telefone). O mesmo arquivo serve a
 * todos os alunos da turma, e o link é público (a Meta baixa sem autenticação).
 */
import { agruparPraticos, TARJA_PRATICO_LONGA, type PraticoSessao } from "./praticos.ts";
import { LOGOS, type LogoPdf, type Marca } from "./logos.ts";

export type { Marca } from "./logos.ts";

export interface CronogramaAlunoTurma {
  nome: string | null;
  data_inicio: string | null;
  data_fim: string | null;
  horario_inicio: string | null;
  horario_fim: string | null;
  pos?: { nome?: string | null; periodo_total_meses?: number | string | null } | null;
}

export interface CronogramaAlunoAula {
  data: string | null;
  horario: string | null;
  titulo: string | null;
  ementa: string | null;
  tipo_aula: string | null;
}

/** Linha da RPC `ped_turma_ead_cronograma` (só os campos que o PDF usa). */
export interface EadCronogramaRow {
  modulo_numero: number | null;
  modulo_nome: string | null;
  data_liberacao_planejada: string | null;
  aulas: string[] | null;
}

/** jsPDF e autoTable injetados: `npm:jspdf` na edge, `jspdf` do node_modules no teste. */
export interface DepsPdf {
  // deno-lint-ignore no-explicit-any
  jsPDF: new (opts: { unit: "pt"; format: "a4"; compress?: boolean }) => any;
  // deno-lint-ignore no-explicit-any
  autoTable: (doc: any, opts: any) => unknown;
}

export interface EntradaCronograma {
  turma: CronogramaAlunoTurma;
  aulas: CronogramaAlunoAula[];
  /** Sessões práticas já normalizadas (`normalizarPraticos(..., { somenteAPartirDoInicioDaTurma: true })`). */
  praticos?: PraticoSessao[];
  /** `ped_pos_graduacoes.marca`. Desconhecida ou vazia cai no PPG Educação (ver `marcaDoCurso`). */
  marca?: string | null;
  /**
   * Compressão dos streams de texto. Ligada por padrão (o anexo cai de ~120 KB para bem menos);
   * o teste desliga para conseguir ler o texto dentro do PDF.
   */
  comprimir?: boolean;
}

export interface PdfGerado {
  /** `Uint8Array<ArrayBuffer>` (e não ArrayBufferLike): é o que o `new Response()` do Deno aceita. */
  bytes: Uint8Array<ArrayBuffer>;
  /** Nome legível para o card do WhatsApp (ver `nomeArquivoWhatsapp`). */
  nomeArquivo: string;
  marca: Marca;
  paginas: number;
}

/** Rodapé por marca. O de PPGVET é o texto de sempre do PDF do navegador. */
const RODAPE: Record<Marca, string> = {
  ppgvet: "PPGVet Educação",
  ppg: "PPG Educação",
};

/**
 * A marca do curso. 'ppgvet' e 'ppg' são os únicos valores que o CHECK do banco aceita, e o
 * default da coluna é 'ppgvet'. Vazio só acontece em turma sem pós vinculada; aí sai PPG
 * Educação, que é a marca guarda-chuva (migration 20260906130000): nunca é errada, e o logo
 * PPGVET num curso que não é de veterinária é exatamente o que a marca existe para evitar.
 */
export function marcaDoCurso(marca: string | null | undefined): Marca {
  const m = String(marca ?? "").trim().toLowerCase();
  return m === "ppgvet" ? "ppgvet" : "ppg";
}

/**
 * Módulos gravados (EAD) como linhas do cronograma: 1 linha por módulo, no mês de liberação (o
 * PDF agrupa por mês e escreve "No mês" em vez do dia). Mesmo mapeamento dos dois chamadores do
 * front (TurmaDetalhePage e BlocoTurmas), sem o travessão na ementa.
 */
export function eadComoAulas(rows: EadCronogramaRow[] | null | undefined): CronogramaAlunoAula[] {
  return (rows ?? []).map((r) => ({
    data: r.data_liberacao_planejada,
    horario: "Plataforma",
    titulo: `Módulo ${String(r.modulo_numero ?? "").padStart(2, "0")} · ${r.modulo_nome ?? ""}`.trim(),
    ementa: Array.isArray(r.aulas) && r.aulas.length
      ? `Módulo gravado (EAD). Aulas: ${r.aulas.join("; ")}.`
      : "Módulo gravado (EAD), disponibilizado na plataforma neste mês.",
    tipo_aula: "gravado",
  }));
}

/**
 * Nome do arquivo que o aluno vê no card do WhatsApp: "Cronograma - <curso> - Turma 02-26 #01.pdf".
 * A barra do nome da turma ("02/26 #01") e os outros caracteres proibidos em nome de arquivo
 * viram "-". Acento fica: o WhatsApp mostra UTF-8 sem problema. Para cabeçalho HTTP, use
 * `nomeArquivoAscii` por cima deste.
 */
export function nomeArquivoWhatsapp(turma: CronogramaAlunoTurma): string {
  const limpa = (s: string | null | undefined) =>
    String(s ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim();
  const curso = limpa(turma.pos?.nome);
  const nomeTurma = limpa(turma.nome);
  const partes = ["Cronograma"];
  if (curso) partes.push(curso);
  if (nomeTurma) partes.push(/^turma\b/i.test(nomeTurma) ? nomeTurma : `Turma ${nomeTurma}`);
  return `${partes.join(" - ").slice(0, 150).trim()}.pdf`;
}

/**
 * O mesmo nome só com ASCII imprimível, para o `filename="..."` do Content-Disposition (valor
 * de header é ByteString; o nome com acento vai no `filename*`). Aspas e barra invertida saem.
 */
export function nomeArquivoAscii(nome: string): string {
  const ascii = nome
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return ascii && ascii !== ".pdf" ? ascii : "cronograma.pdf";
}

export function renderCronogramaAlunoPdf(deps: DepsPdf, entrada: EntradaCronograma): PdfGerado {
  const { jsPDF, autoTable } = deps;
  const { turma, aulas } = entrada;
  const praticos = entrada.praticos ?? [];
  const marca = marcaDoCurso(entrada.marca);
  const logo: LogoPdf = LOGOS[marca];
  const nomeArquivo = nomeArquivoWhatsapp(turma);

  const doc = new jsPDF({ unit: "pt", format: "a4", compress: entrada.comprimir ?? true });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const marginX = 40;
  const contentW = pageW - marginX * 2;

  doc.setProperties({
    title: nomeArquivo.replace(/\.pdf$/i, ""),
    subject: "Cronograma de aulas",
    author: RODAPE[marca],
    creator: RODAPE[marca],
  });

  // Paleta inspirada no modelo PPGVET (idêntica à do navegador)
  const TEAL: [number, number, number] = [58, 154, 147];
  const TEAL_BG: [number, number, number] = [214, 240, 235];
  const PINK: [number, number, number] = [232, 58, 125];
  const PINK_BG: [number, number, number] = [253, 235, 239];
  const YELLOW_BG: [number, number, number] = [253, 243, 214];
  const YELLOW_BORDER: [number, number, number] = [232, 176, 78];
  const PURPLE: [number, number, number] = [142, 58, 120];
  const GRAY_TXT: [number, number, number] = [80, 80, 80];

  // -------- Cabeçalho com logo --------
  // Caixa de 56 pt (a altura do logo PPGVET de sempre) com o logo da marca centralizado nela:
  // o resto da página fica exatamente onde está no PDF do navegador, qualquer que seja a marca.
  const caixaLogoH = 56;
  const logoH = Math.min(logo.alturaPt, caixaLogoH);
  const logoW = (logoH * logo.largura) / logo.altura;
  doc.addImage(
    logo.dataUrl, "PNG",
    (pageW - logoW) / 2, 36 + (caixaLogoH - logoH) / 2, logoW, logoH,
    `logo-${marca}`, "FAST",
  );

  // Faixa "CRONOGRAMA DE AULAS"
  let cursorY = 36 + caixaLogoH + 18;
  doc.setFillColor(...PINK_BG);
  doc.rect(marginX, cursorY, contentW, 36, "F");
  doc.setTextColor(...PINK);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("CRONOGRAMA DE AULAS", pageW / 2, cursorY + 16, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(...GRAY_TXT);
  doc.text(`Pós-Graduação em ${turma.pos?.nome ?? "-"}`, pageW / 2, cursorY + 30, { align: "center" });
  cursorY += 36 + 14;

  // -------- Cards (Início das aulas ao vivo / Duração) --------
  const cardW = (contentW - 14) / 2;
  const cardH = 70;
  const fmtBR = (iso: string | null) => {
    if (!iso) return "-";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  };
  const periodoMeses = turma.pos?.periodo_total_meses ?? "-";

  // Card 1 (verde): início das aulas ao vivo. Só a data de INÍCIO: o término já está coberto
  // pelo card de duração ao lado (decisão do diretor, 09/07/2026).
  doc.setFillColor(...TEAL_BG);
  doc.rect(marginX, cursorY, cardW, cardH, "F");
  doc.setTextColor(...TEAL);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text("INÍCIO DAS AULAS AO VIVO", marginX + cardW / 2, cursorY + 16, { align: "center" });
  doc.setTextColor(40, 40, 40);
  doc.setFontSize(14);
  doc.text(fmtBR(turma.data_inicio), marginX + cardW / 2, cursorY + 38, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(...GRAY_TXT);
  doc.text("Data referente apenas às aulas ao vivo deste cronograma", marginX + cardW / 2, cursorY + 56, { align: "center" });

  // Card 2 (rosa): duração total
  const card2X = marginX + cardW + 14;
  doc.setFillColor(...PINK_BG);
  doc.rect(card2X, cursorY, cardW, cardH, "F");
  doc.setTextColor(...PINK);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text("DURAÇÃO TOTAL DA PÓS-GRADUAÇÃO", card2X + cardW / 2, cursorY + 16, { align: "center" });
  doc.setTextColor(40, 40, 40);
  doc.setFontSize(14);
  doc.text(`${periodoMeses} meses a partir da matrícula`, card2X + cardW / 2, cursorY + 38, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(...GRAY_TXT);
  doc.text("Contados a partir da data de matrícula ou assinatura do contrato", card2X + cardW / 2, cursorY + 56, { align: "center" });

  cursorY += cardH + 14;

  // -------- Aviso importante (amarelo) --------
  const avisoH = 88;
  doc.setFillColor(...YELLOW_BG);
  doc.setDrawColor(...YELLOW_BORDER);
  doc.setLineWidth(0.8);
  doc.rect(marginX, cursorY, contentW, avisoH, "FD");
  // Barra lateral
  doc.setFillColor(...YELLOW_BORDER);
  doc.rect(marginX, cursorY, 4, avisoH, "F");

  doc.setTextColor(160, 100, 20);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("AVISO IMPORTANTE", marginX + 14, cursorY + 14);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(70, 50, 10);
  doc.setFontSize(8);
  const avisoLinhas = [
    "Este cronograma é sujeito a alterações de datas, dias da semana, ordem de aulas e professores conforme disponibilidade e necessidades pedagógicas.",
    "Quando houver necessidade de reposição, a comunicação será realizada pelo Grupo da Turma no WhatsApp com antecedência.",
  ];
  let avY = cursorY + 30;
  avisoLinhas.forEach((linha) => {
    const wrapped = doc.splitTextToSize(linha, contentW - 24);
    doc.text(wrapped, marginX + 14, avY);
    avY += wrapped.length * 10 + 4;
  });
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text(
    "Poderá haver inclusão de aulas na terça, quarta ou quinta-feira. Nossa prioridade é garantir a entrega dos conteúdos.",
    marginX + 14,
    avY,
    { maxWidth: contentW - 24 },
  );

  cursorY += avisoH + 12;

  // -------- Tabela por mês --------
  const MESES = [
    "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO",
    "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
  ];
  const DOWS = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];

  // Linhas: pré-abertura (sem data) primeiro, depois aulas por mês, depois as aulas sem data
  // restantes (caso existam).
  // deno-lint-ignore no-explicit-any
  type Row = (string | { content: string; colSpan?: number; styles?: any })[];
  const rows: Row[] = [];
  let lastBucket = "";
  const semData = (a: CronogramaAlunoAula) => !a.data;
  const ordenadas = [...aulas].sort((a, b) => (a.data ?? "").localeCompare(b.data ?? ""));
  const preAbertura = ordenadas.filter((a) => semData(a) && a.tipo_aula === "pre_abertura");
  const outrasSemData = ordenadas.filter((a) => semData(a) && a.tipo_aula !== "pre_abertura");
  const comData = ordenadas.filter((a) => !semData(a));

  // O cronograma do aluno NÃO mostra professor: substituição de professor é comum durante o
  // semestre, e exibir isso no PDF público gera confusão e reduz engajamento.
  // Horário é texto livre ("19:00-22:00", "19:00 às 22:00", "19:00:00"...): normaliza para
  // "HH:MM - HH:MM" SEM truncar; texto sem hora ("Plataforma") passa como está.
  const fmtHorario = (raw: string) => {
    const horas = raw.match(/\d{1,2}:\d{2}/g);
    return horas?.length ? horas.slice(0, 2).join(" - ") : raw;
  };
  const renderAulaRow = (a: CronogramaAlunoAula, dataStr: string) => {
    const horario = a.horario
      ? fmtHorario(String(a.horario))
      : `${turma.horario_inicio?.slice(0, 5) ?? "-"} - ${turma.horario_fim?.slice(0, 5) ?? "-"}`;
    return [a.titulo ?? "-", dataStr, horario, a.ementa ?? ""];
  };

  if (preAbertura.length > 0) {
    rows.push([{ content: "PRÉ-ABERTURA (a confirmar)", colSpan: 4, styles: { fillColor: YELLOW_BG, textColor: [160, 100, 20], fontStyle: "bold", halign: "center", fontSize: 9 } }]);
    preAbertura.forEach((a) => rows.push(renderAulaRow(a, "A definir") as Row));
  }

  comData.forEach((a) => {
    const [y, m] = (a.data as string).split("-");
    const bucket = `MÓDULO ${MESES[Number(m) - 1]} ${y}`;
    if (bucket !== lastBucket) {
      rows.push([{ content: bucket, colSpan: 4, styles: { fillColor: TEAL_BG, textColor: [40, 40, 40], fontStyle: "bold", halign: "center", fontSize: 9 } }]);
      lastBucket = bucket;
    }
    const d = new Date(a.data + "T12:00:00Z");
    const diaBr = `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
    const dow = DOWS[d.getUTCDay()];
    // Módulo gravado (EAD) é liberação MENSAL: mostra só o mês (o cabeçalho do bloco já diz
    // qual), sem dia específico.
    const dataStr = a.tipo_aula === "gravado" ? "No mês" : `${diaBr}\n${dow}`;
    rows.push(renderAulaRow(a, dataStr) as Row);
  });

  if (outrasSemData.length > 0) {
    rows.push([{ content: "AULAS A DEFINIR", colSpan: 4, styles: { fillColor: YELLOW_BG, textColor: [160, 100, 20], fontStyle: "bold", halign: "center", fontSize: 9 } }]);
    outrasSemData.forEach((a) => rows.push(renderAulaRow(a, "A definir") as Row));
  }

  // Rodapé em todas as páginas. Extraído porque a seção de práticos é uma SEGUNDA autoTable e
  // o didDrawPage só roda nas páginas criadas pela tabela que o registrou: sem passar o mesmo
  // hook, a página final sairia sem rodapé.
  const desenharRodape = () => {
    doc.setFontSize(8);
    doc.setTextColor(...GRAY_TXT);
    doc.setFont("helvetica", "bold");
    doc.text(RODAPE[marca], marginX, pageH - 30);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.text(
      `Cronograma ${turma.pos?.nome ?? ""} · ${turma.nome ?? ""}`,
      marginX,
      pageH - 18,
    );
    doc.setFontSize(7);
    const pageNum = doc.internal.getNumberOfPages();
    doc.text(`Página ${pageNum}`, pageW - marginX, pageH - 30, { align: "right" });
    doc.text(
      "Documento gerado automaticamente, sujeito a alterações",
      pageW - marginX,
      pageH - 18,
      { align: "right" },
    );
  };

  autoTable(doc, {
    startY: cursorY,
    head: [["AULA", "DATA / DIA", "HORÁRIO", "EMENTA"]],
    body: rows,
    styles: { fontSize: 7.5, cellPadding: 5, valign: "top", textColor: [40, 40, 40] },
    headStyles: { fillColor: PURPLE, textColor: 255, fontStyle: "bold", halign: "left", fontSize: 8 },
    columnStyles: {
      0: { cellWidth: 150, fontStyle: "bold" },
      1: { cellWidth: 70 },
      2: { cellWidth: 60 },
      3: { cellWidth: "auto" },
    },
    margin: { left: marginX, right: marginX, top: 60, bottom: 50 },
    didDrawPage: desenharRodape,
  });

  // -------- Módulos práticos presenciais (semipresencial) --------
  // Tabela própria, no fim, em BLOCOS: uma banda roxa por MÓDULO (o que o aluno precisa fazer)
  // e, dentro, uma banda verde por PRAÇA (cidade + período: ele escolhe uma). A lista corrida
  // antiga repetia módulo e local em toda linha e o diretor leu como bagunça (31/08/2026).
  if (praticos.length > 0) {
    const modulos = agruparPraticos(praticos);
    const praticoRows: Row[] = [
      [{
        content: "MÓDULOS PRÁTICOS PRESENCIAIS",
        colSpan: 3,
        styles: { fillColor: PINK_BG, textColor: PINK, fontStyle: "bold", halign: "center", fontSize: 10 },
      }],
      [{
        content: TARJA_PRATICO_LONGA,
        colSpan: 3,
        styles: { fillColor: YELLOW_BG, textColor: [110, 75, 15], fontStyle: "bold", halign: "left", fontSize: 7.5 },
      }],
    ];

    modulos.forEach((mod) => {
      const nPracas = mod.pracas.length;
      praticoRows.push([{
        content: `${mod.titulo}   ·   ${nPracas} ${nPracas === 1 ? "opção de cidade" : "opções de cidade, escolha uma"}`,
        colSpan: 3,
        styles: { fillColor: PURPLE, textColor: 255, fontStyle: "bold", halign: "left", fontSize: 8.5 },
      }]);

      mod.pracas.forEach((praca) => {
        praticoRows.push([{
          content: `${praca.local}   ·   ${praca.periodo}`,
          colSpan: 3,
          styles: { fillColor: TEAL_BG, textColor: [25, 70, 66], fontStyle: "bold", halign: "left", fontSize: 8 },
        }]);

        // UMA linha por dia: manhã + tarde viram um período só ("08:00 - 18:00") com as duas
        // ementas juntas. Quebrar 08-12 e 13-18 em duas linhas parecia sessão duplicada
        // (decisão do diretor, 31/08/2026).
        praca.dias.forEach((dia) => {
          const d = new Date(dia.data + "T12:00:00Z");
          const diaBr = `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
          praticoRows.push([
            `${diaBr}\n${DOWS[d.getUTCDay()]}`,
            dia.horario ?? "A confirmar",
            dia.ementa,
          ]);
        });
      });
    });

    autoTable(doc, {
      startY: (doc.lastAutoTable?.finalY ?? cursorY) + 18,
      head: [["DATA / DIA", "HORÁRIO", "O QUE SE FAZ NO DIA"]],
      body: praticoRows,
      styles: { fontSize: 7.5, cellPadding: 5, valign: "top", textColor: [40, 40, 40] },
      headStyles: { fillColor: PURPLE, textColor: 255, fontStyle: "bold", halign: "left", fontSize: 8 },
      columnStyles: {
        0: { cellWidth: 78, fontStyle: "bold" },
        1: { cellWidth: 62 },
        2: { cellWidth: "auto" },
      },
      margin: { left: marginX, right: marginX, top: 60, bottom: 50 },
      didDrawPage: desenharRodape,
    });
  }

  return {
    bytes: new Uint8Array(doc.output("arraybuffer") as ArrayBuffer),
    nomeArquivo,
    marca,
    paginas: doc.internal.getNumberOfPages(),
  };
}
