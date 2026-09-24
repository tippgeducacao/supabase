import { perfilCarreira } from './perguntasCarreira.ts';

// Conferido nas publicações primárias em 24/09/2026. Não guardar "inscrições abertas"
// como fato permanente: prazos, requisitos e aprovação dependem do edital vigente.
export const ESPECIALIDADE_CANNABIS = {
  conferido_em: '2026-09-24',
  especialidade: 'Endocanabinologia Veterinária',
  entidade_habilitada: 'AMEC-VET',
  ato: 'Resolução CFMV nº 1.705/2026',
  fato: 'O CFMV habilitou a AMEC-VET para conceder o título de especialista em Endocanabinologia Veterinária.',
  certificacao: 'A obtenção do título depende do processo da AMEC-VET e dos requisitos e avaliações previstos no edital.',
  limite: 'Concluir a pós da PPG não concede automaticamente esse título profissional. Não foi verificado que a pós atende aos requisitos do edital, dispensa avaliação ou é habilitada pelo CFMV a conceder esse título.',
  fontes: [
    'https://www.cfmv.gov.br/cfmv-habilita-amec-vet-para-conceder-titulo-de-especialista-em-endocanabinologia-veterinaria/comunicacao/noticias/2026/07/07/',
    'https://amec.org.br/especialidade-edital/',
  ],
};

export function contextoEspecialidadeCannabis(curso: string): string {
  if (perfilCarreira(curso)?.id !== 'cannabis') return '';
  return '\n\nESPECIALIDADE PROFISSIONAL — FONTE CONFERIDA:\n' + JSON.stringify(ESPECIALIDADE_CANNABIS)
    + '\nUse esse reconhecimento como contexto de carreira quando fizer sentido. Distinga sempre a pós do título profissional concedido pela entidade habilitada. Se perguntarem se a pós já dá o título do CFMV, responda diretamente que não é automático e que existe o processo da AMEC-VET. Não prometa elegibilidade, aprovação, renda, benefício clínico ou dispensa de prova. Não invente vínculo, credenciamento ou aprovação da PPG pelo CFMV. Para requisitos, datas e inscrições, encaminhe à fonte do edital, sem reproduzir prazos como se estivessem sempre vigentes. Não anuncie "acabou de ser reconhecida" ou urgência. Só envie link se necessário para a dúvida; o gancho de carreira pode ser curto e falado.';
}
