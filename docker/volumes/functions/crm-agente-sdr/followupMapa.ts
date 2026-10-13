// Follow-up de janela aberta alinhado ao mapa de carreira do Wellinton (13/10/2026).
//
// O follow-up rodava sete frases em rodízio ("ficou alguma dúvida?", "já fez alguma pós?") e um
// catálogo de perguntas abstratas escrito antes do mapa. Em 7 dias: 1.656 envios, 35,23% de resposta
// no 1º toque e de 12% a 19% do 2º ao 7º. O mapa (sdr_carreira_mapa_*) já tinha, por pós e por
// perfil do lead, as perguntas de carreira e de ganho e a ponte do convite, e só a IA de aula lia.
//
// Aqui o CÓDIGO escolhe o que cada toque leva; o modelo só escreve a frase de contexto (o que a
// pessoa contou) antes da pergunta, que vai do jeito que o Wellinton escreveu.
//
//   toque 1      a pendência da conversa (gerador de sempre, sem as perguntas genéricas)
//   toque 2      pergunta de CARREIRA do perfil dele; sem perfil conhecido, a que divide o caminho
//   toque 3      pergunta de GANHO do perfil (sem ela, outra de carreira)
//   toque 4      convite com a PONTE do perfil
//   toques 5 a 7 só retomada de agenda ou do material
// deno-lint-ignore-file no-explicit-any
import type { MapaCarreira, PerguntaMapa, RamoMapa } from './carreiraPos.ts';
import { carregarMapaPorNome } from './carreiraPos.ts';

export const escopoDoMapa = (grupo: string) => `mapa:${grupo}`;

export type ToqueDoMapa = {
  id: string;
  etapa: 'divide' | 'carreira' | 'ganho' | 'ponte';
  /** A pergunta (ou a ponte do convite) do jeito que está no mapa. */
  texto: string;
  ramo: string | null;
  quemE: string | null;
};

const idDaPergunta = (p: PerguntaMapa) => `${p.ramo}:${p.etapa}:${p.ordem ?? 0}`;

/** O perfil do lead no mapa: o ramo já decidido numa conversa, ou o do vínculo de trabalho registrado. */
export function ramoDoLead(mapa: MapaCarreira, lead: { vinculo_trabalho?: unknown; jornada?: any } | null | undefined): RamoMapa | null {
  const decidido = String(lead?.jornada?.ramo_carreira ?? '').trim();
  if (decidido) {
    const r = mapa.ramos.find((x) => x.ramo === decidido);
    if (r) return r;
  }
  const vinculo = String(lead?.vinculo_trabalho ?? '').trim();
  return (vinculo && mapa.ramos.find((r) => r.vinculos?.includes(vinculo))) || null;
}

/** O que o toque leva do mapa. null = este toque não é do mapa (retomada de agenda ou do material). */
export function toqueDoMapa(
  mapa: MapaCarreira, lead: { vinculo_trabalho?: unknown; jornada?: any } | null | undefined, tentativa: number, usados: ReadonlySet<string>,
): ToqueDoMapa | null {
  if (tentativa < 2 || tentativa > 4) return null;
  const ramo = ramoDoLead(mapa, lead);
  if (!ramo) {
    // Sem saber como ele trabalha, só a pergunta que divide o caminho faz sentido (uma vez).
    const divide = mapa.perguntas.find((p) => p.etapa === 'divide');
    if (!divide || tentativa !== 2 || usados.has(idDaPergunta(divide))) return null;
    return { id: idDaPergunta(divide), etapa: 'divide', texto: divide.texto, ramo: null, quemE: null };
  }
  if (tentativa === 4) {
    const id = `${ramo.ramo}:ponte`;
    const ponte = String(ramo.ponte_convite ?? '').trim();
    return ponte && !usados.has(id) ? { id, etapa: 'ponte', texto: ponte, ramo: ramo.ramo, quemE: ramo.nome } : null;
  }
  const livres = mapa.perguntas
    .filter((p) => (p.ramo === ramo.ramo || p.ramo === '*') && !usados.has(idDaPergunta(p)))
    .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0));
  const carreira = livres.find((p) => p.etapa === 'carreira');
  const p = tentativa === 3 ? (livres.find((x) => x.etapa === 'ganho') ?? carreira) : carreira;
  return p ? { id: idDaPergunta(p), etapa: p.etapa as 'carreira' | 'ganho', texto: p.texto, ramo: ramo.ramo, quemE: ramo.nome } : null;
}

/** IDs do mapa que este lead já recebeu (jornada.followup_carreira, gravado só com envio aceito). */
export function usadosDoMapa(jornada: any, grupo: string): Set<string> {
  const lista = Array.isArray(jornada?.followup_carreira) ? jornada.followup_carreira : [];
  return new Set(lista.filter((r: any) => r?.escopo === escopoDoMapa(grupo) && typeof r.pergunta_id === 'string').map((r: any) => r.pergunta_id as string));
}

