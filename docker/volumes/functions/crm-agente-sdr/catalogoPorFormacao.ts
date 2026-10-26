// ── Catálogo filtrado pela formação do lead (26/10/2026, caso Jemima) ─────────
// Farmacêutica perguntou "qual pós vcs tem?" e a IA respondeu Cannabis Medicinal Veterinária,
// Fitoterapia Veterinária e Qualidade e Segurança de Alimentos: nenhuma aceita Farmácia (Cannabis é
// só de médico veterinário). consulta_pos_disponiveis devolvia o catálogo cru (nome e modalidade) e
// a IA escolhia pelo som da palavra; a matriz de formação só rodava quando o lead escolhia uma pós.
// Agora a listagem passa pela MESMA IA da matriz (tools.ts, chamarModeloDaMatriz): ela lê a formação
// na conversa e no cadastro e liga os nomes (catálogo × tabela × formação), que escritos à mão nunca
// batem. O código só confere o que a IA não pode inventar: o curso existe no catálogo, a linha existe
// na tabela, pós só de veterinário não vai para quem não é veterinário, e pós sem linha na tabela fica
// de fora (sem regra = não dá para afirmar que aceita).
import type { Msg } from './historico.ts';
import { textoDoLead } from './evidenciaFormacao.ts';
import { type LinhaDaMatriz, aceitaQualquerFormacao, chaveFormacao, linhaDoCurso, soParaVeterinario } from './linhaDaMatriz.ts';

export const LEITURA_FORMACAO_SYSTEM = `Você confere quais pós-graduações do CATÁLOGO aceitam a formação do lead, usando a TABELA de compatibilidade (cursos_pos_graduacao), que é a fonte da verdade.

## 1. Formação do lead
- Leia as falas do lead e o cadastro. O que o lead DISSE na conversa vale mais que o cadastro.
- Normalize variações para o nome usado na tabela: farmacêutica → Farmácia; agrônomo → Engenharia Agronômica; vet, médica veterinária → Medicina Veterinária; zootecnista → Zootecnia; bióloga → Biologia; nutricionista → Nutrição/Nutricionistas; biomédico → Biomedicina/Biomédicos; engenheiro agrícola → Engenheiros Agrícolas; e assim por diante.
- Quem ainda está cursando a graduação conta com a formação do curso que faz.
- Formação vaga ("outra área", "sou formado", "superior completo", "não informado") ou ausente = formacao_identificada null.

## 2. Quais pós aceitam
Para cada pós do CATÁLOGO, ache a linha da TABELA que corresponde a ela (os nomes são escritos diferente: "PÓS | CANNABIS MEDICINAL VETERINÁRIA" é a linha "Cannabis Medicinal"). Inclua a pós só se:
- a formação está em pode_fazer → aceite "inteira";
- a formação está em parcialmente_aceitas → aceite "parcial" (copie a ressalva entre parênteses em condicao, se houver);
- pode_fazer diz que qualquer formação de nível superior pode fazer → aceite "inteira".
NÃO inclua: pós sem linha correspondente na tabela; pós cuja linha não cita a formação; pós só de Medicina Veterinária quando o lead não é médico veterinário. Na dúvida, não inclua.
Se formacao_identificada for null, devolva cursos vazio.

## 3. Resposta
Só JSON, sem markdown:
{"formacao_identificada": "Farmácia" ou null, "e_medico_veterinario": true ou false, "cursos": [{"curso": "<nome EXATO como está no CATÁLOGO>", "linha_da_tabela": "<pos_graduacao EXATO como está na TABELA>", "aceite": "inteira" ou "parcial", "condicao": "<ressalva>" ou null}]}`;

export type CursoAceito = { curso: string; linha_da_tabela: string; aceite: 'inteira' | 'parcial'; condicao: string | null };
export type LeituraDaFormacao = { formacao_identificada: string | null; e_medico_veterinario: boolean; cursos: CursoAceito[] };

