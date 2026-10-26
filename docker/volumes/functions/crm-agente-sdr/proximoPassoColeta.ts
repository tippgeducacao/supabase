// Próximo passo EXATO no retorno de `atualizar_dados_lead` — só no canário (ficha ligada).
//
// Duelo cego Luna × Sonnet 5 (25/09/2026, 40 momentos reais): a Luna registrava a graduação e a
// conclusão com atualizar_dados_lead e seguia a conversa SEM rodar verificar_compatibilidade_curso
// — "2031 em janeiro" virou "qual área de pós vc tem interesse?", "2029" virou "em qual mês de
// 2029?". O retorno dizia "rode verificar_compatibilidade_curso" como lembrete genérico, e a Luna
// só obedece frase exata no ponto de uso. Aqui o código já lê a conclusão com a mesma régua da
// checagem (`avaliarConclusao`) e diz qual chamada fazer, com quais valores, antes de escrever.
// A decisão continua sendo da checagem (tools.ts): isto só a antecipa.

import { avaliarConclusao, limiteFormaturaFormatado } from './elegibilidadeFormatura.ts';

const texto = (v: unknown) => String(v ?? '').trim();

function mesAno(d: Date): string {
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

/**
 * `antesDoConvite` (26/10/2026, caso Vinicius): antes do convite, "pergunte quando ele conclui" atropelava o fluxo
 * (a formação vem depois do aceite) e a Luna obedecia: 83 de 171 rodadas pediram a formação antes do convite. Ali
 * essas duas ordens viram o fato; a data já lida (fora do prazo ou dentro dele) segue com o passo exato.
 */
export function proximoPassoDaColeta(input: Record<string, unknown> | null | undefined, agora: Date = new Date(), antesDoConvite = false): string {
  const formacao = texto(input?.formacao);
  const tempo = texto(input?.tempo_formacao);
  const concluida = texto(input?.graduacao_concluida).toLowerCase();
  if (concluida === 'nao' || (!formacao && !tempo && !concluida)) return '';

  const leitura = tempo ? avaliarConclusao(tempo, null, agora) : null;
  const dataLida = leitura?.leitura.tipo === 'data' ? leitura.leitura.data : null;
  // "formada em 2019", "recém formada" (sem data) e graduacao_concluida="sim" = já concluiu.
  const estudante = concluida === 'cursando' || (concluida !== 'sim' && (
    (dataLida !== null && dataLida > agora) || leitura?.leitura.tipo === 'posicao_no_curso' || /\bcursando\b/i.test(tempo)));

  if (estudante) {
    const bruta = tempo ? ` e conclusao_graduacao_bruta com a frase dele` : '';
    if (leitura?.veredito === 'fora_do_prazo' && dataLida) {
      // Sem pós escolhida a checagem nem roda (curso_interesse é obrigatório e a avaliação exige um
      // curso válido): o caminho é o retorno direto, como o Sonnet fez no caso "2031 em janeiro".
      const meses = Math.max(1, (dataLida.getUTCFullYear() - agora.getUTCFullYear()) * 12
        + dataLida.getUTCMonth() - agora.getUTCMonth());
      return `PRÓXIMO PASSO: a conclusão informada cai em ${mesAno(dataLida)}, DEPOIS da data-limite de elegibilidade `
        + `(${limiteFormaturaFormatado(agora)}): ele ainda não pode se matricular. Nesta mesma resposta, antes de escrever ao lead: `
        + `(a) se ele já tem uma pós de interesse, chame (se ainda não chamou) verificar_compatibilidade_curso com `
        + `contexto_qualificacao="estudante_fora_do_prazo", conclusao_graduacao="${mesAno(dataLida)}"${bruta}, e siga a instrução `
        + `que ela devolver; (b) se ainda não escolheu nenhuma pós, não pergunte a área: chame agendar_retorno com `
        + `tipo="formatura" e meses=${meses}, e despeça-se dizendo que a pós é lato sensu e exige a graduação concluída e `
        + 'que vc o procura quando ele estiver terminando o curso. Não pergunte o mês nem mais nada sobre a data.';
    }
    if (leitura?.veredito === 'apto' && dataLida) {
      return `PRÓXIMO PASSO: a conclusão informada cai em ${mesAno(dataLida)}, dentro do prazo. Nesta mesma resposta, `
        + 'antes de convidar para a reunião ou oferecer horário, chame (se ainda não chamou) verificar_compatibilidade_curso com '
        + `contexto_qualificacao="estudante_apto", conclusao_graduacao="${mesAno(dataLida)}"${bruta}.`;
    }
    if (antesDoConvite) {
      return `${fatoDaColeta(input, agora)} A data de conclusão se pergunta quando ele aceitar a conversa com o monitor `
        + 'ou pedir horário, cronograma ou preço.';
    }
    if (leitura?.leitura.tipo === 'posicao_no_curso') {
      return `PRÓXIMO PASSO: "${tempo}" é a posição no curso, não a data de conclusão. Pergunte só em que mês e ano `
        + 'ele conclui (uma vez) e não ofereça horário antes da resposta.';
    }
    return 'PRÓXIMO PASSO: falta saber quando ele conclui. Se ele já disse o mês e o ano nesta conversa, chame '
      + 'verificar_compatibilidade_curso com contexto_qualificacao="estudante_apto" e a frase dele; se não disse, '
      + 'pergunte só isso (uma vez).';
  }

  return 'PRÓXIMO PASSO: nesta mesma resposta, antes de convidar para a reunião, oferecer horário ou enviar material, '
    + `chame (se ainda não chamou) verificar_compatibilidade_curso${formacao ? ` com formacao_academica="${formacao}"` : ' com a graduação que ele informou'} `
    + 'e o curso de interesse, e siga o resultado.';
}

/**
 * IA de aula v2 (01/10/2026, pedido do Gustavo: tirar as ordens escondidas das ferramentas). O mesmo
 * retrato da formação e do prazo que `proximoPassoDaColeta` lê, mas SEM dizer o que fazer: a sequência
 * da conversa é do fluxo da persona (docs/Agente SDR — Conversa de Aula). Só com `ctx.soInformar`.
 */
export function fatoDaColeta(input: Record<string, unknown> | null | undefined, agora: Date = new Date()): string {
  const formacao = texto(input?.formacao);
  const tempo = texto(input?.tempo_formacao);
  const concluida = texto(input?.graduacao_concluida).toLowerCase();
  if (concluida === 'nao' || (!formacao && !tempo && !concluida)) return '';
  const leitura = tempo ? avaliarConclusao(tempo, null, agora) : null;
  const dataLida = leitura?.leitura.tipo === 'data' ? leitura.leitura.data : null;
  const estudante = concluida === 'cursando' || (concluida !== 'sim' && (
    (dataLida !== null && dataLida > agora) || leitura?.leitura.tipo === 'posicao_no_curso' || /\bcursando\b/i.test(tempo)));
  const grad = formacao ? `graduação: ${formacao}` : 'graduação não informada';
  if (!estudante) return `SITUAÇÃO: formado (${grad}). Compatibilidade com a pós ainda não verificada.`;
  if (leitura?.veredito === 'fora_do_prazo' && dataLida) {
    return `SITUAÇÃO: estudante (${grad}); conclui em ${mesAno(dataLida)}, depois da data-limite de elegibilidade `
      + `desta turma (${limiteFormaturaFormatado(agora)}).`;
  }
  if (leitura?.veredito === 'apto' && dataLida) {
    return `SITUAÇÃO: estudante (${grad}); conclui em ${mesAno(dataLida)}, dentro da data-limite de elegibilidade. `
      + 'Compatibilidade com a pós ainda não verificada.';
  }
  if (leitura?.leitura.tipo === 'posicao_no_curso') {
    return `SITUAÇÃO: estudante (${grad}); "${tempo}" é a posição no curso, não a data de conclusão. Mês e ano de conclusão ainda não informados.`;
  }
  return `SITUAÇÃO: estudante (${grad}); mês e ano de conclusão ainda não informados.`;
}


/** O fato no lugar da ordem antes do convite vale para este telefone? (coleta_fato_antes_convite / _telefones). Falha = desligada. */
export async function coletaFatoAntesDoConviteLigada(supabase: { from: (tabela: string) => any }, telefone: string | null | undefined): Promise<boolean> {
  try {
    const { data, error } = await supabase.from('crm_agente_sdr_config')
      .select('coleta_fato_antes_convite, coleta_fato_antes_convite_telefones').eq('id', 1).maybeSingle();
    if (error || !data) return false;
    if (data.coleta_fato_antes_convite === true) return true;
    const fim = String(telefone ?? '').replace(/\D/g, '').slice(-8);
    const lista: unknown[] = Array.isArray(data.coleta_fato_antes_convite_telefones) ? data.coleta_fato_antes_convite_telefones : [];
    return fim.length === 8 && lista.some((t) => String(t).replace(/\D/g, '').slice(-8) === fim);
  } catch { return false; }
}
