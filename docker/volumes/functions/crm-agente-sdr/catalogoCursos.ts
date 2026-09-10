// 10/09/2026: regra comercial confirmada pelo responsável pelo SDR. O campo
// cursos.modalidade significa tipo de curso, NÃO online/semipresencial. O portal
// comercial também contém divergências; não usá-lo para inferir essa modalidade.
const SEMIPRESENCIAIS = new Set([
  '482013e3-7634-4b7d-8e5e-73416548ca5c', // Clínica Médica e Cirúrgica de Bovinos
  'd391cef0-f4d6-4b1d-a32d-2238427fbe9c', // Reprodução, Nutrição e Gestão de Bovinos (3em1)
]);
const ONLINE = new Set([
  '227d8c6a-148d-4ba3-99d3-0d30ad938ee3', 'e575e65e-37f0-434a-b663-ad7c05d1be03',
  '8bbe57e5-7073-4dd8-a0f8-f7cba9bd5393', 'ea551859-893f-4751-835f-4dfea42b9f8f',
  'a9e3be40-5558-439b-ae33-0db0f8c8a22f', '92076b98-53df-4bfd-bfa0-469c1b735128',
  'ebe24d54-52b0-4fce-a30b-128dc820b676', '5aedb8e2-2869-468d-a3fe-7732616c9380',
  'bcc716b5-6e56-49ba-bbcd-16d3bb5ae3e0', '4278c3b1-b8c6-4f63-8e95-94b00f2fb02d',
  '0b99aad4-8322-4c88-bd64-e249820bbe2d', '1f4a4297-b805-4c50-97a5-cf67905da29e',
  '1ab710b6-aa2b-4cad-811a-2fba794fe7f8', '91474e03-2ef0-4ada-8b2f-2a279c445a38',
  '09f26b62-0dd9-4234-a09d-0bb9da20f21a', '3dfea82f-d1e1-4c6a-bcbb-5ed39d9042e8',
  '686a0105-5ce2-4811-98dc-cb50dd172f03',
]);

type Curso = { id: string; nome: string };
export interface ConsultaCatalogo {
  select(campos: string): ConsultaCatalogo;
  eq(campo: string, valor: string | boolean): ConsultaCatalogo;
  order(campo: string): PromiseLike<{ data: Curso[] | null; error: unknown }>;
}
export interface BancoCatalogo {
  from(tabela: string): ConsultaCatalogo;
  rpc(nome: string, parametros: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}
export function dadosDoCurso(curso: Curso) {
  return {
    id: curso.id,
    nome_oficial: curso.nome,
    nome: curso.nome.replace(/^p[oó]s\s*\|\s*/i, '').replace(/^mba\s*\|\s*/i, 'MBA ').trim(),
    modalidades: SEMIPRESENCIAIS.has(curso.id) ? ['online', 'semipresencial']
      : ONLINE.has(curso.id) ? ['online'] : [],
    modalidade_confirmada: SEMIPRESENCIAIS.has(curso.id) || ONLINE.has(curso.id),
  };
}

const normalizar = (nome: string) => nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/^(pos|mba)\s*\|\s*/, '').replace(/\bcirurgia\b/g, 'cirurgica')
  .replace(/\s+/g, ' ').trim();

function catalogoIndisponivel() {
  return {
    status: 'catalogo_indisponivel', consulta_realizada_com_sucesso: false,
    existencia_confirmada: false, modalidade_confirmada: false,
    instrucao: 'A consulta FALHOU e não confirmou NEM a existência NEM a modalidade da pós. Não diga "temos", "vi que tem", "confirmei", nem que apenas a modalidade está pendente. Não confunda falha com curso inexistente. Não prometa matrícula ou agenda e não invente uma causa específica para a falha. Não há retorno automático agendado: não diga "já te retorno", "me dá um instante", "vou te chamar" ou prometa verificar depois sem uma ação efetivamente providenciada. Resposta sugerida: "Não consegui confirmar essas informações agora. Prefiro verificar antes de te passar algo incorreto."',
  };
}

