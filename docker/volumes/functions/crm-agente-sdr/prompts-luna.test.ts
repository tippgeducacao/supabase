// O prompt da Luna (prompts-luna.ts) é editado à mão para ser enxugado. Estes testes NÃO travam o
// texto: travam só o que o CÓDIGO procura dentro dele. Se um falhar depois de um corte, o recado
// diz o que deixou de funcionar — decida se volta o trecho ou se ajusta o código junto.
import { describe, expect, it } from 'vitest';
import {
  LUNA_AGENTE_QUALIFICADOR, LUNA_AGENTE_VALIDACAO, LUNA_CANAL_RESPOSTA, LUNA_ELEGIBILIDADE, LUNA_ENVIO_MATERIAIS,
  LUNA_FICHA, LUNA_MEMORIA_HUMANA, LUNA_PERSONA_ABERTURA, LUNA_PERSONA_FECHAMENTO,
} from './prompts-luna';
import { AGENTE_QUALIFICADOR, AGENTE_VALIDACAO } from './prompts';
import { blocosDoPrompt } from './conjuntoPrompt';
import { renderPrompt } from './contexto';
import { comGanchoDoLote, cursoDaConversa, secaoGanchoLote, TITULO_SECAO_GANCHO } from './ganchoLote';
import { MARCADOR_MENSAGEM_LEAD_PAUSA } from './memoriaHumana';
import { SCRIPT_ANTES_DO_CRONOGRAMA, SCRIPT_PERGUNTA_POS } from './fichaAtendimento';
import { NOME_TOOL_RESPOSTA } from './canalResposta';

// As mesmas variáveis que o index.ts preenche.
const vars = {
  nome: 'Gustavo', curso_interesse_original: 'MBA GESTÃO DA PECUÁRIA LEITERA', pergunta_formacao: 'qual é a sua graduação?',
  curso_com_artigo: cursoDaConversa('MBA GESTÃO DA PECUÁRIA LEITERA'),
};
const ocorrencias = (texto: string, re: RegExp) => (texto.match(re) ?? []).length;
const naSecao = (re: RegExp) => ocorrencias(secaoGanchoLote({ nome: 'Gustavo', curso: vars.curso_interesse_original }), re);

describe('prompt da Luna: o que o código procura dentro do texto', () => {
  it('as personas completas = persona + elegibilidade + envio de materiais', () => {
    expect(LUNA_AGENTE_VALIDACAO).toBe(`${LUNA_PERSONA_ABERTURA}\n\n${LUNA_ELEGIBILIDADE}\n\n${LUNA_ENVIO_MATERIAIS}`);
    expect(LUNA_AGENTE_QUALIFICADOR).toBe(`${LUNA_PERSONA_FECHAMENTO}\n\n${LUNA_ELEGIBILIDADE}\n\n${LUNA_ENVIO_MATERIAIS}`);
  });

  it('memória humana cita o marcador que o código grava no histórico', () => {
    expect(LUNA_MEMORIA_HUMANA, `o histórico marca falas da pausa com ${MARCADOR_MENSAGEM_LEAD_PAUSA}; sem citar, a Luna não sabe o que é`).toContain(MARCADOR_MENSAGEM_LEAD_PAUSA);
  });

  it('ficha: as duas frases-padrão do cronograma são as que o código procura no texto enviado', () => {
    // marcarPerguntasDaFicha (fichaAtendimento.ts) reconhece a pergunta feita por estas frases.
    // Mudou a frase aqui? Mude também SCRIPT_ANTES_DO_CRONOGRAMA / SCRIPT_PERGUNTA_POS.
    expect(LUNA_FICHA).toContain(SCRIPT_ANTES_DO_CRONOGRAMA);
    // 09/10/2026: depois do cronograma a Luna oferece horário; a pergunta da pós saiu.
    expect(LUNA_FICHA).not.toContain(SCRIPT_PERGUNTA_POS);
    expect(LUNA_FICHA).toContain('ofereça até três horários reais');
  });

  it('canal de resposta cita a ferramenta que o código exige', () => {
    expect(LUNA_CANAL_RESPOSTA).toContain(NOME_TOOL_RESPOSTA);
  });

  // 29/09/2026: o lote está ESCRITO no prompt da Luna (antes, ganchoLote.ts trocava por regex).
  it('lote escrito no prompt: a seção do gancho está nas duas personas e a troca por regex não mexe nelas', () => {
    for (const [nome, persona] of [['abertura', LUNA_AGENTE_VALIDACAO], ['fechamento', LUNA_AGENTE_QUALIFICADOR]] as const) {
      const texto = renderPrompt(persona, vars);
      expect(ocorrencias(texto, new RegExp(TITULO_SECAO_GANCHO.replace(/[()]/g, '\\$&'), 'g')),
        `${nome}: sem "${TITULO_SECAO_GANCHO}" o ganchoLote.ts volta a trocar o texto por regex e cola a seção de novo`).toBe(1);
      expect(comGanchoDoLote(texto, { nome: 'Gustavo', curso: vars.curso_interesse_original }).prompt).toBe(texto);
      // Só a frase da regra cita as expressões proibidas; fora dela, a oferta é "primeiro lote promocional".
      expect(ocorrencias(texto, /secretaria/gi), `${nome}: "secretaria" fora da regra do nome da oferta`).toBe(naSecao(/secretaria/gi));
      expect(ocorrencias(texto, /condição especial/gi), `${nome}: "condição especial" fora da regra`).toBe(naSecao(/condição especial/gi));
      expect(texto, `${nome}: "condição liberada hoje" é o nome antigo da oferta`).not.toMatch(/condição (especial )?liberada hoje/i);
      expect(texto.match(/\{\{\s*\$json\.\w+\s*\}\}/g), `${nome}: variável sem valor no index.ts`).toBeNull();
    }
  });

  it('abertura da Luna: as palavras de 21/09, com o curso do jeito que se fala', () => {
    const texto = renderPrompt(LUNA_AGENTE_VALIDACAO, vars);
    expect(texto).toContain('a gente tá fechando o primeiro lote promocional do MBA em gestão da pecuária leitera, e eu queria te mostrar a condição');
    expect(texto).toContain('é uma conversa rápida no meet com um monitor especialista, uns 10 minutos, e vc já tira suas dúvidas.');
  });

  it('produção (Claude no canário) continua recebendo a troca por regex', () => {
    const r = comGanchoDoLote(renderPrompt(AGENTE_VALIDACAO, vars), { nome: 'Gustavo', curso: vars.curso_interesse_original });
    expect(r.trocas.abertura).toBe(1);
    expect(r.prompt).toContain(TITULO_SECAO_GANCHO);
  });
});

describe('conjunto do prompt', () => {
  it('luna lê a cópia dela; produção lê os arquivos de sempre', () => {
    expect(blocosDoPrompt('luna').validacao).toBe(LUNA_AGENTE_VALIDACAO);
    expect(blocosDoPrompt('luna').memoriaHumana).toBe(LUNA_MEMORIA_HUMANA);
    expect(blocosDoPrompt('producao').validacao).toBe(AGENTE_VALIDACAO);
    expect(blocosDoPrompt('producao').qualificador).toBe(AGENTE_QUALIFICADOR);
  });
});
