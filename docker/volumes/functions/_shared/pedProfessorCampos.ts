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
