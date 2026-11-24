// Régua PURA da apresentação de venda gerada pelo Pedagógico (24/11/2026).
// Usada pela edge `ped-apresentacao-gerar`; sem import do Deno, para o vitest testar.
//
// A IA escreve UM bloco por chamada (o deck tem 7: as 4 etapas do SPIN, habilidades, técnicas e
// frases). Um bloco por vez cabe com folga no tempo da edge (o Cloudflare corta a resposta perto de
// 100 s) e deixa o Pedagógico gerar de novo só o que não gostou.
// O formato dos `dados` de cada bloco é espelhado em src/lib/pedagogico/apresentacaoVenda.ts.

export const BLOCOS = [
  "spin_situacao",
  "spin_problema",
  "spin_implicacao",
  "spin_necessidade",
  "habilidades",
  "tecnicas",
  "frases",
] as const;
export type Bloco = (typeof BLOCOS)[number];

export function ehBloco(x: unknown): x is Bloco {
  return typeof x === "string" && (BLOCOS as readonly string[]).includes(x);
}

export const PERGUNTAS_POR_GRUPO = 10;
export const MAX_GRUPOS_SPIN = 4;
export const QTD_HABILIDADES = 5;
export const MAX_FRASES = 50;
export const MIN_FRASES = 12;
export const MAX_LACUNAS = 10;
/** Material curto demais = a IA teria de inventar. Nada é gerado. */
export const MIN_MATERIAL_CHARS = 600;

// ───────────────────────────── material (o que o Pedagógico já tem) ─────────────────────────────

export interface PosMaterial {
  nome: string;
  nome_comercial: string | null;
  marca: string | null;
  instituicao: string | null;
  formato: string | null;
  carga_horaria: number | null;
  periodo_total_meses: number | null;
  tcc: string | null;
  produto_tipo: string | null;
}
export interface LinhaGrade {
  modulo_numero: number | null;
  modulo_nome: string | null;
  tipo_modulo: string | null;
  aula_titulo: string | null;
  titulo: string | null;
  ementa: string | null;
}
export interface AulaExtra {
  titulo: string | null;
  ementa: string | null;
}
export interface ProfessorMaterial {
  nome: string;
  titulacao: string | null;
  area_expertise: string | null;
  especialidades: string[] | null;
  mini_bio: string | null;
  coordenador: boolean;
}

const MAX_MATERIAL_CHARS = 120_000;

function limpa(s: unknown, max = 600): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Texto único com tudo que o sistema sabe da pós. Só fatos cadastrados: é a única fonte da IA. */
export function montarMaterial(
  pos: PosMaterial,
  grade: LinhaGrade[],
  extras: AulaExtra[],
  professores: ProfessorMaterial[],
  ficha: Record<string, unknown> | null,
): string {
  const partes: string[] = [];
  // «PÓS | NOME» é o rótulo interno do catálogo; a IA copiava o prefixo para as frases (24/11/2026).
  const nome = limpa(pos.nome_comercial || pos.nome, 300).replace(/^(?:p[óo]s|mba|curso)\s*\|\s*/i, "");
  const ficha1 = [
    `# Pós-graduação: ${nome}`,
    pos.nome_comercial && pos.nome_comercial !== pos.nome ? `Nome interno: ${limpa(pos.nome, 300)}` : "",
    pos.marca ? `Marca: ${limpa(pos.marca, 80)}` : "",
    pos.instituicao ? `Instituição certificadora: ${limpa(pos.instituicao, 200)}` : "",
    pos.produto_tipo ? `Tipo de produto: ${limpa(pos.produto_tipo, 80)}` : "",
    pos.formato ? `Formato: ${limpa(pos.formato, 80)}` : "",
    pos.carga_horaria ? `Carga horária: ${pos.carga_horaria} h` : "",
    pos.periodo_total_meses ? `Duração: ${pos.periodo_total_meses} meses` : "",
    pos.tcc ? `TCC: ${limpa(pos.tcc, 200)}` : "",
  ].filter(Boolean);
  partes.push(ficha1.join("\n"));

  // Grade: módulo → aulas (com ementa). Partes da mesma aula viram uma linha só.
  const porModulo = new Map<string, { titulo: string; aulas: Map<string, string[]> }>();
  for (const g of grade) {
    const chaveMod = `${g.modulo_numero ?? "?"}`;
    const tituloMod = `Módulo ${g.modulo_numero ?? "?"}${g.modulo_nome ? `: ${limpa(g.modulo_nome, 200)}` : ""}${
      g.tipo_modulo ? ` (${limpa(g.tipo_modulo, 40)})` : ""
    }`;
    if (!porModulo.has(chaveMod)) porModulo.set(chaveMod, { titulo: tituloMod, aulas: new Map() });
    const mod = porModulo.get(chaveMod)!;
    const aula = limpa(g.aula_titulo || g.titulo, 250);
    if (!aula || /pr[eé]-?abertura/i.test(aula)) continue;
    if (!mod.aulas.has(aula)) mod.aulas.set(aula, []);
    const ementa = limpa(g.ementa, 500);
    const parte = limpa(g.titulo, 250);
    const lista = mod.aulas.get(aula)!;
    if (parte && parte !== aula && !lista.includes(parte)) lista.push(parte);
    if (ementa && !lista.includes(ementa)) lista.push(ementa);
  }
  if (porModulo.size) {
    const linhas: string[] = [];
    for (const mod of porModulo.values()) {
      linhas.push(`### ${mod.titulo}`);
      for (const [aula, det] of mod.aulas) linhas.push(`- ${aula}${det.length ? `: ${det.join(" | ")}` : ""}`);
    }
    partes.push(`## Grade cadastrada no Pedagógico\n${linhas.join("\n")}`);
  }

  const ex = extras.map((e) => limpa(e.titulo, 250) + (e.ementa ? `: ${limpa(e.ementa, 400)}` : "")).filter(Boolean);
  if (ex.length) partes.push(`## Aulas ao vivo extras\n${ex.map((l) => `- ${l}`).join("\n")}`);

  const ps = professores
    .filter((p) => p.nome)
    .map((p) => {
      const det = [
        p.coordenador ? "coordenador(a)" : "",
        p.titulacao ? limpa(p.titulacao, 120) : "",
        p.area_expertise ? limpa(p.area_expertise, 160) : "",
        p.especialidades?.length ? p.especialidades.map((e) => limpa(e, 60)).join(", ") : "",
      ].filter(Boolean).join("; ");
      const bio = limpa(p.mini_bio, 500);
      return `- ${limpa(p.nome, 120)}${det ? ` (${det})` : ""}${bio ? `: ${bio}` : ""}`;
    });
  if (ps.length) partes.push(`## Professores da pós\n${ps.join("\n")}`);

  if (ficha && Object.keys(ficha).length) {
    partes.push(`## Ficha de venda já cadastrada (Materiais de Venda)\n${JSON.stringify(ficha, null, 1)}`);
  }
  return partes.join("\n\n").slice(0, MAX_MATERIAL_CHARS);
}