// Somente leitura. Nenhuma similaridade autoriza adotar outra área como interesse.
// O resolver legado chega a devolver Bovinos para "clínica ... pequenos animais".
export async function consultarCatalogo(supabase: BancoCatalogo, alvo = '') {
  try {
    return await consultarCatalogoInterno(supabase, alvo);
  } catch {
    // Exceção de transporte também não pode virar "siga a conversa normalmente"
    // no catch geral de executarTool, que deixaria o modelo preencher a lacuna.
    return catalogoIndisponivel();
  }
}

async function consultarCatalogoInterno(supabase: BancoCatalogo, alvo: string) {
  const { data, error } = await supabase.from('cursos').select('id,nome')
    .eq('ativo', true).eq('modalidade', 'Pós-Graduação').order('nome');
  if (error || !data?.length) return catalogoIndisponivel();
  const cursos = (data as Curso[]).map(dadosDoCurso);
  // Uma alternativa deve respeitar o foco explicitamente informado, não apenas
  // palavras semelhantes no título (clínica de pequenos ≠ clínica de bovinos).
  const focoCompanhia = /\b(pequenos|companhia|caes|gatos)\b/.test(normalizar(alvo));
  const alternativas = focoCompanhia ? cursos.filter(c => /companhia/.test(normalizar(c.nome))) : cursos;
  const orientarAlternativas = focoCompanhia
    ? ' O foco informado é pequenos animais: não sugira Bovinos ou outras espécies como substitutos. Se apresentar Comportamento e Bem-estar de Animais de Companhia e Silvestres, explique que é outra área, não uma pós clínica/cirúrgica; pergunte se há interesse sem presumir.'
    : ' Sugira apenas alternativas pertinentes à área explicitamente informada pelo lead; se faltar essa informação, pergunte o foco antes de sugerir.';
  const limites = 'Use apenas os cursos ativos retornados. Modalidades são específicas de cada curso; lista vazia significa não confirmada. Não invente frequência, cidade, encontros, carga horária, disciplinas ou obrigatoriedade presencial. Responda à dúvida primeiro; depois retome somente a qualificação ou o agendamento pendente. Não use prefixos PÓS | / MBA | na conversa.';
  if (!alvo.trim()) return { status: 'catalogo_disponivel', cursos, instrucao: limites };
  const exato = cursos.find(c => c.id === alvo || normalizar(c.nome_oficial) === normalizar(alvo) || normalizar(c.nome) === normalizar(alvo));
  let curso = exato;
  if (!curso) {
    const { data: dados, error: erro } = await supabase.rpc('fn_sdr_api_resolver_pos_graduacao', { p_valor: alvo });
    const resolvido = dados as { id?: unknown; via?: unknown } | null;
    if (erro) return catalogoIndisponivel();
    const candidato = cursos.find(c => c.id === resolvido?.id);
    if (resolvido?.via === 'fuzzy' && candidato) return {
      status: 'curso_nao_confirmado', consulta: alvo, alternativas_disponiveis: alternativas,
      possivel_correspondencia: focoCompanhia ? undefined : candidato.nome,
      instrucao: (focoCompanhia
        ? 'O nome pedido NÃO está confirmado no catálogo: a busca retornou apenas semelhança textual de outra espécie/área. Não adote o resultado aproximado, não confirme que oferecemos a pós pedida e não ofereça matrícula/agenda para ela. Explique que não temos essa pós com esse nome no catálogo atual. Se houver outra pós pertinente, apresente-a como alternativa distinta e aguarde a escolha explícita do lead antes de trocar o interesse.'
        : 'Há apenas semelhança textual, que não comprova qual pós o lead quer. Não adote a correspondência automaticamente nem diga que a pós não existe só por diferença na escrita. Pergunte se ele se refere ao nome oficial em possivel_correspondencia. Aguarde a confirmação e consulte novamente com esse nome antes de registrar o interesse ou seguir para materiais/agenda.') + orientarAlternativas,
    };
    curso = candidato;
  }
  if (!curso) return {
    status: 'curso_nao_encontrado', consulta: alvo, alternativas_disponiveis: alternativas,
    instrucao: 'Não temos essa pós no catálogo ativo. Diga isso claramente, sem fingir que a oferecemos. Não prometa matrícula/agenda para ela. Só sugira alternativas existentes pertinentes à área do lead, como cursos diferentes; aguarde escolha explícita antes de trocar o interesse.' + orientarAlternativas,
  };
  return { status: 'curso_confirmado', curso, instrucao: limites };
}
