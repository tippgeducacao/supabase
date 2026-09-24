import { describe, expect, it } from 'vitest';
import { contextoFollowupCarreira, corrigirPremissaDeCarreira, planejarFollowupCarreira, perguntaRepetida, validarFollowupCarreira } from './followupCarreira';
import { PERFIS_CARREIRA, perfilCarreira } from './perguntasCarreira';
import { avaliarPoliticaVoz } from './politicaVoz';
import { preferenciaFollowup } from './perguntasRetomada';

describe('follow-up sobre a pessoa na área escolhida', () => {
  it('separa pós parecidas, postura avícola e cursos curtos', () => {
    expect(perfilCarreira('PÓS | REPRODUÇÃO, NUTRIÇÃO E GESTÃO DE BOVINOS (3EM1)')?.id).toBe('bovinos_3em1');
    expect(perfilCarreira('NUTRIÇÃO E GESTÃO DE BOVINOS')?.id).toBe('bovinos_nutricao');
    expect(perfilCarreira('MBA | GESTÃO DA PECUÁRIA LEITERA')?.id).toBe('leite');
    expect(perfilCarreira('Postura Comercial')?.area).toBe('avicultura de postura');
    expect(perfilCarreira('CURSO | CANNABIS')).toBeNull();
    expect(perfilCarreira('Curso inventado de cirurgia de silvestres')).toBeNull();
  });
  it('exclui perguntas enviadas no curso sem consumir as de outra pós', () => {
    const enviados = [{ escopo: 'bovinos_3em1', pergunta_id: 'bovinos_3em1:futuro', enviado_em: '2026-09-23' }];
    const plano = planejarFollowupCarreira('Reprodução, Nutrição e Gestão de Bovinos (3em1)', enviados);
    expect(plano.perguntas.some(p => p.id === 'bovinos_3em1:futuro')).toBe(false);
    expect(validarFollowupCarreira('como imagina seu trabalho no campo?', 'bovinos_3em1:futuro', plano, [])).toBe('pergunta_indisponivel');
    expect(planejarFollowupCarreira('Cannabis Medicinal Veterinária', enviados).perguntas).toHaveLength(6);
  });
  it('esgotar carreira preserva retomadas úteis e silêncio, sem reiniciar temas usados', () => {
    const inicial = planejarFollowupCarreira('Sanidade Avícola', []);
    const fim = planejarFollowupCarreira('Sanidade Avícola', inicial.perguntas.map(p => ({ escopo: inicial.escopo, pergunta_id: p.id, enviado_em: '2026-09-23' })));
    expect(fim.perguntas).toEqual([]);
    expect(validarFollowupCarreira('', '', fim, [])).toBeNull();
    expect(validarFollowupCarreira('quer que eu confira aquele horário?', 'pendencia', fim, [])).toBeNull();
    expect(validarFollowupCarreira('ficou alguma dúvida sobre o que conversamos?', 'retomada:geral_duvida', fim, [])).toBeNull();
  });
  it('registra e exclui retomadas gerais/de agenda pelo mesmo escopo durável', () => {
    const registro = [{ escopo: 'cannabis', pergunta_id: 'retomada:agenda_periodo', enviado_em: '2026-09-23' }];
    const plano = planejarFollowupCarreira('Cannabis Medicinal Veterinária', registro);
    expect(plano.retomadas.some(p => p.id === registro[0].pergunta_id)).toBe(false);
    expect(validarFollowupCarreira('qual período fica melhor para a reunião?', registro[0].pergunta_id, plano, [])).toBe('pergunta_indisponivel');
    expect(planejarFollowupCarreira('Sanidade Avícola', registro).retomadas.some(p => p.id === registro[0].pergunta_id)).toBe(true);
    expect(validarFollowupCarreira('quer continuar?', 'retomada:inventada', plano, [])).toBe('pergunta_indisponivel');
  });
  it('a preferência varia por tentativa e não obriga reiniciar o banco depois da sétima', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(preferenciaFollowup)).toEqual(['retomada', 'carreira', 'geral', 'retomada', 'carreira', 'geral', 'agenda']);
    expect(preferenciaFollowup(20)).toBe('agenda');
    expect(contextoFollowupCarreira(planejarFollowupCarreira('Cannabis Medicinal Veterinária', []), 3)).toContain('"preferencia_da_tentativa":"geral"');
  });
  it('agenda reabre a escolha, mas não oferece disponibilidade antiga nem contorna repetição', () => {
    const plano = planejarFollowupCarreira('Cannabis Medicinal Veterinária', []);
    for (const horario of ['19h', '19h30', '19:30']) {
      expect(validarFollowupCarreira(`tenho ${horario}, pode ser?`, 'retomada:agenda_reconsultar', plano, [])).toBe('horario_sem_consulta');
    }
    expect(validarFollowupCarreira('qual período fica melhor para conversar com o monitor?', 'retomada:agenda_periodo', plano, [
      { role: 'assistant', content: 'qual período fica melhor para conversar com o monitor?' },
    ])).toBe('pergunta_repetida');
  });
  it('recusa repetição inclusive da conversa principal e de áudio transcrito', () => {
    expect(perguntaRepetida('como você imagina sua rotina profissional trabalhando com bovinos?', [{ role: 'assistant', content: [{ type: 'text', text: 'Como você imagina sua rotina profissional trabalhando com bovinos?' }] }])).toBe(true);
    expect(perguntaRepetida('qual próximo passo quer dar na carreira?', [{ role: 'assistant', content: 'qual a sua graduação?' }])).toBe(false);
  });
  it('recusa a mesma pergunta após introduções diferentes, sem confundir perguntas novas', () => {
    const history = [{ role: 'assistant' as const, content: 'como você está terminando a formação em outubro e quer entrar na área de bovinos, qual avanço gostaria de conquistar primeiro?' }];
    expect(perguntaRepetida('como você quer entrar na área de bovinos depois da formação, qual avanço gostaria de conquistar primeiro?', history)).toBe(true);
    expect(perguntaRepetida('qual avanço gostaria de conquistar primeiro?', history)).toBe(true);
    expect(perguntaRepetida('pensando na área de bovinos, qual critério pesa na escolha de uma formação?', history)).toBe(false);
    expect(validarFollowupCarreira('como você quer entrar na área de bovinos depois da formação, qual avanço gostaria de conquistar primeiro?', 'bovinos_3em1:mercado', planejarFollowupCarreira('Reprodução, Nutrição e Gestão de Bovinos (3em1)', []), history)).toBe('pergunta_repetida');
  });
  it('curso sem perfil não recebe promessa, dado salarial nem conteúdo de outra pós', () => {
    const contexto = contextoFollowupCarreira(planejarFollowupCarreira('Curso desconhecido', null));
    expect(contexto).toContain('"area":null');
    expect(contexto).toContain('"fonte_mercado":null');
    expect(contexto).not.toContain('bovinos');
    expect(contexto).toContain('"base_curricular":null');
  });
  it('leva somente a grade conferida da pós selecionada, sem misturar cursos ou inventar base ausente', () => {
    const cannabis = contextoFollowupCarreira(planejarFollowupCarreira('PÓS | CANNABIS MEDICINAL VETERINÁRIA', []));
    expect(cannabis).toContain('Prescrição Veterinária, Titulação e Acompanhamento Clínico');
    expect(cannabis).toContain('65a84565-5390-4f4a-a5ee-cf1e78dbdd03');
    expect(cannabis).not.toContain('POEDEIRAS');
    const postura = contextoFollowupCarreira(planejarFollowupCarreira('MBA | POSTURA COMERCIAL', []));
    expect(postura).toContain('NUTRIÇÃO DE POEDEIRAS');
    expect(postura).not.toContain('Prescrição Veterinária');
    expect(contextoFollowupCarreira(planejarFollowupCarreira('CURSO | CANNABIS', []))).toContain('"base_curricular":null');
    expect(contextoFollowupCarreira(planejarFollowupCarreira('MBA | LIDERANÇA E INTELIGÊNCIA ARTIFICIAL NO AGRONEGÓCIO', []))).toContain('"base_curricular":null');
  });
  it('inclui o gancho de especialidade só em Cannabis e o exclui depois de enviado', () => {
    const plano = planejarFollowupCarreira('Cannabis Medicinal Veterinária', []);
    const pergunta = plano.perguntas.find(p => p.id === 'cannabis:especialidade')!;
    expect(pergunta).toBeDefined();
    expect(validarFollowupCarreira(pergunta.exemplo, pergunta.id, plano, [])).toBeNull();
    expect(avaliarPoliticaVoz({ habilitada: true, origem: 'followup', texto: pergunta.exemplo, cadenciaAtingida: true }).permitido).toBe(true);
    const depois = planejarFollowupCarreira('Cannabis Medicinal Veterinária', [{ escopo: 'cannabis', pergunta_id: pergunta.id, enviado_em: '2026-09-24' }]);
    expect(validarFollowupCarreira(pergunta.exemplo, pergunta.id, depois, [])).toBe('pergunta_indisponivel');
    expect(contextoFollowupCarreira(plano)).toContain('Concluir a pós da PPG não concede automaticamente');
    expect(contextoFollowupCarreira(planejarFollowupCarreira('Sanidade Avícola', []))).not.toContain('AMEC-VET');
    expect(contextoFollowupCarreira(planejarFollowupCarreira('CURSO | CANNABIS', []))).not.toContain('AMEC-VET');
  });
  it.each([
    ['com a pós você vai ganhar o dobro. quer crescer?', 'promessa_de_renda'],
    ['quem tem pós ganha mais no brasil. quer melhorar seus ganhos?', 'pesquisa_sem_recorte'],
    ['a pesquisa diz que a renda sobe 53,7%. quer saber mais?', 'promessa_de_renda'],
    ['sua renda vai para R$ 11.539. quer entrar?', 'promessa_de_renda'],
    ['como você se vê no futuro? quanto quer ganhar?', 'formato'],
  ])('recusa conteúdo sem sustentação: %s', (texto, motivo) => {
    expect(validarFollowupCarreira(texto, 'cannabis:ganhos', planejarFollowupCarreira('Cannabis Medicinal Veterinária', []), [])).toBe(motivo);
  });
  it('distingue objetivo de renda de promessa e permite dado com fonte e recorte', () => {
    const plano = planejarFollowupCarreira('Cannabis Medicinal Veterinária', []);
    expect(validarFollowupCarreira('o que você gostaria de mudar nos seus ganhos na clínica?', 'cannabis:ganhos', plano, [])).toBeNull();
    expect(validarFollowupCarreira('a Catho relacionou qualificação e remuneração em cargos de coordenação num levantamento de 2019, sem prever o ganho de cada pessoa. o que gostaria de mudar nos seus ganhos?', 'cannabis:mercado', plano, [])).toBeNull();
  });
  it('corrige a suposição encontrada no modelo real sem inventar uma nova intenção', () => {
    const plano = planejarFollowupCarreira('Reprodução, Nutrição e Gestão de Bovinos (3em1)', []);
    const resposta = 'entendi, Gustavo. além de aumentar o valor cobrado, o que essa valorização representaria para você na sua consultoria?';
    const history = [{ role: 'user' as const, content: 'quero melhorar o valor do meu trabalho, não só atender mais fazendas' }];
    expect(validarFollowupCarreira(resposta, 'bovinos_3em1:valorizacao', plano, history)).toBe('decisao_de_preco_nao_declarada');
    const corrigida = corrigirPremissaDeCarreira(resposta, 'bovinos_3em1:valorizacao', plano, history);
    expect(corrigida).not.toContain('valor cobrado');
    expect(validarFollowupCarreira(corrigida, 'bovinos_3em1:valorizacao', plano, history)).toBeNull();
    expect(validarFollowupCarreira(corrigida, 'bovinos_3em1:valorizacao', plano, [{ role: 'assistant', content: corrigida }])).toBe('pergunta_repetida');
    expect(corrigirPremissaDeCarreira(resposta, 'bovinos_3em1:valorizacao', plano, [{ role: 'user', content: 'quero cobrar mais pelas visitas' }])).toBe(resposta);
    expect(corrigirPremissaDeCarreira(resposta, 'bovinos_3em1:valorizacao', plano, [{ role: 'user', content: 'não quero cobrar mais' }])).toBe(corrigida);
  });
  it.each(PERFIS_CARREIRA)('as perguntas de $id cabem em áudio quando o intervalo vence', perfil => {
    for (const pergunta of perfil.perguntas) {
      expect(avaliarPoliticaVoz({ habilitada: true, origem: 'followup', texto: pergunta, cadenciaAtingida: true }).permitido).toBe(true);
      expect(avaliarPoliticaVoz({ habilitada: true, origem: 'followup', texto: pergunta, cadenciaAtingida: false }).permitido).toBe(false);
    }
  });
});