// ───────────────────────────── pedido para a IA ─────────────────────────────

export const SISTEMA =
  "Você escreve o material de apoio dos VENDEDORES (SDRs e closers) de uma empresa de pós-graduação " +
  "para médicos-veterinários, zootecnistas, agrônomos e profissionais do agro. O vendedor usa esse " +
  "material numa reunião de vendas consultiva por vídeo, com um lead que demonstrou interesse na pós.\n\n" +
  "Regras que valem para todo bloco:\n" +
  "- Português do Brasil, frases curtas e naturais, como um vendedor falaria.\n" +
  "- Use SÓ fatos que estão no MATERIAL. Nunca invente número, preço, data, duração, carga horária, " +
  "nome de professor, título, instituição, regra de gravação, certificação ou benefício.\n" +
  "- Quando um bloco ficaria melhor com uma informação que o MATERIAL não traz, NÃO a escreva: registre " +
  "em 'lacunas' uma frase curta dizendo o que falta (ex.: 'A grade não diz quais módulos são ao vivo').\n" +
  "- Dores do público são HIPÓTESES a confirmar com o lead, nunca afirmações sobre ele.\n" +
  "- Sem promessa de promoção, emprego, aumento de salário, retorno financeiro ou resultado garantido.\n" +
  "- Não cite preço, data, professor pelo nome nem regra de gravação: isso muda e mora em outros blocos.\n" +
  "- Nunca use travessão (— ou –). Use vírgula, dois-pontos ou ponto.\n" +
  "- Use o nome da marca que está no MATERIAL (ex.: PPGVET ou PPG Educação); não troque 'MBA' por 'pós' " +
  "nem o contrário: copie como está.\n" +
  "- Nada de emoji, markdown ou numeração dentro dos textos.";

