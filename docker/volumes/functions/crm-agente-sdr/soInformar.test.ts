// IA de aula v2 (01/10/2026): com `soInformar`, as ferramentas dizem o fato e não mandam o próximo passo.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fatoDaColeta, proximoPassoDaColeta } from './proximoPassoColeta';
import { montarRetornoInformacoes } from './envioMateriais';
import { contextoAulaPiloto } from './contextoAulaPiloto';

let T: typeof import('./tools');
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  T = await import('./tools');
});

const AGORA = new Date('2026-10-01T12:00:00Z');
const ORDEM = /pergunte|chame|responda|conecte|termine|despeça|siga|ofereça/i;

describe('anotação dos dados: fato, sem ordem', () => {
  it('estudante sem data: diz que falta, não manda perguntar', () => {
    const fato = fatoDaColeta({ formacao: 'Medicina Veterinária', graduacao_concluida: 'cursando' }, AGORA);
    expect(fato).toContain('mês e ano de conclusão ainda não informados');
    expect(fato).not.toMatch(ORDEM);
    expect(proximoPassoDaColeta({ formacao: 'Medicina Veterinária', graduacao_concluida: 'cursando' }, AGORA)).toMatch(/pergunte/i);
  });

  it('estudante fora do prazo e formado: só a situação', () => {
    expect(fatoDaColeta({ formacao: 'Medicina Veterinária', tempo_formacao: 'me formo em dezembro de 2030' }, AGORA))
      .toMatch(/conclui em 12\/2030, depois da data-limite/);
    const formado = fatoDaColeta({ formacao: 'Medicina Veterinária', graduacao_concluida: 'sim' }, AGORA);
    expect(formado).toContain('SITUAÇÃO: formado');
    for (const t of [formado]) expect(t).not.toMatch(ORDEM);
  });
});

describe('agenda, preço e ficha', () => {
  const base = { hoje: { iso: '2026-10-01', display: 'quinta-feira, 01/10/2026' }, data_pedida: '2026-10-02', horarios: [], formacao_checada: false };
  const h = { data: '2026-10-02', dia_semana: 'sexta-feira', horario: '10:00', display: '10h', vendedor_id: 'v1', vendedor_nome: 'Ana' };

  it('agenda em fatos mantém as linhas que a trava lê e tira a condução', () => {
    const t = T.textoDisponibilidadeSoFatos({ ...base, situacao: 'ok', horarios: [h] } as any);
    expect(t).toContain('- 10h de sexta-feira, dia 2026-10-02 (vendedor_id: v1, nome: Ana)');
    expect(t).toContain('Formação do lead ainda não verificada');
    expect(t).not.toMatch(/diga|apresentar|ofere/i);
    expect(T.textoDisponibilidadeSoFatos({ ...base, situacao: 'erro_tecnico' } as any)).not.toMatch(/retorna|confirmar com o time/i);
    expect(T.saidaDisponibilidade({ ...base, situacao: 'ok', horarios: [h] } as any, 'c1', true).resultado).toBe(t);
    expect(T.saidaDisponibilidade({ ...base, situacao: 'ok', horarios: [h] } as any, 'c1').resultado).toContain('Ao apresentar as opções');
  });

  it('preço sem o roteiro de mensagens', () => {
    const dados = { data: { valor_integral: 'R$ 12.730,00 em até 24x no cartão de crédito', valor_matricula: 'R$ 492,50' } };
    const com = JSON.stringify(montarRetornoInformacoes(true, dados, 'valor', 'c1'));
    const sem = JSON.stringify(montarRetornoInformacoes(true, dados, 'valor', 'c1', { semGuia: true }));
    expect(sem).toContain('12.730');
    expect(sem.length).toBeLessThan(com.length);
  });

  it('estudante reprovado pedindo próxima turma: fato, sem ordem', () => {
    const r = T.bloqueioProximaTurmaDeEstudante('c1', true) as any;
    expect(r.instrucao).toBeUndefined();
    expect(r.resultado).toContain('retorno por formatura');
  });

  it('a ficha antiga sai do contexto da aula só com a v2', () => {
    const aula = { titulo: 'Cannabis', inicio_em: '2026-10-08T22:00:00Z', curso_nome: 'PÓS | CANNABIS MEDICINAL VETERINÁRIA' } as any;
    expect(contextoAulaPiloto(aula, AGORA)).toContain('aula_ficha_pos');
    expect(contextoAulaPiloto(aula, AGORA, { semFichaAntiga: true })).not.toContain('aula_ficha_pos');
  });
});
