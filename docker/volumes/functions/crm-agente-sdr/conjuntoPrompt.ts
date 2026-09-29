// Qual conjunto de textos a IA principal lê: o da produção (Claude, todos os leads) ou o da Luna
// (canário, prompts-luna.ts). 29/09/2026: a Luna ganhou a sua cópia para ser cortada e testada sem
// mudar o João dos outros leads. O PEDIDO é o mesmo, na mesma ordem (agente.ts); só muda a fonte.
import { AGENTE_QUALIFICADOR, AGENTE_VALIDACAO } from './prompts.ts';
import { INSTRUCAO_MEMORIA_HUMANA } from './memoriaHumana.ts';
import { INSTRUCAO_FATOS_DO_LEAD } from './fatosLead.ts';
import { INSTRUCAO_DISPONIBILIDADE_CONTATO } from './disponibilidadeContato.ts';
import { INSTRUCAO_EVENTOS } from './instrucaoEventos.ts';
import { INSTRUCAO_FICHA } from './fichaAtendimento.ts';
import { INSTRUCAO_VOZ } from './vozDoJoao.ts';
import { INSTRUCAO_CANAL_RESPOSTA } from './canalResposta.ts';
import {
  LUNA_AGENTE_QUALIFICADOR, LUNA_AGENTE_VALIDACAO, LUNA_CANAL_RESPOSTA, LUNA_DISPONIBILIDADE, LUNA_EVENTOS,
  LUNA_FATOS_DO_LEAD, LUNA_FICHA, LUNA_MEMORIA_HUMANA, LUNA_VOZ,
} from './prompts-luna.ts';

export type ConjuntoPrompt = 'producao' | 'luna';

export interface BlocosDoPrompt {
  /** Persona de abertura (antes do horário) e de fechamento, já com elegibilidade + materiais no fim. */
  validacao: string;
  qualificador: string;
  memoriaHumana: string;
  fatosDoLead: string;
  disponibilidade: string;
  eventos: string;
  ficha: string;
  voz: string;
  canalResposta: string;
}

const PRODUCAO: BlocosDoPrompt = {
  validacao: AGENTE_VALIDACAO, qualificador: AGENTE_QUALIFICADOR, memoriaHumana: INSTRUCAO_MEMORIA_HUMANA,
  fatosDoLead: INSTRUCAO_FATOS_DO_LEAD, disponibilidade: INSTRUCAO_DISPONIBILIDADE_CONTATO, eventos: INSTRUCAO_EVENTOS,
  ficha: INSTRUCAO_FICHA, voz: INSTRUCAO_VOZ, canalResposta: INSTRUCAO_CANAL_RESPOSTA,
};
const LUNA: BlocosDoPrompt = {
  validacao: LUNA_AGENTE_VALIDACAO, qualificador: LUNA_AGENTE_QUALIFICADOR, memoriaHumana: LUNA_MEMORIA_HUMANA,
  fatosDoLead: LUNA_FATOS_DO_LEAD, disponibilidade: LUNA_DISPONIBILIDADE, eventos: LUNA_EVENTOS,
  ficha: LUNA_FICHA, voz: LUNA_VOZ, canalResposta: LUNA_CANAL_RESPOSTA,
};

export function blocosDoPrompt(conjunto: ConjuntoPrompt): BlocosDoPrompt {
  return conjunto === 'luna' ? LUNA : PRODUCAO;
}