const ETAPAS_SPIN: Record<string, { titulo: string; foco: string }> = {
  spin_situacao: {
    titulo: "Situação",
    foco:
      "Perguntas de SITUAÇÃO: descobrir onde o lead atua, a rotina, a função, a formação, com quem " +
      "trabalha e em que momento de carreira está. Só perguntar, sem vender e sem concluir nada. " +
      "Perguntas curtas e fáceis de responder.",
  },
  spin_problema: {
    titulo: "Problema",
    foco:
      "Perguntas de PROBLEMA: fazer o lead falar das dificuldades e lacunas que a pós trabalha " +
      "(tiradas dos módulos e das aulas do MATERIAL). Cada pergunta testa uma hipótese de dor, sem afirmar " +
      "que ele tem o problema.",
  },
  spin_implicacao: {
    titulo: "Implicação",
    foco:
      "Perguntas de IMPLICAÇÃO: fazer o lead perceber o custo de NÃO resolver os problemas (no trabalho, " +
      "na carreira, na equipe, no resultado do cliente ou da produção), sem exagero e sem números inventados.",
  },
  spin_necessidade: {
    titulo: "Necessidade",
    foco:
      "Perguntas de NECESSIDADE DE SOLUÇÃO: fazer o lead dizer, com as palavras dele, o valor de dominar " +
      "o que a pós ensina e como usaria isso. Ligue cada grupo a temas reais da grade.",
  },
};

export function pedidoDoBloco(bloco: Bloco, material: string, posNome: string): string {
  const cab = `MATERIAL da pós "${posNome}" (única fonte de fatos):\n\n${material}\n\n---\n\n`;
  if (bloco.startsWith("spin_")) {
    const e = ETAPAS_SPIN[bloco];
    return (
      cab +
      `Escreva a etapa ${e.titulo} do roteiro SPIN desta pós.\n${e.foco}\n\n` +
      `- 'descricao': 1 ou 2 frases dizendo ao vendedor o que ele busca nesta etapa, para esta pós.\n` +
      `- 'grupos': de 2 a ${MAX_GRUPOS_SPIN} grupos. Cada grupo tem um 'contexto' curto (quando usar o grupo; ` +
      `ex.: 'Se trabalha em fazenda', 'Equipe e liderança') e exatamente ${PERGUNTAS_POR_GRUPO} perguntas ` +
      `diferentes entre si. O vendedor vê 2 perguntas sorteadas por grupo, então cada uma precisa funcionar sozinha.\n` +
      `- 'lacunas': o que faltou no MATERIAL para escrever melhor esta etapa (pode ficar vazio).`
    );
  }
  if (bloco === "habilidades") {
    return (
      cab +
      `Escreva as ${QTD_HABILIDADES} principais habilidades que o aluno desenvolve nesta pós, em ordem de ` +
      `importância (a 1ª é a mais forte). Cada uma com até 10 palavras, começando por verbo ou substantivo de ` +
      `ação (ex.: 'Conduzir equipes no campo com segurança'). Tiradas da grade, nada de fora.\n` +
      `- 'itens': as ${QTD_HABILIDADES} habilidades.\n- 'lacunas': o que faltou (pode ficar vazio).`
    );
  }
  if (bloco === "tecnicas") {
    return (
      cab +
      `Escreva o bloco de CONTEÚDO que o vendedor mostra ao lead: os temas, técnicas ou ferramentas da pós ` +
      `agrupados por área.\n` +
      `- 'eyebrow': rótulo pequeno acima do título (até 4 palavras, ex.: 'Conteúdo da pós').\n` +
      `- 'titulo': complemento que vem depois de um número grande (o deck mostra a contagem dos itens); ` +
      `ex.: 'temas trabalhados na prática', 'técnicas abordadas'.\n` +
      `- 'nota': 1 frase de apoio (pode ficar vazia).\n` +
      `- 'categorias': de 3 a 8 áreas, cada uma com 'nome' curto e de 3 a 8 'itens' curtos (até 6 palavras), ` +
      `todos tirados da grade.\n- 'lacunas': o que faltou (pode ficar vazio).`
    );
  }
  return (
    cab +
    `Escreva de ${MIN_FRASES + 18} a ${MAX_FRASES} FRASES ESSENCIAIS: frases curtas (até 30 palavras) que o vendedor ` +
    `lê antes da reunião para não esquecer de falar. Cubra: posicionamento da pós, para quem é (perfis e momentos ` +
    `de carreira que o MATERIAL indica), os temas fortes da grade, o formato, a ligação com o dia a dia do lead e ` +
    `as respostas às dúvidas mais prováveis. Cada frase diz uma coisa só, sem repetir outra.\n` +
    `- 'itens': as frases.\n- 'lacunas': o que faltou (pode ficar vazio).`
  );
}

const LACUNAS = { type: "array", items: { type: "string" } };

