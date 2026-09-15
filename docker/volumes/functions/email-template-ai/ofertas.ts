import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";
import { CAMPOS_DADOS_OFERTA, camposFonteOfertaEmailIA, ErroOfertaEmailIA, exigirOfertaVigenteEmailIA, situacaoOfertaEmailIA, validarDadosOfertaEmailIA, validarIdOfertaEmailIA, validarOfertaEmailIA, type OfertaEmailIA } from "../_shared/emailBuilder/aiOferta.ts";
import { NAO_VERIFICAVEIS_FONTES_EMAIL_IA, type ItemNaoVerificavelEmailIA } from "../_shared/emailBuilder/aiFontes.ts";

const CAMPOS = [...CAMPOS_DADOS_OFERTA, "revisao", "aprovada_por", "aprovada_em", "revogada_em"].join(",");
const indisponivel = () => new ErroOfertaEmailIA(503, "OFFERS_UNAVAILABLE", "Não foi possível consultar as ofertas aprovadas. Tente novamente.");
export interface FonteOfertaEmailIA { tipo: "oferta"; id: string; rotulo: string; estado: "disponivel" | "indisponivel"; campos: Record<string, string> }
export interface ContextoOfertaEmailIA { oferta: OfertaEmailIA | null; texto: string; fonte: FonteOfertaEmailIA; naoVerificaveis: ItemNaoVerificavelEmailIA[] }

async function lerOferta(cliente: SupabaseClient, id: string): Promise<OfertaEmailIA | null> {
  const { data, error } = await cliente.from("email_ia_ofertas").select(CAMPOS).eq("id", id).maybeSingle();
  if (error) throw indisponivel();
  if (!data) return null;
  try { return validarOfertaEmailIA(data); } catch { throw indisponivel(); }
}

/** Executar depois do gate admin/diretor e antes de consumir cota. O relógio
 * usado é do servidor. A conferência preserva a identidade de fontes removidas. */
export async function resolverOfertaEmailIA(cliente: SupabaseClient, selecao: { oferta_id?: string; curso_id?: string }, opcoes: { conferencia?: boolean; agora?: Date } = {}): Promise<ContextoOfertaEmailIA | null> {
  if (!selecao.oferta_id) return null;
  const id = validarIdOfertaEmailIA(selecao.oferta_id), cursoId = validarIdOfertaEmailIA(selecao.curso_id);
  const oferta = await lerOferta(cliente, id);
  const { data: curso, error } = await cliente.from("comercial_cursos").select("id").eq("id", cursoId).eq("ativo", true).maybeSingle();
  if (error) throw indisponivel();
  const agora = opcoes.agora ?? new Date();
  const disponivel = !!oferta && !!curso && oferta.curso_id === cursoId && situacaoOfertaEmailIA(oferta, agora) === "vigente";
  if (!disponivel) {
    if (opcoes.conferencia) return { oferta: null, texto: "", fonte: { tipo: "oferta", id, rotulo: oferta?.nome ?? "Oferta selecionada", estado: "indisponivel", campos: {} }, naoVerificaveis: [...NAO_VERIFICAVEIS_FONTES_EMAIL_IA] };
    if (!oferta || !curso) throw new ErroOfertaEmailIA(409, "OFFER_UNAVAILABLE", "A oferta ou o curso não estão mais disponíveis. Atualize a seleção antes de gerar.");
    exigirOfertaVigenteEmailIA(oferta, cursoId, agora);
  }
  const campos = camposFonteOfertaEmailIA(oferta!);
  const naoVerificaveis = NAO_VERIFICAVEIS_FONTES_EMAIL_IA.filter(aviso => aviso.tipo === "vagas" || aviso.tipo === "prazo" || aviso.tipo === "preco" && oferta!.preco_centavos == null || aviso.tipo === "desconto" && oferta!.desconto_pontos_base == null).map(aviso => ({ ...aviso, ...(aviso.tipo === "prazo" ? { motivo: "O período aprovado confirma somente a vigência destas condições comerciais. Ele não confirma o encerramento geral das matrículas." } : {}) }));
  return { oferta, texto: Object.entries(campos).map(([campo, valor]) => `${campo}: ${valor}`).join("\n"), fonte: { tipo: "oferta", id, rotulo: `Oferta aprovada: ${oferta!.nome}`.slice(0, 240), estado: "disponivel", campos }, naoVerificaveis };
}

