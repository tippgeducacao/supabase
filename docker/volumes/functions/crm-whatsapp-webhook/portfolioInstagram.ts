// Instagram → WhatsApp (25/09/2026): quem pediu o portfólio no direct do Instagram
// recebeu no WhatsApp o RECIBO (template UTILIDADE, pelo ig-agente). A 1ª resposta dela
// aqui abre a janela de 24 h — é a hora de mandar o PDF, como mensagem comum, sem template.
//
// Chamado pelo index.ts depois de gravar o inbound e ANTES do repasse ao agente:
//   1. reivindica a pendência (RPC ig_portfolio_reivindicar — atômica: uma resposta, um PDF);
//   2. grava a nota [INSTAGRAM] na memória do agente, datada 1 s antes da mensagem da
//      pessoa (a nota fica entre o recibo e a resposta; se ficasse depois, o histórico
//      terminaria num turno do assistente);
//   3. devolve o ENVIO do PDF para o chamador rodar em segundo plano — o webhook não pode
//      segurar a Meta, e o 1º upload do PDF (26 MB) leva alguns segundos.
// Envio que falha devolve a pendência: a próxima mensagem da pessoa tenta de novo.
// Mapa: docs/Instagram (IA + Chat).md
import {
  IG_PORTFOLIO_ARQUIVO,
  IG_PORTFOLIO_LEGENDA,
  IG_PORTFOLIO_URL,
  IG_WA_ACCOUNT_ID,
  notaParaOAgente,
} from "../_shared/igWhatsapp.ts";

export type Pendencia = {
  conta_id: string;
  igsid: string;
  lead_id: string | null;
  oportunidade_id: string | null;
  situacao: string | null;
  data_formacao: string | null;
};

export type ResultadoEnvio = { ok: boolean; erro?: string | null };

type Entrada = {
  accountId: string;
  telefone: string;
  remotejid: string;
  /** Relógio da Meta da mensagem da pessoa (segundos). */
  timestampSeg: number;
  leadId: string | null;
  oportunidadeId: string | null;
  enviar: (corpo: Record<string, unknown>) => Promise<ResultadoEnvio>;
};

// deno-lint-ignore no-explicit-any
export async function prepararPortfolioInstagram(admin: any, e: Entrada): Promise<Promise<void> | null> {
  if (e.accountId !== IG_WA_ACCOUNT_ID) return null;

  const { data, error } = await admin.rpc("ig_portfolio_reivindicar", {
    p_wa_account_id: e.accountId,
    p_telefone: e.telefone,
  });
  if (error) {
    console.error("[crm-whatsapp-webhook] portfólio do Instagram: reivindicar falhou:", error.message);
    return null;
  }
  const pend = (Array.isArray(data) ? data[0] : data) as Pendencia | undefined;
  if (!pend?.igsid) return null;

  const antes = new Date((e.timestampSeg - 1) * 1000).toISOString();
  const { error: erroNota } = await admin.from("cliente_ppg_mensagens_sdr").insert({
    remotejid: e.remotejid,
    conversation_history: { role: "assistant", content: notaParaOAgente(pend.situacao, pend.data_formacao) },
    timestamp: antes,
  });
  if (erroNota) console.error("[crm-whatsapp-webhook] portfólio do Instagram: nota do agente falhou:", erroNota.message);

  return (async () => {
    let resultado: ResultadoEnvio;
    try {
      resultado = await e.enviar({
        wa_account_id: e.accountId,
        telefone: e.telefone,
        tipo: "document",
        anexo_url: IG_PORTFOLIO_URL,
        filename: IG_PORTFOLIO_ARQUIVO,
        mime_type: "application/pdf",
        conteudo: IG_PORTFOLIO_LEGENDA,
        lead_id: pend.lead_id ?? e.leadId ?? undefined,
        oportunidade_id: pend.oportunidade_id ?? e.oportunidadeId ?? undefined,
      });
    } catch (err) {
      resultado = { ok: false, erro: err instanceof Error ? err.message : String(err) };
    }
    if (resultado.ok) {
      console.log(`[crm-whatsapp-webhook] portfólio do Instagram enviado para ${e.telefone} (igsid ${pend.igsid})`);
      return;
    }
    console.error(`[crm-whatsapp-webhook] portfólio do Instagram NÃO saiu para ${e.telefone}: ${resultado.erro ?? "?"} — pendência devolvida`);
    const { error: erroVolta } = await admin.from("ig_conversa_ia")
      .update({ portfolio_enviado_em: null, updated_at: new Date().toISOString() })
      .eq("conta_id", pend.conta_id).eq("igsid", pend.igsid);
    if (erroVolta) console.error("[crm-whatsapp-webhook] portfólio do Instagram: devolver pendência falhou:", erroVolta.message);
  })();
}
