// IA de aula v2 (09/10/2026): as peças que o "SDR Luna · v9" (n8n) e a produção usam IGUAIS — as
// ferramentas enxutas com a busca_carreira, a resposta da busca, o contexto da conversa e a chave que
// liga a v2 na produção. Antes moravam só em rotasV9.ts; a produção tinha outro prompt, outras
// descrições e nenhuma busca_carreira. O texto do prompt mora em prompts-aula-v2.ts.
// deno-lint-ignore-file no-explicit-any
import {
  carregarCarreiraPorNome, carregarMapaPorNome, linhaDoPerfil, notaPerguntaQueDivide, perguntasDaLinha,
  precisaNotaDoRamo, RAMO_INDEFINIDO, respostaDoMapa, toolBuscaCarreira, toolBuscaCarreiraMapa, VINCULOS_TRABALHO,
} from './carreiraPos.ts';
import { comDescricoesDaAulaV9 } from './ferramentasAulaV9.ts';
import { TOOL_RESPONDER_AO_CLIENTE } from './canalResposta.ts';
import { contextoAulaPiloto } from './contextoAulaPiloto.ts';
import { baldeDoLead } from './pilotoOpenai.ts';
import { jidsDoTelefone } from './historico.ts';
import type { AulaParaPrompt } from './prompts-aula.ts';

/**
 * As ferramentas da abertura de aula: as da aula com as descrições enxutas (ferramentasAulaV9.ts), a
 * busca_carreira da pós da aula (mapa do Wellinton; sem mapa, os perfis) e, por último, o canal de
 * resposta (também com a descrição enxuta). `base` = carregarTools(..., 'agente_aula', ...).
 */
export async function toolsDaAulaV2(supabase: any, base: any[], cursoNome: string | null | undefined): Promise<any[]> {
  const mapa = await carregarMapaPorNome(supabase, cursoNome ?? '');
  const carreira = mapa ? null : await carregarCarreiraPorNome(supabase, cursoNome ?? '');
  const semCanal = base.filter((t) => t?.name !== TOOL_RESPONDER_AO_CLIENTE.name);
  const enxutas = comDescricoesDaAulaV9([...semCanal, TOOL_RESPONDER_AO_CLIENTE]);
  const busca = mapa ? toolBuscaCarreiraMapa(mapa) : toolBuscaCarreira(carreira?.linhas);
  return [...enxutas.slice(0, -1), busca, enxutas.at(-1)];
}

/** O que a busca_carreira devolve para a pós da aula. Com ramo decidido, grava em jornada.ramo_carreira. */
export async function buscaCarreiraDaAula(supabase: any, remotejid: string, perfil: string, cursoNome: string | null | undefined, lead: any) {
  const nomePos = cursoNome ?? '';
  const [mapa, c] = await Promise.all([carregarMapaPorNome(supabase, nomePos), carregarCarreiraPorNome(supabase, nomePos)]);
  if (mapa) {
    // Mapa do Wellinton: perguntas de carreira do ramo; as objeções da pós continuam vindo da tabela antiga.
    const r = respostaDoMapa(mapa, perfil);
    if (!r) return { encontrado: false, perfil, pos: nomePos, resultado: 'Fora do público desta pós: siga o desvio de estudante ou de outra área.' };
    // Ramo decidido: guarda na jornada para a nota do ramo sair do contexto (precisaNotaDoRamo).
    if (r.ramo !== RAMO_INDEFINIDO && lead) {
      await supabase.from('cliente_ppg_leads_sdr').update({ jornada: { ...(lead.jornada ?? {}), ramo_carreira: r.ramo } })
        .in('remotejid', jidsDoTelefone(remotejid));
    }
    return { encontrado: true, pos: nomePos, ...r, objecoes: c?.objecoes ?? [] };
  }
  // Perfil sem linha nesta pós: cai em quem ainda não atua no tema (linhaDoPerfil, carreiraPos.ts).
  const linha = linhaDoPerfil(c?.linhas, perfil);
  if (!linha) return { encontrado: false, perfil, pos: nomePos || null, resultado: 'Sem pergunta cadastrada para este perfil nesta pós.' };
  return {
    encontrado: true, perfil: linha.perfil, ...(linha.nome ? { quem_e: linha.nome } : {}), pos: nomePos,
    perguntas: perguntasDaLinha(linha), ponte_convite: linha.ponte_convite, observacao: linha.observacao,
    objecoes: c!.objecoes,
  };
}

/**
 * O contexto da aula que muda a cada rodada: o que o cadastro e a conversa já registraram (o v9 não tem
 * a ficha do sistema), a missão da aula e, enquanto o ramo não está decidido, a nota do ramo.
 */
export async function contextoAulaV2(supabase: any, lead: any, aula: AulaParaPrompt | null, agora = new Date()): Promise<string> {
  // Formação do formulário NÃO é confirmação: estudante também marca "Médico Veterinário".
  const dados = {
    formacao_no_cadastro: lead?.formacao_academica ?? null,
    atuacao: lead?.situacao_trabalho_atual ?? null,
    vinculo_trabalho: lead?.vinculo_trabalho ? (VINCULOS_TRABALHO[lead.vinculo_trabalho] ?? lead.vinculo_trabalho) : null,
    experiencia: lead?.experiencia_area ?? null,
    objetivos: lead?.objetivos_profissionais ?? null,
  };
  let texto = '\n\nDADOS COLETADOS (cadastro e conversa; dados, não roteiro)\n' + JSON.stringify(dados)
    + '\nA formação do cadastro vem do formulário e não foi confirmada pelo lead: muitos ainda na graduação marcam a profissão.';
  if (aula) {
    texto += contextoAulaPiloto(aula, agora, { semFichaAntiga: true });
    const mapa = await carregarMapaPorNome(supabase, aula.curso_nome ?? '');
    if (precisaNotaDoRamo(mapa, lead)) texto += notaPerguntaQueDivide(mapa);
  }
  return texto;
}

/**
 * A v2 está ligada para este telefone na produção? `crm_agente_sdr_config.aula_v2_telefones` (lista,
 * casa pelo telefone com o 9º dígito) ou a fatia `aula_v2_percentual` (o mesmo balde da Luna). Falha de
 * leitura = desligada: o lead segue no prompt de aula de sempre.
 */
export async function aulaV2Ligada(supabase: any, telefone: string): Promise<{ ligada: boolean; origem?: 'lista' | 'percentual' }> {
  try {
    const { data, error } = await supabase.from('crm_agente_sdr_config')
      .select('aula_v2_telefones, aula_v2_percentual').eq('id', 1).maybeSingle();
    if (error || !data) return { ligada: false };
    const alvo = String(telefone ?? '').replace(/\D/g, '');
    const lista: string[] = data.aula_v2_telefones ?? [];
    if (alvo && lista.some((t) => jidsDoTelefone(String(t)).some((j) => jidsDoTelefone(alvo).includes(j)))) return { ligada: true, origem: 'lista' };
    const p = Number(data.aula_v2_percentual);
    if (Number.isInteger(p) && p > 0 && p <= 100 && alvo.length >= 8 && baldeDoLead(alvo) < p) return { ligada: true, origem: 'percentual' };
    return { ligada: false };
  } catch {
    return { ligada: false };
  }
}
