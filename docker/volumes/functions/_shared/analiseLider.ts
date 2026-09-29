/**
 * Análise por IA dos resultados de UM líder no trimestre — tudo o que é sobre ele:
 * a equipe (Avaliação de Liderança, anônima), os outros líderes e a diretoria (Avaliação
 * entre Líderes) e a autoavaliação da pergunta 3.
 *
 * Puro (sem Deno, sem rede): a edge `avaliacao-lider-analise` monta o pedido com isto, e os
 * testes rodam no vitest. A tela mostra o JSON salvo em `fin_clima_analises_ia_lider`.
 *
 * ⚠️ PRIVACIDADE: a IA não recebe o nome de quem escreveu — só o papel ("líder", "diretoria")
 * — e os textos da equipe vão sem nada que identifique quem respondeu. A pessoa avaliada entra
 * só pelo primeiro nome.
 */
import {
  PERGUNTAS_ENTRE_LIDERES,
  comNome,
  type ContagemDeOpcao,
  type ResumoDoAvaliado,
} from "./avaliacaoEntreLideres.ts";
import type { ResumoDaEquipe } from "./resumoEquipeDoLider.ts";

export interface AnaliseLider {
  resumo: string;
  pontos_fortes: string[];
  pontos_de_atencao: string[];
  /** Onde a visão da pessoa sobre si (pergunta 3) bate ou não com a da equipe e dos pares. */
  como_se_ve_x_como_e_visto: string;
  recomendacoes: string[];
}

/**
 * Formato exigido do modelo (`output_config.format`).
 * ⚠️ `minItems: 1` nas listas: sem ele, 1 em cada 4 análises de teste (28/09/2026) veio com
 * `recomendacoes: []` e um "]}" solto no fim do texto — e era salva assim.
 */
export const ESQUEMA_ANALISE = {
  type: "object",
  properties: {
    resumo: { type: "string" },
    pontos_fortes: { type: "array", items: { type: "string" }, minItems: 1 },
    pontos_de_atencao: { type: "array", items: { type: "string" }, minItems: 1 },
    como_se_ve_x_como_e_visto: { type: "string" },
    recomendacoes: { type: "array", items: { type: "string" }, minItems: 1 },
  },
  required: ["resumo", "pontos_fortes", "pontos_de_atencao", "como_se_ve_x_como_e_visto", "recomendacoes"],
  additionalProperties: false,
} as const;

export const INSTRUCOES_ANALISE = `Você analisa os resultados de avaliação de um líder de uma empresa de educação veterinária (PPGVET), para devolver a ele um retrato honesto e útil de como é visto.

O que você recebe, sempre do mesmo trimestre:
- EQUIPE: o que os liderados responderam, de forma anônima, sobre este líder (médias de 1 a 5 e respostas abertas).
- PARES E DIRETORIA: o que outros líderes e a diretoria responderam sobre ele na Avaliação entre Líderes (notas de 1 a 5, contagem das opções marcadas e os textos, marcados só com o papel de quem escreveu).
- AUTOAVALIAÇÃO: como ele descreve o próprio jeito de liderar.

Como escrever:
- Português do Brasil, direto, respeitoso, sem jargão de RH e sem elogio vazio. Fale com o líder em segunda pessoa ("você").
- Baseie cada afirmação no que está nos dados, com a proporção quando ajudar ("3 de 4 colegas marcaram…", "média 2,50 em…"). Não invente fatos, cenas nem números.
- Nunca tente adivinhar quem escreveu o quê e não cite nomes. Diga "a equipe", "os pares", "a diretoria".
- Isto não é avaliação de desempenho nem diagnóstico psicológico: descreva comportamentos observados e o efeito deles.
- Se a base for pequena (poucas respostas) ou só uma das fontes tiver dados, diga isso no resumo e não generalize além do que os dados sustentam.
- Notas na escala de 1 a 5, com duas casas decimais e vírgula (ex.: 3,50).

O que entregar:
- resumo: um parágrafo de 4 a 6 frases com o retrato geral.
- pontos_fortes: de 2 a 5 itens, cada um com a evidência.
- pontos_de_atencao: de 2 a 5 itens, cada um com a evidência e o efeito que causa.
- como_se_ve_x_como_e_visto: compare a autoavaliação com o que a equipe e os pares dizem; aponte o ponto cego principal, se houver. Sem autoavaliação, diga que ela não foi respondida e comente só o que os outros veem.
- recomendacoes: de 3 a 5 ações concretas para os próximos 90 dias, cada uma ligada a um ponto de atenção.`;

const n2 = (n: number | null) => (n === null ? "sem dado" : n.toFixed(2).replace(".", ","));

function contagens(itens: ContagemDeOpcao[], total: number): string {
  if (itens.length === 0) return "  (nenhuma opção marcada)";
  return itens.map((c) => `  - ${c.opcao}: ${c.vezes} de ${total}`).join("\n");
}

export interface DadosDaAnalise {
  /** Primeiro nome de quem é avaliado. */
  nome: string;
  trimestre: string;
  equipe: ResumoDaEquipe | null;
  entreLideres: ResumoDoAvaliado;
  /** Papel de cada avaliador (id → "lider" | "diretor"), para rotular os textos. */
  papelDoAvaliador: Record<string, string>;
}

