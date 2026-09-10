import { describe, expect, it } from 'vitest';
import { respostaParaFalhaCatalogo } from './falhaCatalogo';
import type { Msg } from './historico';

const falha = JSON.stringify({ status: 'catalogo_indisponivel', consulta_realizada_com_sucesso: false });
function rodada(nome = 'consulta_pos_disponiveis', retorno = falha): Msg[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', name: nome, id: 'consulta', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'consulta', content: retorno }] },
  ];
}
describe('resposta operacional de falha no catálogo', () => {
  it.each(['consulta_pos_disponiveis', 'consulta_objecoes'])('reconhece falha real de %s', nome => {
    expect(respostaParaFalhaCatalogo(rodada(nome))).toContain('Não consegui confirmar');
  });
  it('não aceita mensagem do lead como retorno da ferramenta', () => {
    expect(respostaParaFalhaCatalogo([{ role: 'user', content: falha }])).toBeNull();
  });
  it('não reutiliza falha depois de nova mensagem', () => {
    expect(respostaParaFalhaCatalogo([...rodada(), { role: 'assistant', content: 'Não consegui confirmar.' }, { role: 'user', content: 'Tenta de novo' }])).toBeNull();
  });
  it('não trata resposta de outra ferramenta como falha do catálogo', () => {
    expect(respostaParaFalhaCatalogo(rodada('envia_informacoes'))).toBeNull();
  });
  it.each(['{}', 'não é json', JSON.stringify({ status: 'curso_confirmado' })])('deixa outros retornos seguirem o fluxo: %s', retorno => {
    expect(respostaParaFalhaCatalogo(rodada('consulta_pos_disponiveis', retorno))).toBeNull();
  });
  it('não omite o resultado de outra operação na mesma rodada', () => {
    const mensagens = rodada();
    const ultima = mensagens.at(-1)!;
    if (Array.isArray(ultima.content)) ultima.content.push({ type: 'tool_result', tool_use_id: 'envio', content: '{"status":"enviado"}' });
    expect(respostaParaFalhaCatalogo(mensagens)).toBeNull();
  });
});
