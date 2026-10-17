import { describe, expect, it } from 'vitest';
import { conviteSemAbertura, correcaoDaAbertura, cursoDaAbertura } from './travaAbertura';

const h = (...m: [string, unknown][]) => m.map(([role, content]) => ({ role, content })) as any;
const TEMPLATE = 'Oii Antônio Tudo bem? Já estou com seu cadastro, sou o monitor responsável pelo seu atendimento!';

describe('convite sem a abertura do lote (caso Antônio)', () => {
  it('convite ou horário sem a abertura feita: barra', () => {
    const hist = h(['assistant', TEMPLATE], ['user', 'Sim']);
    expect(conviteSemAbertura('beleza. é uma conversa individual de 10 minutos com o monitor sobre gestão e produção avícola. quer marcar?', hist)).toBe(true);
    expect(conviteSemAbertura('tenho 16h30, 17h ou 17h30 hoje. qual fica melhor?', hist)).toBe(true);
  });

  it('com a abertura na própria fala ou já feita na conversa: passa', () => {
    const hist = h(['assistant', TEMPLATE], ['user', 'Sim']);
    expect(conviteSemAbertura('a gente tá fechando o primeiro lote promocional da pós em x… é uma conversa rápida no meet com um monitor. tenho 17h. qual fica melhor?', hist)).toBe(false);
    const comAbertura = h(['assistant', TEMPLATE], ['assistant', 'a gente tá fechando o primeiro lote promocional da pós em x… é uma conversa rápida no meet com um monitor especialista'], ['user', 'pode ser']);
    expect(conviteSemAbertura('tenho 17h ou 17h30 hoje. qual fica melhor?', comAbertura)).toBe(false);
    expect(conviteSemAbertura('vc já se formou em medicina veterinária?', hist)).toBe(false);
    // O toque da pendência (17/10) fala do lote sem explicar o meet: não vale como abertura.
    const soLote = h(['assistant', TEMPLATE], ['assistant', 'josé, estamos em fechamento do primeiro lote promocional do MBA. me conta, vc trabalha onde?'], ['user', 'numa integradora']);
    expect(conviteSemAbertura('tenho 17h ou 17h30 hoje. qual fica melhor?', soLote)).toBe(true);
  });

  it('o curso da abertura é a alternativa aprovada', () => {
    const hist = h(['user', [{ type: 'tool_result', content: JSON.stringify({ compativel: true, curso_solicitado: 'Gestão e Produção Avícola' }) }]]);
    expect(cursoDaAbertura(hist, 'Sanidade Avícola')).toBe('Gestão e Produção Avícola');
    expect(cursoDaAbertura([], 'Sanidade Avícola')).toBe('Sanidade Avícola');
    expect(correcaoDaAbertura('x', 'Gestão e Produção Avícola')).toContain('primeiro lote promocional da pós em gestão e produção avícola');
  });
});