/** Falas do lead (as mais recentes) + o cadastro, no texto que a IA lê. Vazio = nada a ler. */
export function evidenciasDaFormacao(historico: readonly Msg[] | undefined, cadastro: { formacao_academica?: unknown; profissao?: unknown } | null): string {
  const falas = (historico ?? []).map(textoDoLead).filter((t): t is string => !!t).slice(-30);
  const doCadastro = [cadastro?.formacao_academica, cadastro?.profissao].map((v) => String(v ?? '').trim()).filter(Boolean);
  if (!falas.length && !doCadastro.length) return '';
  return `CADASTRO: ${doCadastro.join(' · ') || '—'}\n\nFALAS DO LEAD (da mais antiga para a mais recente):\n${falas.map((f) => `- ${f}`).join('\n') || '—'}`;
}

/** JSON da IA → leitura validada. Lança se o formato não for o combinado (quem chama trata como falha). */
export function lerLeituraDaFormacao(texto: string): LeituraDaFormacao {
  const limpo = texto.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const bruto = JSON.parse(limpo);
  if (!bruto || typeof bruto !== 'object') throw new Error('leitura da formação sem objeto');
  const formacao = typeof bruto.formacao_identificada === 'string' && bruto.formacao_identificada.trim()
    ? bruto.formacao_identificada.trim() : null;
  if (typeof bruto.e_medico_veterinario !== 'boolean') throw new Error('e_medico_veterinario deve ser boolean');
  if (!Array.isArray(bruto.cursos)) throw new Error('cursos deve ser lista');
  const cursos = bruto.cursos
    .filter((c: any) => c && typeof c.curso === 'string' && typeof c.linha_da_tabela === 'string'
      && (c.aceite === 'inteira' || c.aceite === 'parcial'))
    .map((c: any) => ({ curso: c.curso, linha_da_tabela: c.linha_da_tabela, aceite: c.aceite,
      condicao: typeof c.condicao === 'string' && c.condicao.trim() ? c.condicao.trim() : null }));
  return { formacao_identificada: formacao, e_medico_veterinario: bruto.e_medico_veterinario, cursos };
}

type CursoDoCatalogo = { nome_oficial: string; nome: string };

/**
 * Cruza a leitura da IA com o catálogo e a tabela. A IA só pode RESTRINGIR: curso fora do catálogo,
 * linha fora da tabela e pós só de veterinário para quem não é veterinário caem aqui, mesmo que ela
 * os tenha incluído. A linha que o código acha pelo nome também conta para a trava do veterinário.
 */
export function filtrarCatalogoPelaFormacao<T extends CursoDoCatalogo>(
  cursos: readonly T[], tabela: readonly LinhaDaMatriz[], leitura: LeituraDaFormacao,
): Array<T & { aceite: 'inteira' | 'parcial'; condicao?: string }> {
  if (!leitura.formacao_identificada) return [];
  const linhaPeloNome = (nome: string) => tabela.find((l) => chaveFormacao(l.pos_graduacao) === chaveFormacao(nome));
  const saida: Array<T & { aceite: 'inteira' | 'parcial'; condicao?: string }> = [];
  for (const curso of cursos) {
    const aceito = leitura.cursos.find((c) => chaveFormacao(c.curso) === chaveFormacao(curso.nome_oficial)
      || chaveFormacao(c.curso) === chaveFormacao(curso.nome));
    if (!aceito) continue;
    const linha = linhaPeloNome(aceito.linha_da_tabela);
    if (!linha) continue;
    const linhaDoCodigo = linhaDoCurso(tabela as LinhaDaMatriz[], curso.nome_oficial);
    const soVet = soParaVeterinario(linha) || (!!linhaDoCodigo && soParaVeterinario(linhaDoCodigo));
    if (soVet && !leitura.e_medico_veterinario) continue;
    const aceite = aceitaQualquerFormacao(linha) ? 'inteira' : aceito.aceite;
    saida.push({ ...curso, aceite, ...(aceite === 'parcial' && aceito.condicao ? { condicao: aceito.condicao } : {}) });
  }
  return saida;
}
