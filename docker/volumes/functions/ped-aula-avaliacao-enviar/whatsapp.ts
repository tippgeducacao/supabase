// Régua PURA do envio da avaliação pelo WhatsApp (sem Deno, sem rede — tem teste no vitest).
//
// Pedido do Rafael (2026-10-01): "alguns professores não têm e-mail ou os e-mails caem na lista
// de spam… envie esse NPS da aula pelo WhatsApp também, pelo número do pedagógico, com um
// template aprovado de Utilidade". O modelo é `avaliacao_aula_professor`: cabeçalho DOCUMENTO
// (o PDF da avaliação) + corpo com 5 variáveis + rodapé.
//
// ⚠️ ESPELHO: o texto do corpo e a ordem das variáveis vivem também em
// src/components/pedagogico-v2/planilha/avaliacaoEnvioCampos.ts (a PRÉVIA que a equipe aprova).
// Mudou aqui → mude lá, e vice-versa. E o texto só muda junto com uma nova aprovação na Meta:
// editar o modelo aprovado tira ele do ar durante a reanálise (ver docs/RH — Mensagens do Candidato.md).

export const TEMPLATE_WA_AVALIACAO = "avaliacao_aula_professor";
export const TEMPLATE_WA_IDIOMA = "pt_BR";

/**
 * O texto SUBMETIDO à Meta (categoria UTILITY). Fica aqui como registro do que foi aprovado e é a
 * fonte que a prévia da tela espelha (o teste do front compara os dois). ⚠️ A variável não pode
 * abrir nem fechar o texto (2388299) e cada uma tem de vir cercada de texto fixo.
 */
export const CORPO_MODELO_WA =
  "Olá, {{1}}! Tudo bem?\n\n" +
  "Os alunos avaliaram a sua aula *{{2}}*, do dia {{3}}, e queremos compartilhar o retorno com você.\n\n" +
  "Nota média dos alunos: *{{4}} de 10*, com base em {{5}}.\n\n" +
  "O relatório completo está no PDF acima. Obrigado por seguir com a gente, esse retorno ajuda a gente a evoluir junto.";
export const RODAPE_MODELO_WA = "Equipe Pedagógica PPGVET";

/** Teto do PDF que aceitamos no corpo do POST (o da avaliação tem ~200–600 KB por página). */
export const PDF_MAX_BYTES = 8 * 1024 * 1024;

/** 'YYYY-MM-DD' → 'DD/MM/AAAA' pela string, sem Date (que volta um dia em BRT). */
export function dataBR(iso?: string | null): string {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/** 9.7 → "9,70" (2 casas, regra de ouro). Inválido/ausente → "" (quem chama barra o vazio). */
export function nota2(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2).replace(".", ",") : "";
}

/**
 * Parâmetro de template da Meta: sem quebra de linha, tab nem 4+ espaços (erro 132000/131009) e
 * NUNCA vazio (131008 recusa o modelo inteiro e nada é entregue). Limite folgado de tamanho.
 */
export function paramWa(v: unknown): string {
  return String(v ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, 300);
}

export type DadosWhatsapp = {
  professorNome: string | null | undefined;
  titulo: string | null | undefined;
  data: string | null | undefined;
  nota: number;
  total: number;
};

/**
 * As 5 variáveis do corpo, NA ORDEM do modelo:
 *   {{1}} primeiro nome · {{2}} título da aula · {{3}} data · {{4}} nota · {{5}} "17 respostas"
 * Devolve `faltando` em vez de mandar vazio — variável vazia derruba o envio inteiro na Meta.
 */
export function parametrosWhatsapp(d: DadosWhatsapp): { ok: true; valores: string[] } | { ok: false; faltando: string } {
  const primeiro = paramWa(String(d.professorNome ?? "").trim().split(/\s+/)[0]) || "professor(a)";
  const valores = [
    primeiro,
    paramWa(d.titulo),
    dataBR(d.data),
    nota2(d.nota),
    `${d.total} ${d.total === 1 ? "resposta" : "respostas"}`,
  ];
  const nomes = ["nome", "título da aula", "data da aula", "nota", "respostas"];
  const i = valores.findIndex((v) => !v);
  if (i >= 0) return { ok: false, faltando: nomes[i] };
  return { ok: true, valores };
}

/** Componentes do corpo no formato do crm-whatsapp-send (o cabeçalho ele injeta pelo header_media_url). */
export function componentesDoCorpo(valores: string[]) {
  return [{ type: "body", parameters: valores.map((text) => ({ type: "text", text })) }];
}

