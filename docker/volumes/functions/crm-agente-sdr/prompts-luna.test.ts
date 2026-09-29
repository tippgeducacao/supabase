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
import { comGanchoDoLote, secaoGanchoLote } from './ganchoLote';
import { MARCADOR_MENSAGEM_LEAD_PAUSA } from './memoriaHumana';
import { SCRIPT_ANTES_DO_CRONOGRAMA, SCRIPT_PERGUNTA_POS } from './fichaAtendimento';
import { NOME_TOOL_RESPOSTA } from './canalResposta';

const vars = { nome: 'Gustavo', curso_interesse_original: 'MBA GESTÃO DA PECUÁRIA LEITERA', pergunta_formacao: 'qual é a sua graduação?' };
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
    expect(LUNA_FICHA).toContain(SCRIPT_PERGUNTA_POS);
  });

  it('canal de resposta cita a ferramenta que o código exige', () => {
    expect(LUNA_CANAL_RESPOSTA).toContain(NOME_TOOL_RESPOSTA);
  });

  it('gancho do lote (ganchoLote.ts) ainda acha a abertura e troca TODA menção à secretaria', () => {
    const r = comGanchoDoLote(renderPrompt(LUNA_AGENTE_VALIDACAO, vars), { nome: 'Gustavo', curso: vars.curso_interesse_original });
    expect(r.trocas.abertura, 'o gancho procura o passo 1 "Abra pela condição" da abertura; cortou? ajuste RE_PASSO_ABERTURA em ganchoLote.ts').toBe(1);
    expect(ocorrencias(r.prompt, /secretaria/gi)).toBe(naSecao(/secretaria/gi));
    const f = comGanchoDoLote(renderPrompt(LUNA_AGENTE_QUALIFICADOR, vars), { nome: 'Gustavo', curso: vars.curso_interesse_original });
    expect(ocorrencias(f.prompt, /secretaria/gi)).toBe(naSecao(/secretaria/gi));
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
