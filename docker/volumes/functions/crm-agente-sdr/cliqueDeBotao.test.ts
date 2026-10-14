import { describe, expect, it } from 'vitest';
import { cliqueDoPayload, notaCliqueLigada, notaDosCliques } from './cliqueDeBotao';

// Caso sarandaurio (14/10/2026): o clique no botão do template de VENDA foi lido como confirmação da
// aula, que tinha saído um minuto antes.
const VENDA = 'Oi sarandaurio@gmail.com. \n\nestamos com as vagas abertas para a turma de Pós em comportamento e bem estar animal com vagas abertas..... Tenho 2 horários para conversar agora a tarde 13:30h e 16:30h! Qual fica melhor?\n\nConsegue confirmar?';
const PAYLOAD = {
  tipo: 'button', telefone: '5566999128645',
  conteudo: `[Em resposta à mensagem: "${VENDA}"] Confirmar participação`,
  quoted: { id: 'wamid.VENDA', conteudo: VENDA },
};

describe('o clique de botão e a mensagem clicada', () => {
  it('lê o botão sem a citação e guarda a mensagem citada', () => {
    expect(cliqueDoPayload(PAYLOAD)).toEqual({ botao: 'Confirmar participação', citadoId: 'wamid.VENDA', citadoTexto: VENDA });
    expect(cliqueDoPayload({ ...PAYLOAD, tipo: 'interactive', interactive_reply: { tipo: 'button_reply', title: 'Quero conversar' } })?.botao).toBe('Quero conversar');
  });

  it('texto digitado, clique sem mensagem citada e pedido de ligação ficam de fora', () => {
    expect(cliqueDoPayload({ ...PAYLOAD, tipo: 'text' })).toBeNull();
    expect(cliqueDoPayload({ ...PAYLOAD, quoted: null })).toBeNull();
    expect(cliqueDoPayload({ ...PAYLOAD, tipo: 'interactive', interactive_reply: { tipo: 'call_permission_reply', title: 'aceitou' } })).toBeNull();
    expect(cliqueDoPayload(null)).toBeNull();
  });
});

describe('a nota do contexto', () => {
  const AGORA = new Date('2026-10-14T12:49:00Z');
  const banco = (linhas: unknown[] | null, erro: unknown = null) => {
    const filtros: unknown[][] = [];
    const q: any = { select: () => q, eq: (...a: unknown[]) => { filtros.push(['eq', ...a]); return q; },
      in: (...a: unknown[]) => { filtros.push(['in', ...a]); return q; }, limit: async () => ({ data: linhas, error: erro }) };
    return { filtros, from: () => q };
  };

  it('com a mensagem no CRM: texto inteiro, template e hora, só do próprio telefone', async () => {
    const b = banco([{ conteudo: VENDA, template_name: 'confir_prova_utility', created_at: '2026-10-14T12:42:00Z' }]);
    const nota = await notaDosCliques(b, '5566999128645', [cliqueDoPayload(PAYLOAD)!], AGORA);
    expect(nota).toContain('O LEAD CLICOU NUM BOTÃO');
    expect(nota).toContain('botão "Confirmar participação", na mensagem (enviada hoje às 09:42, template confir_prova_utility)');
    expect(nota).toContain('13:30h e 16:30h');
    expect(nota).toContain('não a outras mensagens da conversa');
    expect(b.filtros).toContainEqual(['eq', 'wa_message_id', 'wamid.VENDA']);
    expect(b.filtros.some((f) => f[0] === 'in' && f[1] === 'telefone')).toBe(true);
  });

  it('sem a mensagem no CRM (ou com erro), vale o texto citado que veio no clique', async () => {
    const nota = await notaDosCliques(banco([], null), '5566999128645', [cliqueDoPayload(PAYLOAD)!], AGORA);
    expect(nota).toContain('botão "Confirmar participação", na mensagem "Oi sarandaurio');
    expect(await notaDosCliques(banco(null, { message: 'x' }), '5566999128645', [cliqueDoPayload(PAYLOAD)!], AGORA)).toContain('13:30h');
  });

  it('sem clique, nada', async () => {
    expect(await notaDosCliques(banco([]), '5566999128645', [], AGORA)).toBe('');
  });

  it('a chave: desligada por padrão; liga para todos ou só para o telefone de ensaio', async () => {
    const cfg = (data: unknown) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }) }) }) }) });
    expect(await notaCliqueLigada(cfg({ nota_clique_botao: false, nota_clique_botao_telefones: [] }), '5546988166051')).toBe(false);
    expect(await notaCliqueLigada(cfg({ nota_clique_botao: true, nota_clique_botao_telefones: [] }), '5511999990000')).toBe(true);
    expect(await notaCliqueLigada(cfg({ nota_clique_botao: false, nota_clique_botao_telefones: ['5546988166051'] }), '554688166051')).toBe(true);
    expect(await notaCliqueLigada(cfg(null), '5546988166051')).toBe(false);
  });
});

// Relato do Adones (14/10/2026): o módulo prático era o gancho; o clique confirmava a conversa.
describe('convite com horário de conversa', () => {
  const MODULO = 'Oi Amanhã iniciaremos nosso módulo prático presencial aqui no Rio Grande do Sul. Quer fazer parte e aprender na prática sobre reprodução?. \n\nHoje, o coordenador estará disponível para uma conversa, com dois horários: 11h ou 18h. Qual fica melhor para você?\n\nConsegue confirmar?';

  it('acha os horários da conversa nos dois formatos de template', async () => {
    const { horariosDeConversa } = await import('./cliqueDeBotao');
    expect(horariosDeConversa(MODULO)).toEqual(['11h', '18h']);
    expect(horariosDeConversa(VENDA)).toEqual(['13h30', '16h30']);
    expect(horariosDeConversa('Sua participação na aula do dia 04/11 às 19h está confirmada!')).toEqual([]);
    expect(horariosDeConversa('Te espero amanhã para a reunião das 10:15')).toEqual(['10h15']);
    // Lembrete de reunião já marcada não é convite.
    expect(horariosDeConversa('Lembrete: sua reunião com o monitor é amanhã às 10h. Consegue confirmar?')).toEqual([]);
    expect(horariosDeConversa('Sua conversa está confirmada para hoje às 15h')).toEqual([]);
  });

  it('com a leitura ligada, a nota diz que o clique aceita a conversa e que o resto é gancho', async () => {
    const AGORA = new Date('2026-10-14T16:17:00Z');
    const vazio = { from: () => { const q: any = { select: () => q, eq: () => q, in: () => q, limit: async () => ({ data: [], error: null }) }; return q; } };
    const clique = cliqueDoPayload({ ...PAYLOAD, conteudo: `[Em resposta à mensagem: "${MODULO}"] Confirmar participação`, quoted: { id: 'x', conteudo: MODULO } })!;
    const ligada = await notaDosCliques(vazio, '5567999761100', [clique], AGORA, { convite: true });
    expect(ligada).toContain('os horários dela (11h, 18h) são dessa conversa');
    expect(ligada).toContain('não uma inscrição');
    const desligada = await notaDosCliques(vazio, '5567999761100', [clique], AGORA);
    expect(desligada).not.toContain('são dessa conversa');
  });
});
