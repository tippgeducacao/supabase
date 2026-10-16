import { describe, expect, it } from 'vitest';
import { NOTA_SEM_POS, posDoCadastroDefinida } from './indicacaoPortfolio';

// Catálogo de mentira: só "PÓS | CANNABIS MEDICINAL VETERINÁRIA" existe.
const banco = {
  from: () => {
    const q: any = { select: () => q, eq: () => q, order: async () => ({ data: [{ id: 'c1', nome: 'PÓS | CANNABIS MEDICINAL VETERINÁRIA' }], error: null }) };
    return q;
  },
  rpc: async () => ({ data: { id: null }, error: null }),
} as any;

describe('lead de indicação sem pós no cadastro (casos Lorrayne e Luiza)', () => {
  it('a origem gravada no lugar do curso não é pós', async () => {
    expect(await posDoCadastroDefinida(banco, 'Cadastrado por:Adones')).toBe(false);
    expect(await posDoCadastroDefinida(banco, 'Captação orgânica por:Wellyngton Mateus')).toBe(false);
    expect(await posDoCadastroDefinida(banco, '')).toBe(false);
    expect(await posDoCadastroDefinida(banco, null)).toBe(false);
  });

  it('pós do catálogo é pós; nome que não existe, não', async () => {
    expect(await posDoCadastroDefinida(banco, 'PÓS | CANNABIS MEDICINAL VETERINÁRIA')).toBe(true);
    expect(await posDoCadastroDefinida(banco, 'Bovinocultura de corte avançada')).toBe(false);
  });

  it('a nota manda o portfólio sem perguntar a graduação e espera a escolha dele', () => {
    expect(NOTA_SEM_POS).toContain('conteudo="portfolio"');
    expect(NOTA_SEM_POS).toContain('sem perguntar a graduação antes');
    expect(NOTA_SEM_POS).toContain('trocar_para');
  });
});

describe('a ficha do lead sem pós', () => {
  it('tira a coleta do cronograma e põe o portfólio como próximo passo', async () => {
    const { fichaSemPos } = await import('./indicacaoPortfolio');
    const ficha = '[FICHA]\nCronograma: pedido\nFALTA COLETAR antes de enviar o cronograma: qual é a graduação dele\nPRÓXIMO PASSO: Antes de enviar o cronograma, diga "claro"';
    const nova = fichaSemPos(ficha);
    expect(nova).not.toContain('FALTA COLETAR');
    expect(nova).not.toContain('Antes de enviar o cronograma, diga');
    expect(nova).toContain('PRÓXIMO PASSO: lead sem pós definida');
    expect(nova).toContain('conteudo="portfolio"');
    expect(nova).toContain('Cronograma: pedido');
  });
});

describe('o portfólio da indicação sai pelo código', () => {
  it('recusa não recebe portfólio; dúvida e "não sei" recebem', async () => {
    const { recusaDaIndicacao } = await import('./indicacaoPortfolio');
    for (const f of ['Não me notifique', 'não tenho interesse', 'para de me mandar mensagem', 'Sair']) expect(recusaDaIndicacao(f)).toBe(true);
    for (const f of ['Que pós graduação?', 'Não sei', 'Vcs que mandaram mensagem', 'quem é?', 'Receber Cronograma']) expect(recusaDaIndicacao(f)).toBe(false);
  });

  it('portfólio já enviado: pela fala da IA ou pelo vendedor', async () => {
    const { portfolioJaEnviado, FALA_DEPOIS_DO_PORTFOLIO_INDICACAO } = await import('./indicacaoPortfolio');
    expect(portfolioJaEnviado([{ role: 'assistant', content: FALA_DEPOIS_DO_PORTFOLIO_INDICACAO }])).toBe(true);
    expect(portfolioJaEnviado([{ role: 'assistant', content: '[ATENDIMENTO_HUMANO] O atendente humano Flávia solicitou o envio do documento "Portfolio_2026.pdf"' }])).toBe(true);
    expect(portfolioJaEnviado([{ role: 'assistant', content: 'oi' }, { role: 'user', content: 'te enviei o portfólio' }])).toBe(false);
  });
});
