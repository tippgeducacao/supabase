// Leitura das linhas da consulta "DOCUMENTOS DOS ALUNOS" da EDUQ (05/11/2026).
// Puro (sem Deno/rede) para o vitest congelar. Ver docs/EDUQ — API Oficial.md › "Documentos dos alunos".
//
// A consulta ainda NÃO existe: foi pedida à EDUQ com nomes de coluna sugeridos (id_aluno, cpf,
// tipo_documento, situacao, data_entrega...). Como a EDUQ costuma entregar nomes parecidos mas não
// idênticos (a Id 2 veio em PascalCase, a 10 também), a leitura aceita apelidos e ignora caixa,
// acento e separador. A linha crua vai inteira para `bruto` — nada se perde se um nome não bater.

export type GrupoSituacao = 'pendente' | 'entregue' | 'aprovado' | 'recusado' | 'outro';

export interface DocumentoEduq {
  chave: string;
  cpf: string;
  eduq_aluno_id: string | null;
  eduq_matricula_id: string | null;
  nome_aluno: string | null;
  curso: string | null;
  turma: string | null;
  tipo_documento: string;
  obrigatorio: boolean | null;
  situacao: string | null;
  situacao_grupo: GrupoSituacao;
  data_entrega: string | null;
  data_validacao: string | null;
  observacao: string | null;
  arquivo_ref: string | null;
  bruto: Record<string, unknown>;
}

/** "Tipo_Documento", "tipo documento", "TipoDocumento" → "tipodocumento". */
const normChave = (k: string) => k.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

const APELIDOS: Record<string, string[]> = {
  cpf: ['cpf', 'cpfaluno', 'alunocpf', 'documentocpf'],
  aluno: ['idaluno', 'alunoid', 'codigoaluno'],
  matricula: ['idmatricula', 'matriculaid', 'matricula', 'codigomatricula'],
  nome: ['nomealuno', 'aluno', 'nome', 'nomecompleto'],
  curso: ['curso', 'nomecurso', 'cursoead'],
  turma: ['turma', 'turmamontada', 'nometurma'],
  tipo: ['tipodocumento', 'documento', 'nomedocumento', 'tipo', 'descricaodocumento'],
  obrigatorio: ['obrigatorio', 'documentoobrigatorio', 'exigido'],
  situacao: ['situacao', 'situacaodocumento', 'status', 'statusdocumento'],
  entrega: ['dataentrega', 'dataenvio', 'dataupload', 'datarecebimento'],
  validacao: ['datavalidacao', 'dataaprovacao', 'dataconferencia', 'dataanalise'],
  observacao: ['observacao', 'obs', 'motivorecusa', 'motivo'],
  arquivo: ['linkarquivo', 'urlarquivo', 'linkdownload', 'urldownload', 'arquivourl', 'url', 'link', 'idarquivo', 'arquivoid', 'arquivo'],
};

function pegar(linha: Record<string, unknown>, campo: keyof typeof APELIDOS): unknown {
  const porChave = new Map(Object.entries(linha).map(([k, v]) => [normChave(k), v]));
  for (const apelido of APELIDOS[campo]) {
    if (porChave.has(apelido)) return porChave.get(apelido);
  }
  return undefined;
}

const txt = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};

/** "2026-10-01T00:00:00" ou "01/10/2026" → "2026-10-01". */
export function dataIso(v: unknown): string | null {
  const s = txt(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export function cpfDigitos(v: unknown): string | null {
  const d = (txt(v) ?? '').replace(/\D/g, '');
  return d.length === 11 ? d : null;
}

function booleano(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  const s = (txt(v) ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (['1', 's', 'sim', 'true', 'obrigatorio', 'yes'].includes(s)) return true;
  if (['0', 'n', 'nao', 'false', 'opcional', 'no'].includes(s)) return false;
  return null;
}

/** Situação crua da EDUQ → grupo que o sistema entende. Recusa vence aprovação na mesma frase. */
export function grupoSituacao(situacao: string | null, dataEntrega: string | null): GrupoSituacao {
  const s = (situacao ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/recus|reprov|indefer|rejeit|invalid|nao (aprov|valid|aceit|defer)/.test(s)) return 'recusado';
  if (/nao (enviad|entreg|recebid)|pendent|aguardando envio|faltando|ausente/.test(s)) return 'pendente';
  if (/aprov|valid|defer|conferid|homolog|aceit/.test(s)) return 'aprovado';
  if (/entreg|enviad|recebid|anexad|em analise|aguardando (analise|validacao|conferencia)/.test(s)) return 'entregue';
  if (!s) return dataEntrega ? 'entregue' : 'pendente';
  return 'outro';
}

/** Linha da EDUQ → linha de `eduq_aluno_documentos`. Sem CPF válido ou sem tipo, descarta (null). */
export function paraDocumento(linha: Record<string, unknown>): DocumentoEduq | null {
  const cpf = cpfDigitos(pegar(linha, 'cpf'));
  const tipo = txt(pegar(linha, 'tipo'));
  if (!cpf || !tipo) return null;
  const matricula = txt(pegar(linha, 'matricula'));
  const situacao = txt(pegar(linha, 'situacao'));
  const entrega = dataIso(pegar(linha, 'entrega'));
  return {
    // Um documento por pessoa × matrícula × tipo. Documento é da pessoa, mas a EDUQ guarda por
    // matrícula: o mesmo RG pode vir duas vezes para quem fez duas pós.
    chave: `${cpf}|${matricula ?? ''}|${normChave(tipo)}`,
    cpf,
    eduq_aluno_id: txt(pegar(linha, 'aluno')),
    eduq_matricula_id: matricula,
    nome_aluno: txt(pegar(linha, 'nome')),
    curso: txt(pegar(linha, 'curso')),
    turma: txt(pegar(linha, 'turma')),
    tipo_documento: tipo,
    obrigatorio: booleano(pegar(linha, 'obrigatorio')),
    situacao,
    situacao_grupo: grupoSituacao(situacao, entrega),
    data_entrega: entrega,
    data_validacao: dataIso(pegar(linha, 'validacao')),
    observacao: txt(pegar(linha, 'observacao')),
    arquivo_ref: txt(pegar(linha, 'arquivo')),
    bruto: linha,
  };
}

/** Mesma chave duas vezes na resposta: fica a última (a EDUQ ordena por atualização). */
export function semRepetir(docs: DocumentoEduq[]): DocumentoEduq[] {
  return [...new Map(docs.map((d) => [d.chave, d])).values()];
}

/** O envelope da EDUQ: `resultado` vem como lista (Id 11) ou como STRING com JSON dentro (Id 5). */
export function linhasDoEnvelope(j: { sucesso?: boolean; resultado?: unknown }): Record<string, unknown>[] {
  if (j.sucesso === false) throw new Error(`EDUQ sucesso=false: ${String(j.resultado).slice(0, 300)}`);
  let r: unknown = j.resultado;
  if (typeof r === 'string') {
    try { r = JSON.parse(r); } catch { throw new Error('resultado veio string e não é JSON'); }
  }
  return Array.isArray(r) ? (r as Record<string, unknown>[]) : [];
}
