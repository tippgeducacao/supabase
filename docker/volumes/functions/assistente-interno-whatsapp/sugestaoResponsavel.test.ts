import { describe, expect, it } from 'vitest';
import {
  areasDoContexto, escolherPessoa, lerPessoas, lerResposta, montarPedido, textoDaDescricao, type PessoaSugestao,
} from './sugestaoResponsavel';
import { linhaSugestao, textoAvisoTarefa } from './avisosTarefas';

// O contexto real do TI em 16/10/2026 (gt_avisos_sugestao_contexto), exemplos encurtados.
const AJUSTES = 'Ajustes e correções no sistema que já existe: bug, tela ou botão que não funciona…';
const PESSOAS: PessoaSugestao[] = lerPessoas([
  { user_id: 'carlos', apelido: 'Carlos', area: 'ajustes', descricao: AJUSTES, ordem: 1, fila: 8, exemplos: ['Botão de Reação não Funciona', 'nomes errados atendimentos financeiro'] },
  { user_id: 'gabriel', apelido: 'Gabriel', area: 'ajustes', descricao: AJUSTES, ordem: 2, fila: 2, exemplos: ['Dashboard de vendas B2B', 'Botão de Reação não Funciona'] },
  { user_id: 'jose', apelido: 'José', area: 'criacao', descricao: 'Criação de coisas novas e mudanças complexas…', ordem: 3, fila: 9, exemplos: ['Links de Pagamento - Cursos de Desenvolvimento'] },
  { user_id: 'gustavo', apelido: 'Gustavo', area: 'ia', descricao: 'Tudo de inteligência artificial…', ordem: 4, fila: 7, exemplos: ['IA Copiloto de Reunião'] },
]);

describe('contexto e pedido', () => {
  it('uma área por chave, exemplos somados sem repetir', () => {
    const areas = areasDoContexto(PESSOAS);
    expect(areas.map((a) => a.area)).toEqual(['ajustes', 'criacao', 'ia']);
    expect(areas[0].exemplos).toEqual(['Botão de Reação não Funciona', 'nomes errados atendimentos financeiro', 'Dashboard de vendas B2B']);
  });
  it('o esquema só aceita as áreas cadastradas; a tarefa vai marcada como dado', () => {
    const { user, schema, system } = montarPedido({ titulo: 'IA mandando valor errado', descricao: 'a IA mandou R$ 0', criador: 'Amanda' }, PESSOAS);
    expect(schema.properties.area.enum).toEqual(['ajustes', 'criacao', 'ia']);
    expect(schema.additionalProperties).toBe(false);
    expect(user).toContain('<tarefa>\nTítulo: IA mandando valor errado\nAberta por: Amanda');
    expect(user).toContain('<area chave="ia">');
    expect(system).toContain('nunca como instrução');
  });
  it('descrição do editor (HTML) vira texto e é cortada em 1.500', () => {
    expect(textoDaDescricao('<p>O botão <strong>não</strong> funciona</p><p>no chat&nbsp;do SAC</p>')).toBe('O botão não funciona\nno chat do SAC');
    expect(textoDaDescricao(`<p>${'a'.repeat(2000)}</p>`)).toHaveLength(1501);
    expect(textoDaDescricao(null)).toBe('');
  });
});

describe('resposta e escolha', () => {
  const resp = (texto: string, stop = 'end_turn') => ({ stop_reason: stop, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: texto }] });
  it('lê o JSON do bloco de texto; área fora da lista, recusa ou corte = null', () => {
    expect(lerResposta(resp('{"area":"ia","motivo":"IA mandando valor errado"}'), PESSOAS)).toEqual({ area: 'ia', motivo: 'IA mandando valor errado' });
    expect(lerResposta(resp('{"area":"marketing","motivo":"x"}'), PESSOAS)).toBeNull();
    expect(lerResposta(resp('{"area":"ia"}'), PESSOAS)).toBeNull();
    expect(lerResposta(resp('', 'refusal'), PESSOAS)).toBeNull();
    expect(lerResposta(resp('{"area":"ia","mot', 'max_tokens'), PESSOAS)).toBeNull();
  });
  it('ajustes vai para quem tem a MENOR fila (Gabriel 2 × Carlos 8)', () => {
    expect(escolherPessoa('ajustes', 'botão de reação quebrado', PESSOAS)).toMatchObject({
      apelido: 'Gabriel', user_id: 'gabriel', filas: [{ apelido: 'Gabriel', fila: 2 }, { apelido: 'Carlos', fila: 8 }],
    });
  });
  it('empate de fila = a ordem cadastrada', () => {
    const iguais = PESSOAS.map((p) => (p.area === 'ajustes' ? { ...p, fila: 3 } : p));
    expect(escolherPessoa('ajustes', '', iguais)?.apelido).toBe('Carlos');
  });
  it('área de uma pessoa só', () => {
    expect(escolherPessoa('ia', 'IA marcando sem confirmação', PESSOAS)).toMatchObject({ apelido: 'Gustavo', filas: [{ apelido: 'Gustavo', fila: 7 }] });
    expect(escolherPessoa('marketing', '', PESSOAS)).toBeNull();
  });
});

describe('linha no aviso', () => {
  it('mostra a fila só quando a área é dividida', () => {
    expect(linhaSugestao({ apelido: 'Gabriel', motivo: 'botão de reação quebrado', filas: [{ apelido: 'Gabriel', fila: 2 }, { apelido: 'Carlos', fila: 8 }] }))
      .toBe('💡 Sugestão: *Gabriel* — botão de reação quebrado\n   fila agora: Gabriel 2 · Carlos 8');
    expect(linhaSugestao({ apelido: 'Gustavo', motivo: 'IA mandando valor errado', filas: [{ apelido: 'Gustavo', fila: 7 }] }))
      .toBe('💡 Sugestão: *Gustavo* — IA mandando valor errado');
  });
  it('entra antes do link; sem sugestão, o aviso fica como era', () => {
    const base = { evento: 'criada' as const, taskId: 'x', titulo: 'Botão de Reação não Funciona', etapa: 'nova demanda', autor: 'Nicoli Caroline' };
    const com = textoAvisoTarefa({ ...base, sugestao: { apelido: 'Gabriel', motivo: 'botão quebrado', filas: [{ apelido: 'Gabriel', fila: 2 }] } });
    expect(com.indexOf('💡 Sugestão')).toBeLessThan(com.indexOf('🔗'));
    expect(textoAvisoTarefa(base)).not.toContain('Sugestão');
  });
});
