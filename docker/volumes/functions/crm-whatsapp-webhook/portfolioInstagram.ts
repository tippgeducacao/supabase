// Instagram → WhatsApp (25/09/2026): quem pediu o portfólio no direct do Instagram
// recebeu no WhatsApp o RECIBO (template UTILIDADE, pelo ig-agente). A 1ª resposta dela
// aqui abre a janela de 24 h — é a hora de mandar o PDF, como mensagem comum, sem template.
//
// Chamado pelo index.ts depois de gravar o inbound e ANTES do repasse ao agente:
//   1. reivindica a pendência (RPC ig_portfolio_reivindicar — atômica: uma resposta, um PDF);
//   2. grava a nota [INSTAGRAM] na memória do agente, datada 1 s antes da mensagem da
//      pessoa (a nota fica entre o recibo e a resposta; se ficasse depois, o histórico
//      terminaria num turno do assistente);
//   2b. garante o cadastro do agente (cliente_ppg_leads_sdr): sem ele, o número (persona
//      qualificador) sai calado com skip 'sem_iniciar_atendimento' — o lead recebia o PDF e
//      mais nada (caso Jucileia, 27/09/2026: "Como funciona isso", "Olá", "Boa noite" sem
//      resposta). O lead do Instagram nasce no CRM (ig_whatsapp_capturar), não no SDR;
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

/** "5594991964725@s.whatsapp.net" → com e sem o 9º dígito (o cadastro pode estar em qualquer um). */
export function jidsDoLead(remotejid: string): string[] {
  const dig = String(remotejid ?? "").split("@")[0].replace(/\D/g, "");
  const m = dig.match(/^(55\d{2})(9?)(\d{8})$/);
  if (!m) return [`${dig}@s.whatsapp.net`];
  return [...new Set([`${m[1]}9${m[3]}`, `${m[1]}${m[3]}`])].map((n) => `${n}@s.whatsapp.net`);
}

/**
 * Cadastro do agente para quem veio do Instagram (28/09/2026). Nasce como o do anúncio
 * (`criarLead` do crm-agente-sdr: iniciar_atendimento e follow-up pelos defaults), com o
 * nome do lead e a fonte. Best-effort: nunca derruba o inbound.
 */
// deno-lint-ignore no-explicit-any
export async function garantirLeadDoAgente(admin: any, remotejid: string, pend: Pendencia): Promise<void> {
  try {
    const { data: existe } = await admin.from("cliente_ppg_leads_sdr").select("id")
      .in("remotejid", jidsDoLead(remotejid)).limit(1);
    if (Array.isArray(existe) && existe.length) return;
    let nome: string | null = null;
    if (pend.lead_id) {
      const { data: lead } = await admin.from("leads").select("nome").eq("id", pend.lead_id).maybeSingle();
      nome = String(lead?.nome ?? "").trim() || null;
    }
    const { error } = await admin.from("cliente_ppg_leads_sdr").upsert(
      { remotejid, timestamp: new Date().toISOString(), nome, fonte: "Instagram" },
      { onConflict: "remotejid", ignoreDuplicates: true },
    );
    if (error) console.error("[crm-whatsapp-webhook] portfólio do Instagram: cadastro do agente falhou:", error.message);
  } catch (err) {
    console.error("[crm-whatsapp-webhook] portfólio do Instagram: cadastro do agente falhou:", err instanceof Error ? err.message : String(err));
  }
}

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
  await garantirLeadDoAgente(admin, e.remotejid, pend);

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
