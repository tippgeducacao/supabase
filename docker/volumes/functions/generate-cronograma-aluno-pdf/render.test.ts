import { describe, expect, it } from "vitest";
import * as jspdfMod from "jspdf";
import { autoTable } from "jspdf-autotable";
import {
  eadComoAulas,
  marcaDoCurso,
  nomeArquivoAscii,
  nomeArquivoWhatsapp,
  renderCronogramaAlunoPdf,
  type CronogramaAlunoAula,
  type CronogramaAlunoTurma,
} from "./render.ts";
import { normalizarPraticos, type PraticoCronogramaRow } from "./praticos.ts";

// jspdf no Node é CJS (dist/jspdf.node.min.js): o nome pode vir no namespace ou no default.
// deno-lint-ignore no-explicit-any
const ns = jspdfMod as any;
const jsPDF = ns.jsPDF ?? ns.default?.jsPDF ?? ns.default;
const deps = { jsPDF, autoTable };

const turma: CronogramaAlunoTurma = {
  nome: "02/26 #01",
  data_inicio: "2026-08-04",
  data_fim: "2027-06-29",
  horario_inicio: "19:00:00",
  horario_fim: "22:00:00",
  pos: { nome: "Clínica Médica e Cirúrgica de Bovinos 2026", periodo_total_meses: 18 },
};

const EMENTA = "Anatomia geral dos bovinos, estrutura óssea e muscular, anatomia topográfica e localização dos principais órgãos em cirurgias de bovinos.";

/** 60 aulas no tamanho real da turma c9af5ece: 1 pré-abertura sem data, 58 semanais, 1 a definir. */
function aulasDaTurma(): CronogramaAlunoAula[] {
  const aulas: CronogramaAlunoAula[] = [
    { data: null, horario: null, titulo: "Aula de pré-abertura", ementa: EMENTA, tipo_aula: "pre_abertura" },
  ];
  const ini = Date.parse("2026-08-05T12:00:00Z");
  for (let i = 0; i < 58; i++) {
    aulas.push({
      data: new Date(ini + i * 7 * 86400000).toISOString().slice(0, 10),
      horario: i % 2 ? "19:00 às 22:00" : "19:00 - 22:00",
      titulo: `Aula ${i + 1}: Cirurgias do Aparelho Gastrointestinal`,
      ementa: `Tópico ${i + 1}: ${EMENTA}`,
      tipo_aula: "Curricular",
    });
  }
  aulas.push({ data: null, horario: null, titulo: "Aula sem data ainda", ementa: "Conteúdo a confirmar.", tipo_aula: "Curricular" });
  return aulas;
}

const praticosRows: PraticoCronogramaRow[] = [
  { aula_id: "a1", modulo_id: "m1", modulo_titulo: "MÓDULO PRÁTICO DE REPRODUÇÃO", cidade: "Cacique Doble - RS", data: "2026-10-15", horario: "08:00 - 12:00", titulo: null, ementa: "Aspiração folicular", antes_do_inicio: false },
  { aula_id: "a2", modulo_id: "m1", modulo_titulo: "MÓDULO PRÁTICO DE REPRODUÇÃO", cidade: "Cacique Doble - RS", data: "2026-10-15", horario: "13:00 - 18:00", titulo: null, ementa: "Transferência de embrião", antes_do_inicio: false },
  { aula_id: "a3", modulo_id: "m2", modulo_titulo: "MÓDULO PRÁTICO DE REPRODUÇÃO", cidade: "Ampére - PR", data: "2026-11-20", horario: "08h - 18h", titulo: null, ementa: "Ultrassonografia", antes_do_inicio: false },
  // anterior ao início da turma: o aluno não alcança, não pode sair no PDF
  { aula_id: "a0", modulo_id: "m0", modulo_titulo: "MÓDULO PRÁTICO ANTIGO", cidade: "Patos de Minas - MG", data: "2026-06-01", horario: "08:00 - 18:00", titulo: null, ementa: "Sessão que já passou", antes_do_inicio: true },
];

/** Bytes → texto (windows-1252, a codificação das fontes padrão do jsPDF). */
const comoTexto = (bytes: Uint8Array) => new TextDecoder("windows-1252").decode(bytes);

/** Só o que é TEXTO desenhado na página: operandos de Tj, sem os bytes das imagens. */
function textoDasPaginas(pdf: string): string {
  const partes: string[] = [];
  for (const m of pdf.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) partes.push(m[1].replace(/\\(.)/g, "$1"));
  return partes.join("\n");
}

function entrada(opts: { marca?: string | null; aulas?: CronogramaAlunoAula[] } = {}) {
  return {
    turma,
    aulas: opts.aulas ?? [
      ...aulasDaTurma(),
      ...eadComoAulas([{ modulo_numero: 3, modulo_nome: "Bem-estar animal", data_liberacao_planejada: "2026-12-10", aulas: ["Etologia", "Manejo"] }]),
    ],
    praticos: normalizarPraticos(praticosRows, { somenteAPartirDoInicioDaTurma: true }),
    marca: opts.marca === undefined ? "ppgvet" : opts.marca,
  };
}

function gerar(opts: { marca?: string | null; aulas?: CronogramaAlunoAula[] } = {}) {
  const pdf = renderCronogramaAlunoPdf(deps, { ...entrada(opts), comprimir: false });
  const bruto = comoTexto(pdf.bytes);
  return { pdf, bruto, texto: textoDasPaginas(bruto) };
}