/**
 * Nome do PDF que o professor vê no card do WhatsApp e no anexo do e-mail. Sem barra (vira
 * caminho), sem controle, com teto — e sempre terminando em .pdf.
 */
export function nomeDoPdf(pedido: unknown, titulo: string | null | undefined, data: string | null | undefined): string {
  const limpa = (s: string) =>
    s.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s{2,}/g, " ").trim();
  let nome = limpa(String(pedido ?? ""));
  if (!nome) {
    const dt = dataBR(data).replace(/\//g, "-");
    nome = limpa(`Avaliação da aula - ${String(titulo ?? "").trim() || "aula"}${dt ? ` - ${dt}` : ""}`);
  }
  nome = nome.replace(/\.pdf$/i, "").slice(0, 110).trim();
  return `${nome || "Avaliação da aula"}.pdf`;
}

/** Caminho ASCII no bucket (o nome bonito vai no `filename`, não no path). */
export function slugArquivo(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60) || "avaliacao";
}

/**
 * base64 (com ou sem prefixo data:) → bytes de um PDF de verdade. Recusa o que não começa com
 * "%PDF-" e o que passa do teto — o arquivo vai para bucket público e para o professor.
 */
export function decodificarPdf(b64: unknown): { ok: true; bytes: Uint8Array } | { ok: false; erro: string } {
  if (typeof b64 !== "string" || !b64.trim()) return { ok: false, erro: "PDF vazio" };
  const limpo = (b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64).replace(/\s+/g, "");
  // estimativa antes de decodificar: base64 ocupa 4/3 do binário
  if (limpo.length * 0.75 > PDF_MAX_BYTES + 4) return { ok: false, erro: "PDF grande demais" };
  let bin: string;
  try {
    bin = atob(limpo);
  } catch {
    return { ok: false, erro: "PDF em base64 inválido" };
  }
  if (bin.length > PDF_MAX_BYTES) return { ok: false, erro: "PDF grande demais" };
  if (!bin.startsWith("%PDF-")) return { ok: false, erro: "o arquivo não é um PDF" };
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { ok: true, bytes };
}

/** bytes → base64 padrão (anexo MIME), em blocos para não estourar a pilha em PDF grande. */
export function bytesParaBase64(bytes: Uint8Array): string {
  let bin = "";
  const BLOCO = 0x8000;
  for (let i = 0; i < bytes.length; i += BLOCO) {
    bin += String.fromCharCode(...bytes.subarray(i, i + BLOCO));
  }
  return btoa(bin);
}

const ERRO_META: Record<number, string> = {
  131026: "o número não tem WhatsApp ou bloqueou a conta",
  131042: "a conta do WhatsApp do pedagógico está com pendência de pagamento/cadastro na Meta",
  131047: "a Meta recusou por janela de conversa",
  131049: "a Meta recusou a entrega para este número",
  131053: "a Meta não conseguiu baixar o PDF",
  132000: "o número de variáveis não bate com o modelo aprovado na Meta",
  132001: "o modelo de mensagem ainda não foi aprovado pela Meta",
  132012: "os dados enviados não batem com o modelo aprovado",
  132015: "o modelo de mensagem está pausado pela Meta",
  132016: "o modelo de mensagem foi desativado pela Meta",
  190: "o token do WhatsApp do pedagógico expirou",
};

/** Resposta de erro do crm-whatsapp-send → frase para a equipe. */
export function erroWhatsappAmigavel(resp: Record<string, unknown> | null | undefined, status: number): string {
  const r = resp ?? {};
  if (r.error === "telefone_impossivel") return "o WhatsApp cadastrado na ficha do professor não é um número válido";
  if (r.code === "anexo_indisponivel") return "o PDF não pôde ser lido pela Meta";
  const code = Number(r.meta_code);
  if (Number.isFinite(code) && ERRO_META[code]) return ERRO_META[code];
  const msg = String(r.error ?? "").trim();
  return msg || `falha no envio (HTTP ${status})`;
}

const STATUS_MODELO: Record<string, string> = {
  PENDING: "em análise",
  IN_APPEAL: "em recurso",
  REJECTED: "recusado",
  PAUSED: "pausado",
  DISABLED: "desativado",
  PENDING_DELETION: "sendo apagado",
  INEXISTENTE: "inexistente nesta conta",
};

/** Status do modelo na Meta → frase para a equipe ("em análise", "pausado"…). */
export function traduzirStatusModelo(status: string): string {
  return STATUS_MODELO[status] ?? status.toLowerCase();
}