export function schemaDoBloco(bloco: Bloco): Record<string, unknown> {
  if (bloco.startsWith("spin_")) {
    return {
      type: "object",
      properties: {
        descricao: { type: "string" },
        grupos: {
          type: "array",
          items: {
            type: "object",
            properties: { contexto: { type: "string" }, perguntas: { type: "array", items: { type: "string" } } },
            required: ["contexto", "perguntas"],
            additionalProperties: false,
          },
        },
        lacunas: LACUNAS,
      },
      required: ["descricao", "grupos", "lacunas"],
      additionalProperties: false,
    };
  }
  if (bloco === "tecnicas") {
    return {
      type: "object",
      properties: {
        eyebrow: { type: "string" },
        titulo: { type: "string" },
        nota: { type: "string" },
        categorias: {
          type: "array",
          items: {
            type: "object",
            properties: { nome: { type: "string" }, itens: { type: "array", items: { type: "string" } } },
            required: ["nome", "itens"],
            additionalProperties: false,
          },
        },
        lacunas: LACUNAS,
      },
      required: ["eyebrow", "titulo", "nota", "categorias", "lacunas"],
      additionalProperties: false,
    };
  }
  return {
    type: "object",
    properties: { itens: { type: "array", items: { type: "string" } }, lacunas: LACUNAS },
    required: ["itens", "lacunas"],
    additionalProperties: false,
  };
}

// ───────────────────────────── conferência do que voltou ─────────────────────────────

/** Texto limpo: espaços, travessão trocado por vírgula, sem marcador de lista no começo. */
export function textoLimpo(s: unknown, max = 400): string {
  return String(s ?? "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:?!])/g, "$1")
    .replace(/,\s*,/g, ",")
    .trim()
    .slice(0, max);
}

function chave(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Lista limpa, sem vazios e sem repetidas (comparando sem acento/pontuação). */
export function listaLimpa(xs: unknown, max: number, tam = 400): string[] {
  const out: string[] = [];
  const vistas = new Set<string>();
  for (const x of Array.isArray(xs) ? xs : []) {
    const t = textoLimpo(x, tam);
    const k = chave(t);
    if (!k || vistas.has(k)) continue;
    vistas.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export interface BlocoNormalizado {
  dados: Record<string, unknown>;
  lacunas: string[];
}

/** Confere e limpa a resposta da IA. Lança erro com mensagem para a tela quando não dá para usar. */
export function normalizarBloco(bloco: Bloco, bruto: unknown): BlocoNormalizado {
  const r = (bruto && typeof bruto === "object" ? bruto : {}) as Record<string, unknown>;
  const lacunas = listaLimpa(r.lacunas, MAX_LACUNAS, 240);

  if (bloco.startsWith("spin_")) {
    const grupos: { contexto: string; perguntas: string[] }[] = [];
    const vistas = new Set<string>();
    for (const g of Array.isArray(r.grupos) ? r.grupos : []) {
      const gg = (g ?? {}) as Record<string, unknown>;
      // Pergunta repetida em outro grupo também sai (o sorteio mostraria a mesma duas vezes).
      const perguntas = listaLimpa(gg.perguntas, PERGUNTAS_POR_GRUPO, 300).filter((p) => {
        const k = chave(p);
        if (vistas.has(k)) return false;
        vistas.add(k);
        return true;
      });
      if (perguntas.length < 2) continue;
      grupos.push({ contexto: textoLimpo(gg.contexto, 80), perguntas });
      if (grupos.length >= MAX_GRUPOS_SPIN) break;
    }
    if (!grupos.length) throw new Error("A IA não devolveu perguntas utilizáveis para esta etapa.");
    return { dados: { descricao: textoLimpo(r.descricao, 400), grupos }, lacunas };
  }

  if (bloco === "habilidades") {
    const itens = listaLimpa(r.itens, QTD_HABILIDADES, 120);
    if (itens.length < QTD_HABILIDADES) {
      throw new Error(`A IA devolveu ${itens.length} habilidades; o deck precisa de ${QTD_HABILIDADES}.`);
    }
    return { dados: { itens }, lacunas };
  }

  if (bloco === "tecnicas") {
    const categorias: { nome: string; itens: string[] }[] = [];
    for (const c of Array.isArray(r.categorias) ? r.categorias : []) {
      const cc = (c ?? {}) as Record<string, unknown>;
      const nome = textoLimpo(cc.nome, 60);
      const itens = listaLimpa(cc.itens, 12, 80);
      if (nome && itens.length) categorias.push({ nome, itens });
      if (categorias.length >= 10) break;
    }
    if (!categorias.length) throw new Error("A IA não devolveu áreas de conteúdo utilizáveis.");
    return {
      dados: {
        eyebrow: textoLimpo(r.eyebrow, 40) || "Conteúdo da pós",
        titulo: textoLimpo(r.titulo, 80) || "temas abordados",
        nota: textoLimpo(r.nota, 240),
        categorias,
      },
      lacunas,
    };
  }

  const itens = listaLimpa(r.itens, MAX_FRASES, 300);
  if (itens.length < MIN_FRASES) {
    throw new Error(`A IA devolveu só ${itens.length} frases; o mínimo é ${MIN_FRASES}.`);
  }
  return { dados: { itens }, lacunas };
}
