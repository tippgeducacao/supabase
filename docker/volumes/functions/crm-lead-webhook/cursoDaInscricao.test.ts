import { describe, expect, it } from 'vitest';
import { aplicarCursoDaInscricao } from './cursoDaInscricao';

const banco = (respostas: Record<string, unknown>) => {
  const chamadas: Record<string, unknown>[] = [];
  return {
    chamadas,
    rpc: async (nome: string, args: Record<string, unknown>) => {
      chamadas.push({ nome, ...args });
      const r = respostas[String(args.p_curso)];
      return r instanceof Error ? { data: null, error: { message: r.message } } : { data: r ?? { trocou: false, motivo: 'curso_nao_reconhecido' }, error: null };
    },
  };
};
const JID = '5567999104552@s.whatsapp.net';

describe('inscrição nova: o que o webhook manda para a regra do banco', () => {
  it('caso Eliel: o curso do formulário troca e os títulos nem são tentados', async () => {
    const b = banco({ 'Qualidade e Segurança de Alimentos': { trocou: true, curso: 'PÓS | QUALIDADE E SEGURANÇA DE ALIMENTOS DE ORIGEM ANIMAL', curso_anterior: 'PÓS | SANIDADE AVÍCOLA' } });
    const r = await aplicarCursoDaInscricao(b, { remotejid: JID, candidatos: ['Qualidade e Segurança de Alimentos', 'TÍTULO DO CARD'], funilIds: ['f1', 'f1', null] });
    expect(r).toMatchObject({ trocou: true, curso_anterior: 'PÓS | SANIDADE AVÍCOLA' });
    expect(b.chamadas).toEqual([{ nome: 'crm_sdr_curso_da_inscricao', p_remotejid: JID, p_curso: 'Qualidade e Segurança de Alimentos', p_funil_ids: ['f1'] }]);
  });

  it('formulário com anotação de cadastro: cai no título do card', async () => {
    const b = banco({ 'PÓS | PRODUÇÃO DE SUÍNOS': { trocou: true, curso: 'PÓS | PRODUÇÃO DE SUÍNOS' } });
    const r = await aplicarCursoDaInscricao(b, { remotejid: JID, candidatos: ['Cadastrado por:Fulano', null, '  ', 'PÓS | PRODUÇÃO DE SUÍNOS'], funilIds: [] });
    expect(r?.trocou).toBe(true);
    expect(b.chamadas.map((c) => c.p_curso)).toEqual(['Cadastrado por:Fulano', 'PÓS | PRODUÇÃO DE SUÍNOS']);
  });

  it('para no primeiro curso reconhecido, mesmo sem trocar (aula, reunião marcada, mesmo curso)', async () => {
    for (const motivo of ['inscricao_em_aula', 'reuniao_marcada', 'mesmo_curso']) {
      const b = banco({ A: { trocou: false, motivo }, B: { trocou: true } });
      const r = await aplicarCursoDaInscricao(b, { remotejid: JID, candidatos: ['A', 'B'], funilIds: [] });
      expect(r).toEqual({ trocou: false, motivo });
      expect(b.chamadas).toHaveLength(1);
    }
  });

  it('não repete o mesmo texto e devolve null quando não há o que tentar', async () => {
    const b = banco({});
    expect(await aplicarCursoDaInscricao(b, { remotejid: JID, candidatos: ['Bovinos', 'BOVINOS', ' bovinos '], funilIds: [] }))
      .toEqual({ trocou: false, motivo: 'curso_nao_reconhecido' });
    expect(b.chamadas).toHaveLength(1);
    expect(await aplicarCursoDaInscricao(b, { remotejid: JID, candidatos: [null, undefined, ''], funilIds: [] })).toBeNull();
  });

  it('erro do banco sobe para o webhook registrar', async () => {
    const b = banco({ A: new Error('função ausente') });
    await expect(aplicarCursoDaInscricao(b, { remotejid: JID, candidatos: ['A'], funilIds: [] })).rejects.toThrow('função ausente');
  });
});
