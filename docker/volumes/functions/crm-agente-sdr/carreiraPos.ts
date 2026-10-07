// Bloco CARREIRA (01/10/2026, agentes SDR V2 — ideia do Wellinton). O conhecimento da pós vem da tabela
// sdr_carreira_pos (pós × perfil de atuação → pergunta de dor, ponte do convite, moeda) e
// sdr_carreira_pos_objecoes, e chega à IA como DADO, no contexto. O prompt não muda por pós.
// Enquanto o perfil do lead não vem do formulário nem de um classificador, vão TODAS as linhas da pós,
// cada uma com os sinais do perfil, e a IA escolhe a que combina com o que o lead disse.

type Banco = { from: (t: string) => any };

/** Pergunta de indagação (06/10/2026): confirma o que o lead faz hoje e deixa a lacuna aparecer sozinha. */
export type PerguntaIndagacao = { pergunta: string; lacuna?: string; se_sim?: string; se_nao?: string };
export type LinhaCarreira = {
  perfil: string; moeda: string | null; pergunta_dor: string | null; ponte_convite: string | null; observacao: string | null;
  // Perfil próprio da pós (06/10/2026). Linha antiga (perfil genérico) vem sem nome e sem perguntas.
  nome?: string | null; sinais?: string[] | null; perguntas?: PerguntaIndagacao[] | null; base?: string | null; ordem?: number | null;
};
export type ObjecaoCarreira = { objecao: string; resposta: string };

/** Como reconhecer cada perfil na fala do lead (vale para todas as pós). */
export const SINAIS_DO_PERFIL: Record<string, string> = {
  clinica_propria: 'tem negócio próprio: clínica, consultório, granja ou fazenda; atende por conta, autônomo',
  plantonista: 'faz plantão',
  contratado: 'trabalha numa clínica, hospital, integradora, cooperativa ou fazenda como funcionário',
  industria_rt: 'frigorífico, laticínio, indústria, RT, controle de qualidade',
  setor_publico: 'prefeitura, vigilância, servidor, concurso',
  quer_entrar: 'formado que ainda não atua com o tema da pós, mesmo trabalhando numa área próxima dele: fora da veterinária (ex.: uber, comércio) ou em outra frente dela (indústria, RT, setor público)',
  ja_atua_no_tema: 'disse que já faz o que a pós ensina (em Cannabis: já prescreve cannabis). trabalhar numa área próxima (dor, oncologia, paliativos) não conta',
  estudante: 'ainda está na graduação',
  outra_area: 'formação fora das aceitas pela pós',
};

/** Vínculo de trabalho do lead (cliente_ppg_leads_sdr.vinculo_trabalho), em todas as pós. */
export const VINCULOS_TRABALHO: Record<string, string> = {
  clt: 'CLT, carteira assinada',
  autonomo: 'autônomo, atende ou trabalha por conta',
  consultor: 'consultor, presta consultoria',
  proprietario: 'dono do próprio negócio: clínica, consultório, granja, fazenda, empresa',
  servidor_publico: 'servidor público',
  sem_trabalho: 'não trabalha no momento',
};

/** Perfis próprios da pós (com nome), na ordem da tabela. Vazio = a pós ainda usa os genéricos. */
export function perfisProprios(linhas: LinhaCarreira[] | null | undefined): LinhaCarreira[] {
  return (linhas ?? []).filter((l) => l.nome?.trim()).sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0));
}

const PERFIS_FORA_DO_PUBLICO = ['estudante', 'outra_area'];

/**
 * A ferramenta busca_carreira da pós da aula. Com perfis próprios, a IA escolhe entre ELES (nome e
 * falas típicas de cada um); sem eles, entre os 9 genéricos. estudante e outra_area valem sempre.
 */
export function toolBuscaCarreira(linhas: LinhaCarreira[] | null | undefined) {
  const proprios = perfisProprios(linhas);
  const opcoes: [string, string][] = proprios.length
    ? [
      ...proprios.map((l): [string, string] => [l.perfil,
        `${l.nome}${l.sinais?.length ? ` (fala como: ${l.sinais.map((x) => `"${x}"`).join(', ')})` : ''}`]),
      ...PERFIS_FORA_DO_PUBLICO.map((p): [string, string] => [p, SINAIS_DO_PERFIL[p]]),
    ]
    : Object.entries(SINAIS_DO_PERFIL);
  return {
    name: 'busca_carreira',
    description: 'Busca, para a pós da aula e o perfil do lead, as perguntas de indagação (da mais leve à mais funda), '
      + 'a ponte do convite e as objeções. Chame assim que souber a atuação e a formação dele. É interna: o lead não vê.',
    input_schema: {
      type: 'object',
      properties: {
        perfil: {
          type: 'string', enum: opcoes.map(([p]) => p),
          description: 'O perfil que mais combina com o que ele disse; as falas são exemplos, não precisam bater palavra por palavra. '
            + (proprios.length ? 'Se nenhum combinar, o mais próximo de quem quer entrar no tema. ' : 'Quem já faz o que a pós ensina é ja_atua_no_tema, mesmo tendo clínica ou emprego. ')
            + opcoes.map(([p, s]) => `${p}: ${s}`).join('; ') + '.',
        },
      },
      required: ['perfil'],
      additionalProperties: false,
    },
  };
}

