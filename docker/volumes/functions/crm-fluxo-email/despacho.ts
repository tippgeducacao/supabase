/**
 * Um item da fila `crm_fluxo_email_envios` → um envio de modelo de e-mail.
 *
 * A linha da fila É a reserva: o motor do fluxo (`crm_fluxo_exec_acao`, ramo
 * `enviar_email`) a cria com UNIQUE (execução, passagem, ação) — reexecutar o mesmo bloco
 * na mesma passagem não enfileira de novo. Aqui, "reservar" é ASSUMIR a linha
 * (`pendente` → `processando`, atômico): duas rodadas do despachante nunca enviam o mesmo
 * item. Resultado incerto fica em `processando` e não é repetido — mesma régua do webhook.
 *
 * ⚠️ Item recusado ANTES de ser assumido (lead sem e-mail, modelo inativo, variável vazia)
 * precisa sair de `pendente` aqui; senão a próxima rodada o pegaria de novo, para sempre.
 *
 * Desde 02/10/2026 a fila também recebe as automações de FUNIL (CRM V2, `origem='crm_v2'`)
 * e do SAC 2.0 (`origem='sac_v2'`). Elas não têm execução de fluxo: a reserva é a coluna
 * `chave`, gravada pelo motor (`crm_automacao_email_enfileirar`), e o log do fluxo não se
 * aplica — o resultado fica na própria linha e em `emails_enviados`.
 */
import {
  executarEnvioModeloEmail,
  type ContextoEnvioModelo,
  type DependenciasEnvioModelo,
  type ResultadoAcaoEmail,
} from "../crm-lead-webhook/acaoEmail.ts";

export type OrigemFilaEmail = "fluxo" | "crm_v2" | "sac_v2";

export interface ItemFilaEmail {
  id: string;
  /** Ausente nas linhas anteriores a 02/10/2026, que eram todas de fluxo. */
  origem?: OrigemFilaEmail | null;
  /** Só nas linhas de fluxo. */
  fluxo_id: string | null;
  execucao_id: string | null;
  passagem: number;
  no_id: string | null;
  /** Só nas automações (crm_v2/sac_v2): a automação e a reserva única da linha. */
  automacao_id?: string | null;
  chave?: string | null;
  /** `<bloco>:<md5 dos parâmetros>` — um bloco pode ter mais de uma ação de e-mail. */
  acao_ref: string;
  lead_id: string;
  params: unknown;
}

export interface DependenciasFila {
  /** Tudo que o núcleo precisa, exceto reservar/finalizar (que são da fila). */
  nucleo: Omit<DependenciasEnvioModelo, "reservar" | "finalizar">;
  /** `pendente` → `processando`; true só para quem assumiu. */
  assumir(id: string): Promise<boolean>;
  /** Grava o resultado final (só sai de `processando`). */
  concluir(id: string, resultado: ResultadoAcaoEmail): Promise<void>;
  /** Recusa antes de assumir: só sai de `pendente`. */
  descartar(id: string, resultado: ResultadoAcaoEmail): Promise<void>;
  /** Registro no log do fluxo — best-effort. */
  registrarNoFluxo(item: ItemFilaEmail, resultado: ResultadoAcaoEmail): Promise<void>;
}

/**
 * O status que entra em `crm_fluxo_logs` — o vocabulário que a aba de execuções já pinta:
 * "executada" (verde), "erro" (vermelho) e "pulada_<motivo>", o mesmo formato dos pulos
 * de WhatsApp ("pulada_lead_arquivado").
 */
export function statusDoLog(r: ResultadoAcaoEmail): string {
  if (r.status === "enviado") return "executada";
  if (r.status === "erro") return "erro";
  if (r.status === "suprimido") return "pulada_email_suprimido";
  if (r.status === "duplicado") return "pulada_email_duplicado";
  return `pulada_${r.motivo ?? "email_ignorado"}`;
}

/**
 * De onde veio a linha → o que vai para `emails_enviados.contexto_tipo/contexto_id` e o que
 * compõe a chave de idempotência. O fluxo mantém exatamente o contexto de antes (mudar o
 * namespace invalidaria as reservas existentes).
 */
export function contextoDoItem(item: ItemFilaEmail): ContextoEnvioModelo {
  if (item.origem === "crm_v2" || item.origem === "sac_v2") {
    const crm = item.origem === "crm_v2";
    return {
      tipo: crm ? "automacao_crm" : "automacao_sac",
      id: item.automacao_id ?? "",
      namespace: crm ? "crm-v2-email/v1" : "sac-v2-email/v1",
      partesChave: [item.chave ?? item.id],
    };
  }
  return {
    tipo: "fluxo",
    id: item.fluxo_id ?? "",
    namespace: "crm-fluxo-email/v1",
    partesChave: [item.fluxo_id ?? "", item.execucao_id ?? "", String(item.passagem)],
  };
}

export async function processarItemFila(item: ItemFilaEmail, deps: DependenciasFila): Promise<ResultadoAcaoEmail> {
  let assumiu = false;
  const resultado = await executarEnvioModeloEmail({
    contexto: contextoDoItem(item),
    acao: { id: item.acao_ref, params: item.params },
    leadId: item.lead_id,
    // As variáveis já chegam resolvidas pelo motor do fluxo ({primeiro_nome},
    // {campo:alias}…); não existe payload de webhook aqui.
    dados: null,
  }, {
    ...deps.nucleo,
    reservar: async () => {
      assumiu = await deps.assumir(item.id);
      return assumiu;
    },
    finalizar: async (_chave, r) => deps.concluir(item.id, r),
  });

  if (!assumiu) {
    // "duplicado" aqui = outra rodada assumiu primeiro: ela é quem conclui a linha.
    if (resultado.status !== "duplicado") await deps.descartar(item.id, resultado);
  }
  try {
    // Automação de funil/SAC não tem execução de fluxo onde registrar.
    if ((item.origem ?? "fluxo") === "fluxo") await deps.registrarNoFluxo(item, resultado);
  } catch {
    /* o log do fluxo é acessório; a fila já guarda o resultado */
  }
  return resultado;
}
