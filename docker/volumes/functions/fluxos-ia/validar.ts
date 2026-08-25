import { z } from 'https://esm.sh/zod@3.23.8';

/**
 * Validação da saída do modelo.
 *
 * O `strict: true` da ferramenta já obriga o formato do lado da API, mas validar aqui
 * de novo não é paranoia: o que sai daqui é gravado no banco e vira PROMPT COLADO NUM
 * AGENTE DE CÓDIGO. Um campo faltando descoberto só na hora de renderizar significa
 * uma análise paga e perdida; descoberto aqui, dá para pedir a correção (uma vez) e
 * salvar a chamada.
 */

export const zDiagnostico = z.object({
  severidade: z.enum(['alta', 'media', 'baixa']),
  nos: z.array(z.string()),
  tipo: z.enum([
    'ramo_sem_saida', 'decisao_incompleta', 'estado_orfao', 'loop_sem_escape',
    'passo_manual_automatizavel', 'sem_sla', 'sem_tratamento_erro',
    'responsavel_ambiguo', 'duplicidade', 'inconsistencia_dados',
  ]),
  problema: z.string().min(1),
  impacto: z.string().min(1),
  recomendacao: z.string().min(1),
});

export const zPergunta = z.object({
  id: z.string().min(1),
  pergunta: z.string().min(1),
  porque_importa: z.string().default(''),
  opcoes_sugeridas: z.array(z.string()).default([]),
});

export const zAnalise = z.object({
  resumo: z.string().min(1),
  diagnosticos: z.array(zDiagnostico).default([]),
  // CORTA em 5, não REJEITA em 5. O limite é regra de produto (ninguém responde uma
  // lista de 12 perguntas) e regra de produto que só existe no prompt é regra que o
  // modelo ignora num dia ruim. Mas derrubar uma análise inteira — já paga — porque
  // veio uma pergunta a mais seria trocar um defeito pequeno por um caro.
  perguntas: z.array(zPergunta).default([]).transform((a) => a.slice(0, 5)),
  fluxo_sugerido_mermaid: z.string().default(''),
  prompt_de_implementacao: z.string().min(1),
  estimativa: z.object({
    complexidade: z.enum(['P', 'M', 'G']),
    riscos: z.array(z.string()).default([]),
  }),
});

export type Analise = z.infer<typeof zAnalise>;

export const zDesenho = z.object({
  mermaid: z.string().min(1),
  resumo: z.string().default(''),
});

/**
 * O Mermaid precisa PARSEAR do outro lado (@excalidraw/mermaid-to-excalidraw) para
 * virar desenho. Não dá para rodar o parser aqui (ele é do front), então checamos o
 * mínimo que pega os erros que o modelo comete: cerca de markdown esquecida em volta
 * e cabeçalho ausente. O parse de verdade acontece no navegador, e lá existe o
 * caminho de "pedir correção uma vez".
 */
export function limparMermaid(bruto: string): string {
  let t = (bruto ?? '').trim();
  t = t.replace(/^```(?:mermaid)?\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!/^\s*(flowchart|graph)\s/i.test(t)) t = `flowchart TD\n${t}`;
  return t;
}

export function mermaidParecePlausivel(t: string): boolean {
  const limpo = limparMermaid(t);
  return /^\s*(flowchart|graph)\s+(TD|TB|LR|RL|BT)/i.test(limpo) && /-->|-\.->|==>/.test(limpo);
}
