import { describe, expect, it } from 'vitest';
import { contextoAulaPiloto, carregarAulaParaFollowup } from './contextoAulaPiloto';

const aula = { titulo: 'Dor em animais', tema: 'canabinoides', inicio_em: '2026-09-28T22:00:00Z', link: 'https://youtube.com/watch?v=teste', curso_nome: 'Cannabis Medicinal Veterinária' };
describe('campanha da aula chega à conversa e à retomada', () => {
  it.each([
    ['2026-09-18T12:00:00Z', 'data', '28/09 às 19h00'],
    ['2026-09-27T12:00:00Z', 'amanha', 'amanhã'],
    ['2026-09-28T12:00:00Z', 'hoje', 'hoje'],
    ['2026-09-28T22:30:00Z', 'agora', 'acontecendo agora'],
    ['2026-09-29T12:00:00Z', 'encerrada', 'já acabou'],
  ])('usa o relógio de Brasília em %s, sem inferir presença', (agora, estado, quando) => {
    const contexto = contextoAulaPiloto(aula, new Date(agora));
    expect(contexto).toContain(`"estado":"${estado}"`);
    expect(contexto).toContain(quando);
    expect(contexto).toContain(aula.link);
    expect(contexto).toContain('não comprova presença');
  });
  it('campanha sem cadastro não recebe fatos da pós antiga', () => {
    expect(contextoAulaPiloto(null)).toContain('não confirmados');
  });
  it('carrega a pós vinculada à aula, não o curso antigo do lead', async () => {
    const consulta: any = {};
    const filtros: unknown[] = [];
    consulta.select = () => consulta;
    consulta.eq = (...args: unknown[]) => { filtros.push(args); return consulta; };
    consulta.maybeSingle = async () => ({ data: { ...aula, cursos: { nome: aula.curso_nome } }, error: null });
    const carregada = await carregarAulaParaFollowup({ from: () => consulta }, { curso_interesse_original: 'Pós antiga', contexto_campanha: { aula_id: 'aula-atual' } });
    expect(carregada?.curso_nome).toBe(aula.curso_nome);
    expect(filtros).toContainEqual(['id', 'aula-atual']);
    expect(filtros).toContainEqual(['ativo', true]);
  });
});
