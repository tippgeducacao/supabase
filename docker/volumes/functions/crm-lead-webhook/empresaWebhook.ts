// Criação Automática de EMPRESAS (29/10/2026) — régua pura do passo (9a) do webhook.
// A gravação mora nas RPCs crm_webhook_empresa_vincular / crm_webhook_empresa_oportunidade
// (migration 20261029190000); aqui só se monta a chamada e se traduz o erro em resposta.

/** Colunas de crm_empresas que a aba aceita. `nome` localiza; o resto só preenche vazio. */
export const CAMPOS_EMPRESA = [
  "nome", "dominio", "email", "telefone", "cidade", "estado", "setor", "tipo", "linkedin", "num_funcionarios",
] as const;
export type CampoEmpresa = (typeof CAMPOS_EMPRESA)[number];

const SUPORTADOS = new Set<string>(CAMPOS_EMPRESA);

export interface DadosDaEmpresa {
  nome: string | null;
  campos: Record<string, string>;
}

/** Resolve os tokens da aba. Campo desconhecido ou vazio não vai para o banco. */
export function dadosDaEmpresa(
  campos: unknown,
  resolver: (valor: string) => string,
): DadosDaEmpresa {
  const saida: DadosDaEmpresa = { nome: null, campos: {} };
  if (!Array.isArray(campos)) return saida;
  for (const c of campos) {
    const campo = typeof c?.campo === "string" ? c.campo : "";
    if (!SUPORTADOS.has(campo)) continue;
    const valor = resolver(String(c?.valor ?? "")).trim();
    if (!valor) continue;
    if (campo === "nome") saida.nome ??= valor;
    else saida.campos[campo] ??= valor;
  }
  return saida;
}

/** Dono da empresa nova / do card que o próprio webhook abrir. Só usuário fixo: rodízio
 *  para empresa gastaria a vez de alguém mesmo quando a empresa já tem dono. */
export function responsavelDaEmpresa(resp: unknown): string | null {
  const r = resp as { estrategia?: unknown; usuarioId?: unknown } | null | undefined;
  return r?.estrategia === "usuario" && typeof r.usuarioId === "string" && /^[0-9a-f-]{36}$/i.test(r.usuarioId)
    ? r.usuarioId : null;
}

export type CodigoEmpresa =
  | "EMPRESA_NAO_INFORMADA" | "EMPRESA_AMBIGUA" | "EMPRESA_DIVERGENTE" | "EMPRESA_ARQUIVADA" | "NOME_EMPRESA_INVALIDO"
  | "FUNIL_EMPRESA_INVALIDO" | "EMPRESA_INDISPONIVEL";

const CONHECIDOS: CodigoEmpresa[] = [
  "EMPRESA_NAO_INFORMADA", "EMPRESA_AMBIGUA", "EMPRESA_DIVERGENTE", "EMPRESA_ARQUIVADA", "NOME_EMPRESA_INVALIDO",
  "FUNIL_EMPRESA_INVALIDO",
];

export function codigoErroEmpresa(mensagem: unknown): CodigoEmpresa {
  const texto = String(mensagem ?? "");
  return CONHECIDOS.find((c) => texto.includes(c)) ?? "EMPRESA_INDISPONIVEL";
}

/** Resposta quando a empresa é obrigatória (há ação de card de empresa) e não foi
 *  resolvida. Nunca 2xx: o formulário não pode mostrar "inscrito" com o B2B pela metade.
 *  4xx = o reenvio igual não resolve (falta dado / precisa de revisão do time);
 *  503 = falha passageira, o retry conclui (as RPCs são idempotentes).
 *  A mensagem é a mesma para qualquer conflito: os ids do banco (homônimas, empresa já
 *  vinculada) ficam só no log, nunca na resposta ao formulário. */
export function falhaDaEmpresa(codigo: CodigoEmpresa): { status: number; erro: string } {
  switch (codigo) {
    case "EMPRESA_NAO_INFORMADA":
      return { status: 422, erro: "Informe sua empresa no cadastro inicial antes de confirmar." };
    case "NOME_EMPRESA_INVALIDO":
      return { status: 422, erro: "O nome da empresa é inválido. Confira e envie de novo." };
    case "EMPRESA_AMBIGUA":
    case "EMPRESA_DIVERGENTE":
    case "EMPRESA_ARQUIVADA":
      return { status: 409, erro: "Recebemos seus dados, mas a empresa precisa de conferência da nossa equipe." };
    case "FUNIL_EMPRESA_INVALIDO":
      return { status: 500, erro: "Integração configurada com um funil que não é de empresas." };
    default:
      return { status: 503, erro: "Não foi possível concluir o cadastro da empresa. Tente novamente." };
  }
}
