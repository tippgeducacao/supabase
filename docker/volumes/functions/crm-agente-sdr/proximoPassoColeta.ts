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

export function proximoPassoDaColeta(input: Record<string, unknown> | null | undefined, agora: Date = new Date()): string {
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
