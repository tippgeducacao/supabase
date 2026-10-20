import { describe, expect, it } from 'vitest';
import { MAX_TRECHO, linkCanal, textoAvisoPessoal, textoDaMensagem } from './avisosPessoais';

const TAREFA = '864e1285-18fe-4e3f-8b09-00a7c42b08bc';
const CANAL = '7062dba5-7793-4221-a52d-9600d3ddbeeb';
const APP = 'https://sistemappgvet.ppgeducacao.site';

describe('textoDaMensagem', () => {
  it('HTML do editor: tira as tags, mantém o @ da menção e decodifica entidades', () => {
    const html = '<p><span class="gt-mention" data-type="mention" data-id="x" data-label="José">@José</span> fica em PEDAGÓGICO &gt; ACADÊMICO &amp; TCC</p>';
    expect(textoDaMensagem(html)).toBe('@José fica em PEDAGÓGICO > ACADÊMICO & TCC');
  });
  it('parágrafos e lista viram linhas', () => {
    expect(textoDaMensagem('<p>Bom dia</p><ul><li>um</li><li>dois</li></ul><p></p><p></p><p>fim</p>'))
      .toBe('Bom dia\n• um\n• dois\n\nfim');
  });
  it('texto puro passa igual', () => {
    expect(textoDaMensagem('no contrato não havia data especificada')).toBe('no contrato não havia data especificada');
  });
  it('corta no teto com reticências', () => {
    const t = textoDaMensagem('a'.repeat(MAX_TRECHO + 50));
    expect(t.length).toBe(MAX_TRECHO + 1);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('textoAvisoPessoal', () => {
  it('menção em tarefa: título do sino, o comentário e o link', () => {
    const t = textoAvisoPessoal({
      tipo: 'task_mention',
      titulo: 'Adriane mencionou você em "Tarefa: Links de Pagamento"',
      autor: 'Adriane',
      conteudo: '<p>@José @Welinton links de pagamento dos cursos</p>',
      link: `/gestor-tarefas?task=${TAREFA}`,
    });
    expect(t).toBe([
      '🔔 *Adriane mencionou você em "Tarefa: Links de Pagamento"*',
      '',
      '@José @Welinton links de pagamento dos cursos',
      '',
      `🔗 ${APP}/gestor-tarefas?task=${TAREFA}`,
    ].join('\n'));
  });
  it('mensagem nova num canal: quem e qual canal, nome curto', () => {
    const t = textoAvisoPessoal({
      tipo: 'canal', autor: 'Welinton Pereira da Silva', canal: 'LÍDERES PPG', tipoCanal: 'channel',
      conteudo: 'reunião amanhã às 9h', messageType: 'text', link: linkCanal(CANAL),
    });
    expect(t.split('\n')[0]).toBe('💬 *Welinton Silva* no canal *LÍDERES PPG*');
    expect(t).toContain('reunião amanhã às 9h');
    expect(t).toContain(`🔗 ${APP}/gestor-tarefas?channel=${CANAL}`);
  });
  it('grupo diz "no grupo"; mensagem sem autor é aviso automático', () => {
    expect(textoAvisoPessoal({ tipo: 'canal', autor: 'Laura', canal: 'Projeto X', tipoCanal: 'group', conteudo: 'oi' }))
      .toMatch(/^💬 \*Laura\* no grupo \*Projeto X\*/);
    expect(textoAvisoPessoal({ tipo: 'canal', autor: null, canal: 'LÍDERES PPG', tipoCanal: 'channel', conteudo: 'A reunião começa em 10 min' }))
      .toMatch(/^📣 Aviso automático no canal \*LÍDERES PPG\*/);
  });
  it('só anexo: diz o que chegou em vez de sair vazio', () => {
    expect(textoAvisoPessoal({ tipo: 'canal', autor: 'Laura', canal: 'C', conteudo: '', messageType: 'image', anexos: 1 }))
      .toContain('\n\n🖼️ imagem');
    expect(textoAvisoPessoal({ tipo: 'canal', autor: 'Laura', canal: 'C', conteudo: '', messageType: 'file', anexos: 2 }))
      .toContain('\n\n📎 2 arquivos');
  });
  it('texto com anexo: o texto e a linha do anexo', () => {
    const t = textoAvisoPessoal({ tipo: 'canal', autor: 'Laura', canal: 'C', conteudo: 'segue o print', messageType: 'image', anexos: 1 });
    expect(t).toContain('segue o print\n📎 1 anexo');
  });
  it('mensagem direta e resposta em thread', () => {
    expect(textoAvisoPessoal({ tipo: 'chat_dm', titulo: 'Carlos Badia', autor: 'Carlos Badia', conteudo: 'pode ver?' }))
      .toMatch(/^✉️ Mensagem direta de \*Carlos Badia\*\n\npode ver\?$/);
    expect(textoAvisoPessoal({ tipo: 'reply', titulo: 'Laura respondeu em "MARKETING X PEDAGÓGICO"', conteudo: 'feito' }))
      .toMatch(/^↩️ \*Laura respondeu em "MARKETING X PEDAGÓGICO"\*/);
  });
  it('colocaram a pessoa como responsável: 📌, quem fez e o link da tarefa', () => {
    expect(textoAvisoPessoal({
      tipo: 'task_assigned',
      titulo: 'Você é responsável por "SQUAD 07 - Marisa - CAMPANHA DE COBRANÇAS"',
      conteudo: 'Bruno Barreta colocou você como responsável.',
      link: `/gestor-tarefas?task=${TAREFA}`,
    })).toBe(
      '📌 *Você é responsável por "SQUAD 07 - Marisa - CAMPANHA DE COBRANÇAS"*\n\n'
      + 'Bruno Barreta colocou você como responsável.\n\n'
      + `🔗 ${APP}/gestor-tarefas?task=${TAREFA}`,
    );
  });
  it('tipo do sino sem régua própria usa o título', () => {
    expect(textoAvisoPessoal({ tipo: 'task_status_change', titulo: 'Status alterado: Ajuste X', link: null }))
      .toBe('🔔 *Status alterado: Ajuste X*');
  });
});