function erroGravacao(error: { code?: string } | null): void {
  if (!error) return;
  if (error.code === "40001" || error.code === "23505") throw new ErroOfertaEmailIA(409, "OFFER_CONFLICT", "A oferta mudou em outra edição. Atualize a lista e confira a versão atual antes de salvar novamente.");
  if (error.code === "42501") throw new ErroOfertaEmailIA(403, "OFFER_FORBIDDEN", "Sua conta mudou ou não tem permissão para aprovar ofertas.");
  if (error.code?.startsWith("22") || error.code?.startsWith("23")) throw new ErroOfertaEmailIA(400, "INVALID_OFFER", "Confira curso ativo, condições e validade futura da oferta.");
  throw new ErroOfertaEmailIA(503, "OFFERS_UNAVAILABLE", "Não foi possível gravar a oferta. Seus dados foram preservados; atualize a lista antes de tentar novamente.");
}

/** Mutações usam o JWT autenticado: a RPC deriva o responsável de auth.uid(),
 * repete permissões e compara a revisão sob bloqueio de linha. */
export async function tratarAcaoOfertasEmailIA(corpo: Record<string, unknown>, deps: { cliente: SupabaseClient; clienteUsuario?: SupabaseClient; usuarioId: string }): Promise<Record<string, unknown> | null> {
  if (!["listar_ofertas", "carregar_oferta", "salvar_oferta", "desativar_oferta"].includes(String(corpo.acao))) return null;
  if (corpo.usuario_esperado !== deps.usuarioId) throw new ErroOfertaEmailIA(409, "ACCOUNT_CHANGED", "A conta mudou. Reabra as ofertas para continuar.");
  if (corpo.acao === "listar_ofertas") {
    const cursoId = validarIdOfertaEmailIA(corpo.curso_id), ofertas: OfertaEmailIA[] = [];
    for (let inicio = 0; ; inicio += 500) {
      const { data, error } = await deps.cliente.from("email_ia_ofertas").select(CAMPOS).eq("curso_id", cursoId).order("aprovada_em", { ascending: false }).order("id").range(inicio, inicio + 499);
      if (error || !Array.isArray(data)) throw indisponivel();
      try { ofertas.push(...data.map(validarOfertaEmailIA)); } catch { throw indisponivel(); }
      if (data.length < 500) break;
      if (ofertas.length >= 10000) throw new ErroOfertaEmailIA(413, "OFFERS_TOO_LARGE", "Há ofertas demais para este curso. Consulte a equipe responsável pelo cadastro.");
    }
    const agora = new Date();
    return { ofertas: ofertas.map(oferta => ({ ...oferta, situacao: situacaoOfertaEmailIA(oferta, agora) })), conferido_em: agora.toISOString() };
  }
  if (corpo.acao === "carregar_oferta") {
    const oferta = await lerOferta(deps.cliente, validarIdOfertaEmailIA(corpo.oferta_id));
    if (!oferta) throw new ErroOfertaEmailIA(404, "OFFER_NOT_FOUND", "Esta oferta não está mais disponível.");
    if (corpo.curso_id !== oferta.curso_id) throw new ErroOfertaEmailIA(400, "INVALID_OFFER", "Esta oferta pertence a outro curso.");
    return { oferta: { ...oferta, situacao: situacaoOfertaEmailIA(oferta) } };
  }
  if (!deps.clienteUsuario) throw new ErroOfertaEmailIA(503, "OFFERS_UNAVAILABLE", "O serviço de aprovação de ofertas ainda não está disponível.");
  if (!Number.isSafeInteger(corpo.revisao_esperada) || (corpo.revisao_esperada as number) < (corpo.acao === "salvar_oferta" ? 0 : 1)) throw new ErroOfertaEmailIA(400, "INVALID_OFFER", "Atualize a oferta para conferir sua revisão.");
  if (corpo.acao === "salvar_oferta") {
    if (corpo.confirmar_aprovacao !== true) throw new ErroOfertaEmailIA(400, "OFFER_APPROVAL_REQUIRED", "Confirme sua aprovação das condições antes de salvar.");
    const oferta = validarDadosOfertaEmailIA(corpo.oferta);
    const { data, error } = await deps.clienteUsuario.rpc("email_ia_salvar_oferta", { p_usuario_esperado: deps.usuarioId, p_oferta: oferta, p_revisao_esperada: corpo.revisao_esperada, p_confirmar_aprovacao: true });
    erroGravacao(error);
    const salva = validarOfertaEmailIA(data);
    return { oferta: { ...salva, situacao: situacaoOfertaEmailIA(salva) } };
  }
  const { data, error } = await deps.clienteUsuario.rpc("email_ia_revogar_oferta", { p_usuario_esperado: deps.usuarioId, p_oferta_id: validarIdOfertaEmailIA(corpo.oferta_id), p_revisao_esperada: corpo.revisao_esperada });
  erroGravacao(error);
  const revogada = validarOfertaEmailIA(data);
  return { oferta: { ...revogada, situacao: situacaoOfertaEmailIA(revogada) } };
}