/**
 * A linha do perfil escolhido. Perfil sem linha nesta pós (ex.: RT de frigorífico em Cannabis): os públicos
 * são os do Ebook, e quem está fora deles é, para esta pós, quem ainda não atua no tema (base quer_entrar;
 * perfil próprio antes do genérico). estudante e outra_area não caem no fallback.
 */
export function linhaDoPerfil(linhas: LinhaCarreira[] | null | undefined, perfil: string): LinhaCarreira | null {
  const todas = linhas ?? [];
  const exata = todas.find((l) => l.perfil === perfil);
  if (exata) return exata;
  if (PERFIS_FORA_DO_PUBLICO.includes(perfil)) return null;
  return perfisProprios(todas).find((l) => l.base === 'quer_entrar')
    ?? todas.find((l) => l.perfil === 'quer_entrar') ?? null;
}

/** As perguntas da linha: as de indagação, ou a pergunta de dor antiga como uma só. */
export function perguntasDaLinha(l: LinhaCarreira): PerguntaIndagacao[] {
  const lista = Array.isArray(l.perguntas) ? l.perguntas.filter((q) => q?.pergunta?.trim()) : [];
  return lista.length ? lista : l.pergunta_dor ? [{ pergunta: l.pergunta_dor }] : [];
}

// ===== Mapa de carreira do Wellinton (07/10/2026) =====
// Pós com grupo em sdr_carreira_mapa_pos trocam os perfis técnicos pelo mapa: o ramo sai do vínculo do lead
// e as perguntas são de CARREIRA (plano de carreira, valoriza quem estuda, quanto cobra), texto literal.

export type RamoMapa = {
  ramo: string; nome: string; vinculos: string[] | null; sinais: string[] | null;
  argumento: string | null; ponte_convite: string | null; ordem: number | null;
};
export type PerguntaMapa = { ramo: string; etapa: 'divide' | 'carreira' | 'ganho' | 'prioridade'; texto: string; ordem: number | null };
export type MapaCarreira = { grupo: string; ramos: RamoMapa[]; perguntas: PerguntaMapa[] };

/** Vínculo ainda não dito: a busca devolve a pergunta do mapa que divide o caminho. */
export const RAMO_INDEFINIDO = 'indefinido';
/** Teto de perguntas de carreira antes do convite (decisão do Gustavo, 07/10/2026). */
export const MAX_PERGUNTAS_CARREIRA = 2;

export async function carregarMapaPorNome(banco: Banco, cursoNome: string | null | undefined): Promise<MapaCarreira | null> {
  if (!cursoNome?.trim()) return null;
  try {
    const { data: curso } = await banco.from('cursos').select('id').eq('nome', cursoNome.trim()).limit(1);
    const cursoId = curso?.[0]?.id;
    if (!cursoId) return null;
    const { data: g } = await banco.from('sdr_carreira_mapa_pos').select('grupo').eq('curso_id', cursoId).limit(1);
    const grupo = g?.[0]?.grupo;
    if (!grupo) return null;
    const [r, p] = await Promise.all([
      banco.from('sdr_carreira_mapa_ramo').select('ramo, nome, vinculos, sinais, argumento, ponte_convite, ordem')
        .eq('grupo', grupo).eq('ativo', true).order('ordem'),
      banco.from('sdr_carreira_mapa_pergunta').select('ramo, etapa, texto, ordem').eq('grupo', grupo).eq('ativo', true).order('ordem'),
    ]);
    if (r.error || p.error) throw new Error((r.error ?? p.error).message);
    if (!r.data?.length) return null;
    return { grupo: String(grupo), ramos: r.data as RamoMapa[], perguntas: (p.data ?? []) as PerguntaMapa[] };
  } catch (e) {
    console.error('[crm-agente-sdr] mapa de carreira (segue nos perfis antigos):', (e as Error)?.message ?? e);
    return null;
  }
}