/** Texto com os dados do trimestre, no formato que a IA lê. */
export function dadosParaIA(d: DadosDaAnalise): string {
  const linhas: string[] = [`Líder avaliado: ${d.nome} · trimestre ${d.trimestre}`, ""];

  linhas.push("== EQUIPE (Avaliação de Liderança, anônima) ==");
  if (!d.equipe || d.equipe.respostas === 0) {
    linhas.push("Nenhuma resposta da equipe neste trimestre.");
  } else {
    linhas.push(`Respostas: ${d.equipe.respostas}. Média geral: ${n2(d.equipe.mediaGeral)}.`);
    for (const b of d.equipe.blocos) linhas.push(`Bloco "${b.bloco}": média ${n2(b.media)}`);
    for (const p of d.equipe.perguntas) {
      linhas.push(`- ${p.pergunta.texto} → média ${n2(p.media)} (${p.distribuicao.map((x) => `${x.opcao}: ${x.vezes}`).join("; ")})`);
    }
    for (const t of d.equipe.textos) {
      if (t.textos.length === 0) continue;
      linhas.push(`${t.pergunta.texto}`);
      for (const texto of t.textos) linhas.push(`  • "${texto}"`);
    }
  }
  linhas.push("");

  const e = d.entreLideres;
  const papeis = e.avaliadores.map((id) => d.papelDoAvaliador[id] ?? "lider");
  const nLideres = papeis.filter((p) => p === "lider").length;
  const nDiretoria = papeis.filter((p) => p === "diretor").length;
  linhas.push("== PARES E DIRETORIA (Avaliação entre Líderes, identificada) ==");
  if (e.avaliacoes === 0) {
    linhas.push("Nenhuma avaliação de pares ou da diretoria neste trimestre.");
  } else {
    linhas.push(`Avaliações: ${e.avaliacoes} (${nLideres} de líderes, ${nDiretoria} da diretoria). Média geral: ${n2(e.mediaGeral)}.`);
    for (const nota of e.notas) {
      const extra = nota.pergunta.invertida ? " (pergunta invertida — a nota já foi corrigida: alto = pouco resistente)" : "";
      linhas.push(`- ${comNome(nota.pergunta.texto, d.nome)} → média ${n2(nota.media)}${extra}`);
    }
    linhas.push(`Jeito de liderar segundo os colegas (pergunta 3):`);
    linhas.push(contagens(e.estilo.contagem, e.avaliacoes));
    for (const p of PERGUNTAS_ENTRE_LIDERES) {
      if (p.tipo !== "multipla") continue;
      linhas.push(`${comNome(p.texto, d.nome)}`);
      for (const g of p.grupos) {
        if (g.titulo) linhas.push(` ${comNome(g.titulo, d.nome)}`);
        linhas.push(contagens(e.marcacoes[p.id]?.[g.id] ?? [], e.avaliacoes));
      }
    }
    linhas.push("Textos (cada um marcado com o papel de quem escreveu):");
    for (const p of PERGUNTAS_ENTRE_LIDERES) {
      const textos = e.textos[p.id] ?? [];
      if (!p.campoTexto || textos.length === 0) continue;
      linhas.push(`${p.numero}. ${p.campoTexto.rotulo}`);
      for (const t of textos) {
        const papel = d.papelDoAvaliador[t.avaliador_id] === "diretor" ? "diretoria" : "líder";
        linhas.push(`  • (${papel}) "${t.texto}"`);
      }
    }
  }
  linhas.push("");

  linhas.push("== AUTOAVALIAÇÃO (pergunta 3, sobre si mesmo) ==");
  linhas.push(e.estilo.autoavaliacao ? `"${e.estilo.autoavaliacao}"` : "Não respondeu a autoavaliação neste trimestre.");

  return linhas.join("\n");
}

export interface BaseDaAnalise {
  respostas_equipe: number;
  avaliacoes_lideres: number;
  avaliacoes_diretoria: number;
  autoavaliacao: boolean;
}

/**
 * Quantas respostas entram na análise. A edge grava isto junto com a análise; a tela calcula
 * de novo com os dados de agora e, se mudou, avisa que chegaram respostas depois.
 */
export function baseDaAnalise(
  entre: ResumoDoAvaliado,
  papelDoAvaliador: Record<string, string>,
  respostasEquipe: number,
): BaseDaAnalise {
  const papeis = entre.avaliadores.map((id) => papelDoAvaliador[id]);
  return {
    respostas_equipe: respostasEquipe,
    avaliacoes_lideres: papeis.filter((p) => p !== "diretor").length,
    avaliacoes_diretoria: papeis.filter((p) => p === "diretor").length,
    autoavaliacao: !!entre.estilo.autoavaliacao,
  };
}

/** Confere o JSON devolvido pela IA. `null` = fora do formato (não salva). */
export function validarAnalise(bruto: unknown): AnaliseLider | null {
  if (!bruto || typeof bruto !== "object") return null;
  const o = bruto as Record<string, unknown>;
  // Resto de JSON grudado no fim de um texto ("…fechado.]}"), visto num teste de 28/09/2026.
  const limpar = (s: string) => s.replace(/\s*\]\s*\}+\s*$/, "").trim();
  const texto = (v: unknown) => typeof v === "string" && limpar(v).length > 0;
  const lista = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (!texto(o.resumo) || !texto(o.como_se_ve_x_como_e_visto)) return null;
  if (!lista(o.pontos_fortes) || !lista(o.pontos_de_atencao) || !lista(o.recomendacoes)) return null;
  const itens = (v: unknown) => (v as string[]).map(limpar).filter(Boolean);
  const analise: AnaliseLider = {
    resumo: limpar(o.resumo as string),
    pontos_fortes: itens(o.pontos_fortes),
    pontos_de_atencao: itens(o.pontos_de_atencao),
    como_se_ve_x_como_e_visto: limpar(o.como_se_ve_x_como_e_visto as string),
    recomendacoes: itens(o.recomendacoes),
  };
  // Lista vazia é análise incompleta: a edge pede de novo em vez de salvar.
  if (analise.pontos_fortes.length === 0 || analise.pontos_de_atencao.length === 0 || analise.recomendacoes.length === 0) {
    return null;
  }
  return analise;
}