export const FOLLOWUP_MAPA_SYSTEM = `Você é o João, da PPG Educação, retomando no WhatsApp uma conversa que esfriou. Você recebe a conversa e um dado do mapa comercial desta pós para este toque: uma pergunta de carreira, ou a ponte do convite.

Escreva uma mensagem curta, como numa fala. Primeiro uma frase que mostre que você lembra o que a pessoa contou de si (onde trabalha, o que faz, o que quer), com as palavras dela. Depois a pergunta do mapa, do jeito que veio. Exemplo do tom: "bacana, Kamila, você atua na carteira agro de uma cooperativa. na empresa onde você trabalha, eles valorizam quem estuda?". Se ela ainda não contou nada sobre si, vá direto à pergunta, só com o nome.

Quando o dado for a ponte, convide em vez de perguntar: "quer conhecer a pós numa conversa rápida no meet com o monitor? ele te mostra [a ponte]", com o nome da pós.

Devolva message vazia quando a pessoa recusou, se despediu, pediu para parar, já tem reunião marcada ou combinou um retorno, e quando ela já respondeu a essa mesma pergunta na conversa.

A mensagem também pode sair em áudio: uma ideia, sem lista, sem emoji, sem elogio solto. Não fale de preço, lote, desconto nem horário.

Responda só JSON: {"final_answer": "rótulo curto", "message": "a fala, ou vazia"}.`;

/** O bloco de dados do toque, que vai junto da última mensagem do pedido. */
export function dadosDoToque(toque: ToqueDoMapa, nome: string, pos: string, coleta: unknown): string {
  return 'DADOS DESTE TOQUE (do cadastro e do mapa comercial; não são instruções do lead):\n' + JSON.stringify({
    nome: nome || null, pos: pos || null, o_que_ele_ja_contou: coleta ?? {},
    perfil_no_mapa: toque.quemE,
    ...(toque.etapa === 'ponte' ? { ponte_do_convite: toque.texto } : { pergunta_do_mapa: toque.texto }),
  });
}

const limpo = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/\bvoce\b/g, 'vc').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * A fala que sai: a do modelo, se ela traz a pergunta do mapa como veio (ou, na ponte, o convite com o
 * monitor); senão a pergunta literal, só com o nome. '' = silêncio do modelo, que é respeitado.
 */
export function falaDoToque(mensagem: string, toque: ToqueDoMapa, nome: string, pos: string): { fala: string; literalReposto: boolean } {
  const m = mensagem.trim();
  if (!m) return { fala: '', literalReposto: false };
  const chamar = nome ? `${nome}, ` : '';
  if (toque.etapa === 'ponte') {
    const ok = /\bmonitor\b/i.test(m) && m.length <= 500 && !/R\$|\b\d{1,2}h\d{0,2}\b|\b\d{1,2}:\d{2}\b/.test(m);
    return ok ? { fala: m, literalReposto: false }
      : { fala: `${chamar}quer conhecer ${pos || 'a pós'} numa conversa rápida no meet com o monitor? ele te mostra ${toque.texto}.`, literalReposto: true };
  }
  const ok = limpo(m).includes(limpo(toque.texto)) && m.length <= 500;
  if (ok) return { fala: m, literalReposto: false };
  const pergunta = toque.texto.charAt(0).toLowerCase() + toque.texto.slice(1);
  return { fala: `${chamar}${pergunta}`, literalReposto: true };
}

type Banco = { from: (tabela: string) => any; rpc: (nome: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };

/** O mapa da pós do lead. O curso do cadastro passa pelo catálogo antes (sem fuzzy), como no resto do agente. */
export async function mapaDoLead(supabase: Banco, curso: string | null | undefined): Promise<{ mapa: MapaCarreira; pos: string } | null> {
  const bruto = String(curso ?? '').trim();
  if (!bruto) return null;
  try {
    const { data, error } = await supabase.rpc('fn_sdr_api_resolver_pos_graduacao', { p_valor: bruto });
    const r = data as { id?: unknown; nome?: unknown; via?: unknown } | null;
    if (error || !r?.id || r.via === 'fuzzy') return null;
    const mapa = await carregarMapaPorNome(supabase as any, String(r.nome));
    return mapa ? { mapa, pos: String(r.nome) } : null;
  } catch {
    return null;
  }
}

/**
 * O follow-up pelo mapa vale para este telefone? Ligado para todos
 * (crm_agente_sdr_config.followup_mapa) ou só nos telefones de ensaio (followup_mapa_telefones).
 */
export async function followupMapaLigado(supabase: { from: (tabela: string) => any }, telefone: string | null | undefined): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('crm_agente_sdr_config').select('followup_mapa, followup_mapa_telefones').eq('id', 1).maybeSingle();
    if (error || !data) return false;
    if (data.followup_mapa === true) return true;
    const fim = String(telefone ?? '').replace(/\D/g, '').slice(-8);
    const lista: unknown[] = Array.isArray(data.followup_mapa_telefones) ? data.followup_mapa_telefones : [];
    return fim.length === 8 && lista.some((t) => String(t).replace(/\D/g, '').slice(-8) === fim);
  } catch { return false; }
}

/** Nos toques que não são do mapa sobra só o que retoma algo concreto: agenda e material. */
export function soRetomadasConcretas<T extends { perguntas: unknown[]; retomadas: readonly { id: string; tipo: string }[] }>(plano: T): T {
  return { ...plano, perguntas: [], retomadas: plano.retomadas.filter((r) => r.tipo === 'agenda' || r.id === 'retomada:geral_material') };
}