/** A busca_carreira de uma pós com mapa: o parâmetro segue "perfil" (o n8n repassa input.perfil), o valor é o ramo. */
export function toolBuscaCarreiraMapa(mapa: MapaCarreira) {
  const opcoes: [string, string][] = [
    ...mapa.ramos.map((r): [string, string] => [r.ramo,
      `${r.nome}${r.sinais?.length ? ` (fala como: ${r.sinais.map((x) => `"${x}"`).join(', ')})` : ''}`]),
    [RAMO_INDEFINIDO, 'ele ainda não disse se é autônomo, contratado, servidor ou dono do negócio'],
    ...PERFIS_FORA_DO_PUBLICO.map((p): [string, string] => [p, SINAIS_DO_PERFIL[p]]),
  ];
  return {
    name: 'busca_carreira',
    description: 'Busca, para a pós da aula e o jeito como o lead trabalha hoje, as perguntas de CARREIRA do mapa comercial '
      + `(até ${MAX_PERGUNTAS_CARREIRA} antes do convite), a ponte do convite e as objeções. Chame assim que souber como ele trabalha. `
      + 'É interna: o lead não vê.',
    input_schema: {
      type: 'object',
      properties: {
        perfil: {
          type: 'string', enum: opcoes.map(([p]) => p),
          description: 'Como ele trabalha hoje; as falas são exemplos, não precisam bater palavra por palavra. '
            + opcoes.map(([p, s]) => `${p}: ${s}`).join('; ') + '.',
        },
      },
      required: ['perfil'],
      additionalProperties: false,
    },
  };
}

/**
 * A pergunta do vínculo no contexto, desde a 1ª mensagem (07/10/2026): sem ela a IA improvisava
 * ("por conta, como contratado ou tem negócio próprio?", com duas opções iguais). '' sem mapa.
 */
export function notaPerguntaQueDivide(mapa: MapaCarreira | null): string {
  const p = mapa?.perguntas.find((x) => x.etapa === 'divide')?.texto;
  if (!p) return '';
  return `\n\nPERGUNTA DO VÍNCULO (mapa comercial desta pós): quando precisar saber como ele trabalha, pergunte assim, `
    + `sem trocar as opções: "${p}"`;
}

/** O que a busca_carreira devolve numa pós com mapa. null = estudante/outra_area (o prompt tem desvio próprio). */
export function respostaDoMapa(mapa: MapaCarreira, ramo: string) {
  if (PERFIS_FORA_DO_PUBLICO.includes(ramo)) return null;
  const divide = mapa.perguntas.filter((p) => p.etapa === 'divide').map((p) => p.texto);
  const r = mapa.ramos.find((x) => x.ramo === ramo);
  if (!r) {
    return {
      ramo: RAMO_INDEFINIDO,
      pergunta_que_divide: divide[0] ?? null,
      como_usar: 'Ele ainda não disse como trabalha. Faça esta pergunta do jeito que veio e, com a resposta, '
        + 'registre o vínculo e chame a busca_carreira de novo com o ramo dele.',
    };
  }
  const perguntas = mapa.perguntas
    .filter((p) => p.etapa !== 'divide' && (p.ramo === r.ramo || p.ramo === '*'))
    .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
    .map((p) => ({ etapa: p.etapa, pergunta: p.texto }));
  return {
    ramo: r.ramo, quem_e: r.nome, perguntas, ponte_convite: r.ponte_convite, argumento: r.argumento,
    como_usar: `Perguntas de carreira, não técnicas. Faça no máximo ${MAX_PERGUNTAS_CARREIRA}, uma por mensagem, na ordem, `
      + 'do jeito que vieram, pulando a que ele já respondeu. Depois, o convite com a ponte. O argumento é interno: guia a conversa, não vai escrito.',
  };
}

/** A aula traz o NOME da pós (cursos.nome); o id sai daqui. */
export async function carregarCarreiraPorNome(banco: Banco, cursoNome: string | null | undefined) {
  if (!cursoNome?.trim()) return null;
  try {
    const { data, error } = await banco.from('cursos').select('id').eq('nome', cursoNome.trim()).limit(1);
    if (error || !data?.[0]?.id) return null;
    return await carregarCarreira(banco, String(data[0].id));
  } catch { return null; }
}

