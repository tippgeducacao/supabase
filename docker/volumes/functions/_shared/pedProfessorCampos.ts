// Resolve campos "professor.*" do variaveis_mapping dos templates pedagógicos
// (ped_wa_templates) a partir da linha de ped_professores — usado pelos
// dispatchers de cadência (dispatch-professor-invite, dispatch-gravacao-convite).
// ⚠️ ESPELHO de src/components/pedagogico-v2/utils/waTemplateCampos.tsx
// (resolverCampoProfessor) — mudou a lista/formatação num, mude no outro.

function primeiroNome(nome: string | null | undefined): string {
  return (nome ?? "").trim().split(/\s+/)[0] ?? "";
}

function formatValor(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2).replace(".", ",") : "";
}

/**
 * DOCUMENTO que o professor precisa nos enviar para receber.
 *
 * ⚠️ SEMPRE "nota fiscal" (decisão da Janaína/Rafael, 2026-08-19). A cobrança
 * MANUAL sempre pediu exclusivamente NF; a automática derivava do campo livre
 * `forma_pagamento` do cadastro e podia dizer "recibo" ou "nota fiscal ou
 * recibo" — oferecendo uma escolha que não existe e contradizendo a cobrança
 * manual no mesmo chat. A palavra "recibo" não pode aparecer.
 *
 * Continua sendo um CAMPO derivado (e não texto fixo no corpo) porque o template
 * aprovado `pos_aula_status_v2_v2` diz "Envie sua {{4}} por aqui" e a Meta recusa
 * o template inteiro quando qualquer {{n}} chega vazio (erro 131008) — é este
 * campo que garante que {{4}} nunca é vazio, qualquer que seja o cadastro.
 * Trocar o corpo para embutir "nota fiscal" exigiria template NOVO aprovado.
 */
export function documentoPagamentoTexto(_formaPagamento?: unknown): string {
  return "nota fiscal";
}

/**
 * Retorna o valor do campo do CADASTRO do professor, ou null quando o campo não
 * é "professor.*" (aí o dispatcher segue no switch de contexto dele).
 */
export function resolverCampoProfessor(campo: string, prof: any): string | null {
  if (!prof || !campo?.startsWith("professor.")) return null;
  switch (campo) {
    case "professor.nome":
      return primeiroNome(prof.nome);
    case "professor.nome_completo":
      return String(prof.nome ?? "");
    case "professor.cargo_atual":
      return String(prof.cargo_atual ?? "");
    case "professor.cpf":
      return String(prof.cpf ?? "");
    case "professor.contato_whatsapp":
      return String(prof.contato_whatsapp ?? "");
    case "professor.email":
      return String(prof.email ?? "");
    case "professor.forma_pagamento":
      return String(prof.forma_pagamento ?? "");
    case "professor.documento_pagamento":
      return documentoPagamentoTexto(prof.forma_pagamento);
    case "professor.chave_pix":
      return String(prof.chave_pix ?? "");
    case "professor.valor_hora_aula_online":
      return formatValor(prof.valor_hora_aula_online);
    case "professor.valor_hora_aula_presencial":
      return formatValor(prof.valor_hora_aula_presencial);
    case "professor.especialidades":
      return Array.isArray(prof.especialidades) ? prof.especialidades.join(", ") : "";
    case "professor.pasta_link":
      return String(prof.pasta_link ?? "");
    default:
      return "";
  }
}