describe("renderCronogramaAlunoPdf (edge)", () => {
  it("gera um PDF de verdade, leve o bastante para anexo de WhatsApp", () => {
    const { pdf, bruto } = gerar();
    expect(bruto.startsWith("%PDF-")).toBe(true);
    // o PDF do navegador, com o logo de 1920 px cru, pesa ~8,38 MB
    expect(pdf.bytes.length).toBeLessThan(400 * 1024);
    expect(pdf.paginas).toBeGreaterThan(1);
  });

  it("mantém o layout do navegador: faixa, cards, bandas por mês e a coluna de ementa", () => {
    const { texto } = gerar();
    expect(texto).toContain("CRONOGRAMA DE AULAS");
    expect(texto).toContain("Pós-Graduação em Clínica Médica e Cirúrgica de Bovinos 2026");
    expect(texto).toContain("INÍCIO DAS AULAS AO VIVO");
    expect(texto).toContain("04/08/2026");
    expect(texto).toContain("18 meses a partir da matrícula");
    expect(texto).toContain("EMENTA");
    expect(texto).toContain("MÓDULO AGOSTO 2026");
    expect(texto).toContain("PRÉ-ABERTURA (a confirmar)");
    expect(texto).toContain("AULAS A DEFINIR");
    expect(texto).toContain("Tópico 1:");
    expect(texto).toContain("Tópico 58:");
    // horário normalizado, nunca truncado
    expect(texto).toContain("19:00 - 22:00");
    expect(texto).not.toContain("19:00 às 22:00");
  });

  it("módulo gravado (EAD) sai no mês, sem dia, com a ementa das aulas", () => {
    const { texto } = gerar();
    expect(texto).toContain("No mês");
    expect(texto).toContain("Módulo 03 · Bem-estar animal");
    expect(texto).toContain("Módulo gravado (EAD). Aulas: Etologia; Manejo.");
  });

  it("práticos: bloco próprio no fim, tarja de semipresencial, praça por cidade e sem sessão anterior ao início", () => {
    const { texto } = gerar();
    expect(texto).toContain("MÓDULOS PRÁTICOS PRESENCIAIS");
    expect(texto).toContain("SEMIPRESENCIAL");
    expect(texto).toContain("opções de cidade, escolha uma");
    expect(texto).toContain("Cacique Doble - RS");
    expect(texto).toContain("08:00 - 18:00");
    expect(texto).not.toContain("Sessão que já passou");
  });

  it("nenhum travessão vindo de texto fixo (placeholder, rodapé, EAD, práticos)", () => {
    const semHorario = aulasDaTurma().map((a) => ({ ...a, horario: null, titulo: null }));
    const { texto } = gerar({ aulas: [...semHorario, ...eadComoAulas([{ modulo_numero: 1, modulo_nome: null, data_liberacao_planejada: "2026-09-10", aulas: null }])] });
    expect(texto).toContain("Documento gerado automaticamente, sujeito a alterações");
    expect(texto).toContain("Cronograma Clínica Médica e Cirúrgica de Bovinos 2026 · 02/26 #01");
    expect(texto).not.toContain("—");
  });

  it("marca PPGVET: logo PPGVET (480 px) e rodapé PPGVet Educação", () => {
    const { pdf, bruto, texto } = gerar({ marca: "ppgvet" });
    expect(pdf.marca).toBe("ppgvet");
    expect(texto).toContain("PPGVet Educação");
    expect(bruto).toMatch(/\/Width 480\b/);
    expect(bruto).not.toMatch(/\/Width 909\b/);
  });

  it("marca PPG: nunca o logo PPGVET em curso de público não veterinário", () => {
    const { pdf, bruto, texto } = gerar({ marca: "ppg" });
    expect(pdf.marca).toBe("ppg");
    expect(texto).toContain("PPG Educação");
    expect(texto).not.toContain("PPGVet");
    expect(bruto).toMatch(/\/Width 909\b/);
    expect(bruto).not.toMatch(/\/Width 480\b/);
  });

  it("compressão ligada por padrão encolhe o arquivo", () => {
    const aberto = renderCronogramaAlunoPdf(deps, { ...entrada(), comprimir: false }).bytes.length;
    const comprimido = renderCronogramaAlunoPdf(deps, entrada()).bytes.length;
    expect(comprimido).toBeLessThan(aberto);
  });
});

describe("marca e nome do arquivo", () => {
  it("marca desconhecida cai no PPG Educação (guarda-chuva), nunca no PPGVET", () => {
    expect(marcaDoCurso("ppgvet")).toBe("ppgvet");
    expect(marcaDoCurso(" PPGVET ")).toBe("ppgvet");
    expect(marcaDoCurso("ppg")).toBe("ppg");
    expect(marcaDoCurso(null)).toBe("ppg");
    expect(marcaDoCurso("outra")).toBe("ppg");
  });

  it("nome legível para o card do WhatsApp, com a barra da turma trocada", () => {
    expect(nomeArquivoWhatsapp(turma)).toBe("Cronograma - Clínica Médica e Cirúrgica de Bovinos 2026 - Turma 02-26 #01.pdf");
    expect(nomeArquivoWhatsapp({ ...turma, nome: "Turma 3" })).toBe("Cronograma - Clínica Médica e Cirúrgica de Bovinos 2026 - Turma 3.pdf");
  });

  it("versão ASCII para o Content-Disposition", () => {
    expect(nomeArquivoAscii(nomeArquivoWhatsapp(turma))).toBe("Cronograma - Clinica Medica e Cirurgica de Bovinos 2026 - Turma 02-26 #01.pdf");
    expect(nomeArquivoAscii('a"b\\c.pdf')).toBe("abc.pdf");
    expect(nomeArquivoAscii("")).toBe("cronograma.pdf");
  });
});