export async function carregarCarreira(banco: Banco, cursoId: string): Promise<{ linhas: LinhaCarreira[]; objecoes: ObjecaoCarreira[] } | null> {
  try {
    const [l, o] = await Promise.all([
      banco.from('sdr_carreira_pos').select('perfil, moeda, pergunta_dor, ponte_convite, observacao, nome, sinais, perguntas, base, ordem').eq('curso_id', cursoId).eq('ativo', true),
      banco.from('sdr_carreira_pos_objecoes').select('objecao, resposta').eq('curso_id', cursoId).eq('ativo', true).order('ordem'),
    ]);
    if (l.error || o.error) throw new Error((l.error ?? o.error).message);
    if (!l.data?.length) return null;
    return { linhas: l.data as LinhaCarreira[], objecoes: (o.data ?? []) as ObjecaoCarreira[] };
  } catch (e) {
    console.error('[crm-agente-sdr] carreira da pós (segue sem o bloco):', (e as Error)?.message ?? e);
    return null;
  }
}

/** O bloco que a IA lê. '' sem dados (a conversa segue sem ele). */
export function blocoCarreira(c: { linhas: LinhaCarreira[]; objecoes: ObjecaoCarreira[] } | null, nomePos: string): string {
  if (!c?.linhas.length) return '';
  const linhas = c.linhas.map((l) => {
    const partes = [`- ${l.perfil} (${l.nome ?? SINAIS_DO_PERFIL[l.perfil] ?? l.perfil})`];
    if (l.pergunta_dor) partes.push(`PERGUNTA DE DOR: "${l.pergunta_dor}"`);
    if (l.ponte_convite) partes.push(`PONTE: ${l.ponte_convite}`);
    if (l.observacao) partes.push(l.observacao);
    return partes.join(' · ');
  });
  const objecoes = c.objecoes.map((o) => `- "${o.objecao}": ${o.resposta}`);
  return `\n\nCARREIRA — ${nomePos} (dados; escolha o perfil que combina com o que ele disse)\n${linhas.join('\n')}`
    + (objecoes.length ? `\nOBJEÇÕES DESTA PÓS:\n${objecoes.join('\n')}` : '');
}

/**
 * Objeção de tempo tem dois sentidos (03/10/2026): para a REUNIÃO (logo depois do convite, ou quando ele
 * fala da conversa) ou para a PÓS (estudar, aulas, rotina). Fala do lead sobre estudar decide primeiro;
 * senão, convite na última fala do agente indica a reunião.
 */
export function sobreDaObjecaoDeTempo(falaDoLead: string, ultimaFalaDoAgente: string): 'conversa' | 'pos' {
  // Palavra inteira (com acento): "gostaria" não pode casar com "aula".
  const tem = (texto: string, palavras: string) =>
    new RegExp(`(^|[^a-zà-ú])(${palavras})([^a-zà-ú]|$)`).test(String(texto ?? '').toLowerCase());
  if (tem(falaDoLead, 'estudar|aula|aulas|curso|cursar|pós|pos|rotina|faculdade|módulo|modulo')) return 'pos';
  if (tem(falaDoLead, 'reunião|reuniao|meet|conversa|monitor')) return 'conversa';
  return tem(ultimaFalaDoAgente, 'meet|conversa|monitor|horário|horario|horários|horarios') ? 'conversa' : 'pos';
}

/**
 * A objeção da pós para o tipo que a consulta_objecoes classificou (Ebook do Wellinton). `sobre` escolhe
 * entre conversa e pós (linha sem `sobre` vale para os dois). null = a pós não tem resposta (a base geral
 * responde) ou a leitura falhou (idem: a conversa não para).
 */
export async function objecaoDaPos(banco: Banco, cursoNome: string | null | undefined, tipo: string | null | undefined,
  sobre: 'conversa' | 'pos' | null = null): Promise<ObjecaoCarreira | null> {
  if (!cursoNome?.trim() || !tipo?.trim()) return null;
  try {
    const { data: curso } = await banco.from('cursos').select('id').eq('nome', cursoNome.trim()).limit(1);
    const cursoId = curso?.[0]?.id;
    if (!cursoId) return null;
    const { data, error } = await banco.from('sdr_carreira_pos_objecoes').select('objecao, resposta, sobre')
      .eq('curso_id', cursoId).eq('tipo_objecao', tipo.trim()).eq('ativo', true).order('ordem').limit(10);
    if (error || !data?.length) return null;
    const linha = data.find((l: any) => sobre && l.sobre === sobre) ?? data.find((l: any) => !l.sobre) ?? (sobre ? null : data[0]);
    return linha ? { objecao: String(linha.objecao), resposta: String(linha.resposta) } : null;
  } catch { return null; }
}
