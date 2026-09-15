import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";
import { CAMPOS_CONTAGEM_DESEMPENHO_EMAIL_IA, LIMITE_TEXTO_DESEMPENHO_EMAIL_IA, validarResumoDesempenhoEmailIA, type ResumoDesempenhoEmailIA, type VarianteDesempenhoEmailIA } from "../_shared/emailBuilder/aiDesempenho.ts";

type Objeto = Record<string, unknown>;
const objeto = (v: unknown): v is Objeto => !!v && typeof v === "object" && !Array.isArray(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class ErroDesempenhoEmailIA extends Error {
  constructor(public status: number, public code: string, mensagem: string) { super(mensagem); }
}
const indisponivel = () => new ErroDesempenhoEmailIA(503, "RESULTS_UNAVAILABLE", "Não foi possível conferir os resultados desta campanha. Tente novamente.");
const invalido = () => new ErroDesempenhoEmailIA(400, "BAD_REQUEST", "Escolha uma campanha válida para consultar os resultados.");
const limpar = (v: unknown, max: number): string | null => typeof v === "string" ? v.replace(/\p{Cc}/gu, c => "\n\r\t".includes(c) ? c : "").trim().slice(0, max) : null;

function conteudoVariante(campanha: Objeto, variante: "A" | "B" | "unica") {
  const chave = variante === "A" ? "modelo_a" : "modelo_b";
  const templateId = variante === "B" ? campanha.template_b_id : campanha.template_id;
  const indisponivel = { template_id: typeof templateId === "string" ? templateId : null, nome: null, assunto: null,
    texto: null, texto_resumido: false, origem_conteudo: "indisponivel" as const };
  // Campanha simples não fixa conteúdo. Consultar o template atual ou o log
  // personalizado de alguém inventaria uma associação ou levaria PII para a IA.
  if (variante === "unica" || campanha[`${chave}_id`] !== templateId) return indisponivel;
  const textoOriginal = campanha[`${chave}_texto`];
  return { template_id: typeof templateId === "string" ? templateId : null,
    nome: limpar(campanha[`${chave}_nome`], 240), assunto: limpar(campanha[`${chave}_assunto`], 500),
    texto: limpar(textoOriginal, LIMITE_TEXTO_DESEMPENHO_EMAIL_IA),
    texto_resumido: typeof textoOriginal === "string" && textoOriginal.length > LIMITE_TEXTO_DESEMPENHO_EMAIL_IA,
    origem_conteudo: "snapshot" as const };
}

type ConsultaContagem = PromiseLike<{ count: number | null; error: unknown }>;
async function contar(consulta: ConsultaContagem): Promise<number> {
  const { count, error } = await consulta;
  if (error || !Number.isSafeInteger(count) || count === null || count < 0) throw indisponivel();
  return count;
}

async function contarCampanhaUnica(cliente: SupabaseClient, campanhaId: string) {
  const fila = () => cliente.from("email_campanhas_envios").select("id", { count: "exact", head: true }).eq("campanha_id", campanhaId);
  const logs = () => cliente.from("emails_enviados").select("id", { count: "exact", head: true })
    .eq("contexto_tipo", "campanha").eq("contexto_id", campanhaId)
    // Uma chave por destinatário. Exclui logs manuais e eventuais chaves de outro
    // fluxo. O envio de campanha nunca cria sufixo de retry nessa chave canônica.
    .like("idempotencia_key", "campanha:________-____-____-____-____________");
  // HEAD + count exact agrega no Postgres: nem PII nem respostas cortadas em
  // 1.000 linhas entram no worker. As consultas são leituras, sem processar fila.
  const resultados = await Promise.allSettled([
    contar(fila()), contar(fila().eq("status", "pendente")), contar(fila().eq("status", "pulado")), contar(fila().eq("status", "falhou")),
    contar(logs().or("provider_message_id.not.is.null,status.in.(enviado,entregue,aberto,clicado)")),
    contar(logs().not("entregue_em", "is", null)), contar(logs().or("clicado_count.gt.0,status.eq.clicado")),
    contar(logs().or("aberto_count.gt.0,aberto_em.not.is.null")),
  ]);
  if (resultados.some(r => r.status === "rejected")) throw indisponivel();
  return Object.fromEntries(CAMPOS_CONTAGEM_DESEMPENHO_EMAIL_IA.map((campo, indice) => [campo, (resultados[indice] as PromiseFulfilledResult<number>).value]));
}

/** Chamar somente após autenticação/admin-diretor do handler. O cliente aqui
 * conserva o JWT da pessoa: a RPC exige auth.uid() real e a conta esperada. */
export async function resolverDesempenhoEmailIA(clienteUsuario: SupabaseClient, campanhaId: string, usuarioId: string,
  agora: () => Date = () => new Date()): Promise<ResumoDesempenhoEmailIA> {
  if (!UUID.test(campanhaId) || !UUID.test(usuarioId)) throw invalido();
  try {
    const { data, error } = await clienteUsuario.from("email_campanhas").select([
      "id,nome,status,template_id,template_b_id,iniciada_em,concluida_em",
      "modelo_a_id:modelos_snapshot->A->>id,modelo_a_nome:modelos_snapshot->A->>nome,modelo_a_assunto:modelos_snapshot->A->>assunto,modelo_a_texto:modelos_snapshot->A->>corpo_texto",
      "modelo_b_id:modelos_snapshot->B->>id,modelo_b_nome:modelos_snapshot->B->>nome,modelo_b_assunto:modelos_snapshot->B->>assunto,modelo_b_texto:modelos_snapshot->B->>corpo_texto",
    ].join(",")).eq("id", campanhaId).maybeSingle();
    if (error) throw indisponivel();
    if (!objeto(data)) throw new ErroDesempenhoEmailIA(404, "CAMPAIGN_NOT_FOUND", "Esta campanha não está mais disponível.");
    const campanha = data;
    if (campanha.id !== campanhaId || typeof campanha.nome !== "string" || typeof campanha.status !== "string"
      || typeof campanha.template_id !== "string" || !UUID.test(campanha.template_id)
      || campanha.template_b_id !== null && (typeof campanha.template_b_id !== "string" || !UUID.test(campanha.template_b_id))) throw indisponivel();
    let variantes: VarianteDesempenhoEmailIA[];
    let status: unknown = campanha.status, iniciada: unknown = campanha.iniciada_em, concluida: unknown = campanha.concluida_em;
    let atualizado: unknown;
    if (campanha.template_b_id) {
      const { data: resultado, error: erroRpc } = await clienteUsuario.rpc("email_campanha_resultados_ab", { p_usuario_esperado: usuarioId, p_campanha: campanhaId });
      if (erroRpc || !objeto(resultado) || resultado.campanha_id !== campanhaId || !Array.isArray(resultado.variantes) || resultado.vencedor !== null) throw indisponivel();
      status = resultado.status; iniciada = resultado.iniciada_em; concluida = resultado.concluida_em; atualizado = resultado.atualizado_em;
      variantes = resultado.variantes.map(v => {
        if (!objeto(v) || !["A", "B"].includes(String(v.variante))) throw indisponivel();
        const variante = v.variante as "A" | "B";
        const conteudo = conteudoVariante(campanha, variante);
        if (v.template_id !== conteudo.template_id) throw indisponivel();
        return { variante, ...conteudo, ...Object.fromEntries(CAMPOS_CONTAGEM_DESEMPENHO_EMAIL_IA.map(c => [c, v[c]])) } as VarianteDesempenhoEmailIA;
      });
    } else {
      const contagens = await contarCampanhaUnica(clienteUsuario, campanhaId);
      atualizado = agora().toISOString();
      variantes = [{ variante: "unica", ...conteudoVariante(campanha, "unica"), ...contagens } as VarianteDesempenhoEmailIA];
    }
    return validarResumoDesempenhoEmailIA({ versao: 1, campanha_id: campanhaId, nome: limpar(campanha.nome, 240), tipo: campanha.template_b_id ? "ab" : "unica",
      status, iniciada_em: iniciada, concluida_em: concluida, atualizado_em: atualizado, coleta: campanha.template_b_id ? "rpc_ab" : "contagens", variantes });
  } catch (e) {
    if (e instanceof ErroDesempenhoEmailIA) throw e;
    // Exceções de rede/contrato não expõem o SQL nem resposta arbitrária do banco.
    throw indisponivel();
  }
}

export async function tratarAcaoDesempenhoEmailIA(corpo: Objeto, deps: { clienteUsuario: SupabaseClient; usuarioId: string }): Promise<{ resultados: ResumoDesempenhoEmailIA } | null> {
  if (corpo.acao !== "consultar_resultados") return null;
  if (Object.keys(corpo).some(c => !["acao", "usuario_esperado", "contexto"].includes(c)) || !objeto(corpo.contexto)
    || Object.keys(corpo.contexto).some(c => c !== "campanha_id") || typeof corpo.contexto.campanha_id !== "string") throw invalido();
  return { resultados: await resolverDesempenhoEmailIA(deps.clienteUsuario, corpo.contexto.campanha_id, deps.usuarioId) };
}
