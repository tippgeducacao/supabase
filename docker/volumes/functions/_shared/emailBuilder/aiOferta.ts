/** Condições aprovadas são valores informados pelo responsável, nunca derivados
 * de preço pedagógico, datas de aula ou uma campanha anterior (15/09/2026). */
export interface DadosOfertaEmailIA {
  id: string;
  curso_id: string;
  nome: string;
  preco_centavos: number | null;
  parcelas: number | null;
  valor_parcela_centavos: number | null;
  desconto_pontos_base: number | null;
  vagas_informadas: number | null;
  inicio_em: string;
  fim_em: string;
  url_destino: string;
  condicoes: string;
  disponivel: boolean;
}
export interface OfertaEmailIA extends DadosOfertaEmailIA {
  revisao: number;
  aprovada_por: string;
  aprovada_em: string;
  revogada_em: string | null;
}
export type SituacaoOfertaEmailIA = "vigente" | "programada" | "expirada" | "revogada" | "indisponivel";
export const ROTULOS_SITUACAO_OFERTA: Record<SituacaoOfertaEmailIA, string> = {
  vigente: "Vigente", programada: "Ainda não começou", expirada: "Expirada", revogada: "Revogada", indisponivel: "Indisponível",
};
export const CAMPOS_DADOS_OFERTA = ["id", "curso_id", "nome", "preco_centavos", "parcelas", "valor_parcela_centavos", "desconto_pontos_base", "vagas_informadas", "inicio_em", "fim_em", "url_destino", "condicoes", "disponivel"] as const;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const objeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export class ErroOfertaEmailIA extends Error {
  constructor(public status: number, public code: string, mensagem: string) { super(mensagem); }
}
const invalido = (mensagem: string) => new ErroOfertaEmailIA(400, "INVALID_OFFER", mensagem);
export function validarIdOfertaEmailIA(v: unknown): string {
  if (typeof v !== "string" || !UUID.test(v)) throw invalido("Selecione uma oferta e um curso válidos.");
  return v;
}
function texto(v: unknown, nome: string, max: number, minimo = 1): string {
  if (typeof v !== "string" || v.length > max || v.trim().length < minimo || Array.from(v).some(c => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)))) throw invalido(`Confira o campo ${nome}.`);
  return v.trim();
}
function instante(v: unknown): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) || !Number.isFinite(Date.parse(v))) throw invalido("Informe início e fim com data, horário e fuso válidos.");
  const dia = new Date(`${v.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(dia.getTime()) || dia.toISOString().slice(0, 10) !== v.slice(0, 10) || Number(v.slice(11, 13)) > 23) throw invalido("Informe uma data e horário existentes.");
  const d = new Date(v); if (d.getUTCFullYear() < 2020 || d.getUTCFullYear() > 2100) throw invalido("Confira o ano de validade da oferta.");
  return d.toISOString();
}
function inteiro(v: unknown, nome: string, max: number, minimo = 0): number | null {
  if (v === null || v === undefined) return null;
  if (!Number.isSafeInteger(v) || (v as number) < minimo || (v as number) > max) throw invalido(`Confira o campo ${nome}.`);
  return v as number;
}
export function validarDadosOfertaEmailIA(v: unknown): DadosOfertaEmailIA {
  if (!objeto(v) || Object.keys(v).some(k => !(CAMPOS_DADOS_OFERTA as readonly string[]).includes(k))) throw invalido("Os dados da oferta são inválidos.");
  const inicio_em = instante(v.inicio_em), fim_em = instante(v.fim_em);
  if (inicio_em >= fim_em) throw invalido("O fim da oferta deve ser posterior ao início.");
  const parcelas = inteiro(v.parcelas, "parcelas", 120, 1), valor_parcela_centavos = inteiro(v.valor_parcela_centavos, "valor da parcela", 100000000, 1);
  if ((parcelas === null) !== (valor_parcela_centavos === null)) throw invalido("Informe juntos quantidade e valor das parcelas.");
  let url_destino = texto(v.url_destino, "destino", 2048);
  try { const u = new URL(url_destino); if (u.protocol !== "https:" || u.username || u.password || /[\s{}<>]/.test(url_destino) || !/^[a-z0-9][a-z0-9.-]*$/i.test(u.hostname)) throw new Error(); url_destino = u.href; if (url_destino.length > 2048) throw new Error(); }
  catch { throw invalido("O destino da oferta precisa ser uma URL HTTPS completa."); }
  if (typeof v.disponivel !== "boolean") throw invalido("Informe se a oferta está disponível.");
  return { id: validarIdOfertaEmailIA(v.id), curso_id: validarIdOfertaEmailIA(v.curso_id), nome: texto(v.nome, "nome", 160),
    preco_centavos: inteiro(v.preco_centavos, "preço", 100000000), parcelas, valor_parcela_centavos,
    desconto_pontos_base: inteiro(v.desconto_pontos_base, "desconto", 10000), vagas_informadas: inteiro(v.vagas_informadas, "vagas", 1000000),
    inicio_em, fim_em, url_destino, condicoes: texto(v.condicoes, "condições", 3000, 10), disponivel: v.disponivel };
}
export function validarOfertaEmailIA(v: unknown): OfertaEmailIA {
  if (!objeto(v)) throw invalido("Não foi possível ler a oferta aprovada.");
  const dados = validarDadosOfertaEmailIA(Object.fromEntries(CAMPOS_DADOS_OFERTA.map(k => [k, v[k]])));
  const revisao = inteiro(v.revisao, "revisão", 2147483647, 1);
  if (!revisao) throw invalido("A revisão da oferta é inválida.");
  return { ...dados, revisao, aprovada_por: validarIdOfertaEmailIA(v.aprovada_por), aprovada_em: instante(v.aprovada_em), revogada_em: v.revogada_em == null ? null : instante(v.revogada_em) };
}
export function situacaoOfertaEmailIA(oferta: OfertaEmailIA, agora = new Date()): SituacaoOfertaEmailIA {
  if (!Number.isFinite(agora.getTime())) throw invalido("Não foi possível conferir o horário da oferta.");
  if (oferta.revogada_em) return "revogada";
  if (!oferta.disponivel || oferta.vagas_informadas === 0) return "indisponivel";
  if (agora.getTime() < Date.parse(oferta.inicio_em)) return "programada";
  if (agora.getTime() >= Date.parse(oferta.fim_em)) return "expirada";
  return "vigente";
}
export function exigirOfertaVigenteEmailIA(oferta: OfertaEmailIA, cursoId: unknown, agora = new Date()): void {
  if (oferta.curso_id !== validarIdOfertaEmailIA(cursoId)) throw invalido("A oferta pertence a outro curso. Confira a seleção.");
  const situacao = situacaoOfertaEmailIA(oferta, agora);
  if (situacao !== "vigente") throw new ErroOfertaEmailIA(409, "OFFER_NOT_CURRENT", `A oferta está ${ROTULOS_SITUACAO_OFERTA[situacao].toLowerCase()}. Escolha uma oferta vigente antes de gerar.`);
}
export const formatarCentavosOferta = (v: number) => `R$ ${(v / 100).toFixed(2).replace(".", ",")}`;
export function camposFonteOfertaEmailIA(oferta: OfertaEmailIA): Record<string, string> {
  const horario = (v: string) => new Date(v).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", hour12: false }) + " (America/Sao_Paulo)";
  return {
    "Oferta aprovada": oferta.nome,
    "Curso vinculado": oferta.curso_id,
    "Responsável e revisão": `${oferta.aprovada_por}; revisão ${oferta.revisao}; aprovada em ${oferta.aprovada_em}`,
    "Preço aprovado": oferta.preco_centavos == null ? "Não informado; não completar por suposição." : formatarCentavosOferta(oferta.preco_centavos),
    "Parcelamento aprovado": oferta.parcelas == null ? "Não informado; não calcular parcelas." : `${oferta.parcelas} parcelas de ${formatarCentavosOferta(oferta.valor_parcela_centavos!)}`,
    "Desconto aprovado": oferta.desconto_pontos_base == null ? "Não informado; não calcular desconto." : `${(oferta.desconto_pontos_base / 100).toFixed(2).replace(".", ",")}%`,
    "Vagas informadas pelo responsável": oferta.vagas_informadas == null ? "Não informadas; não inventar escassez." : `${oferta.vagas_informadas}. Quantidade declarada, sem consulta de estoque em tempo real.`,
    "Início da oferta": horario(oferta.inicio_em),
    "Fim da oferta": horario(oferta.fim_em),
    "Destino aprovado": oferta.url_destino,
    "Condições aprovadas": oferta.condicoes,
    "Limite da confirmação": "Validade destas condições comerciais, não prazo geral de matrícula. Não derivar preço total, juros, desconto ou quantidade de vagas. O conteúdo deve respeitar as condições mesmo se referências antigas divergirem.",
  };
}

/** A conversão recusa mais de duas casas; não arredonda valor informado. */
export function lerDecimalOfertaEmailIA(v: string): number | null {
  if (!v.trim()) return null;
  if (!/^\d{1,7}(?:[.,]\d{1,2})?$/.test(v.trim())) throw invalido("Use um número positivo com até duas casas decimais, sem separador de milhar.");
  const [inteira, decimal = ""] = v.trim().replace(",", ".").split(".");
  return Number(inteira) * 100 + Number(decimal.padEnd(2, "0"));
}
