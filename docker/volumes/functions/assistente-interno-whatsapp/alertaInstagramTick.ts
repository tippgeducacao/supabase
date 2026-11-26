// Tick do alerta de Instagram sem acesso (roda junto do alerta de IA: cron
// `assistente-alerta-ia-tick`, a cada 2 min, `?cron=alerta_ia`). A régua mora em
// alertaInstagram.ts; aqui só banco e envio. Mesmo canal e mesmos destinatários do alerta de IA
// (ia_alerta_destinatarios, pela linha própria do assistente).
import { enviarATodos } from "./alertaIaTick.ts";
import {
  REPETIR_TOKEN_H, decidirAcaoToken, textoAlertaToken, textoVoltouToken,
  type ContaToken, type NumerosApagao,
} from "./alertaInstagram.ts";

/** Respostas recusadas pela Meta com 190 desde que o token morreu (para o texto do aviso). */
async function numerosDoApagao(admin: any, c: ContaToken): Promise<NumerosApagao | null> {
  if (!c.token_falhando_desde) return null;
  const { data, error } = await admin.from("ig_mensagens")
    .select("contato_igsid")
    .eq("conta_id", c.id).eq("status_entrega", "failed").eq("erro->>code", "190")
    .gte("created_at", c.token_falhando_desde)
    .limit(5000);
  if (error) return null;
  const linhas = (data ?? []) as { contato_igsid: string | null }[];
  return { respostas: linhas.length, pessoas: new Set(linhas.map((l) => l.contato_igsid)).size };
}

export async function processarAlertaInstagram(admin: any): Promise<Record<string, unknown>> {
  const agora = Date.now();
  const agoraIso = new Date(agora).toISOString();
  const { data, error } = await admin.from("ig_contas")
    .select("id, username, agente_ia_ativo, token_status, token_erro, token_falhando_desde, token_alerta_em, token_expira_em")
    .eq("ativo", true);
  if (error) throw new Error(`ig_contas: ${error.message}`);

  const acoes: Record<string, string> = {};
  const erros: string[] = [];
  for (const c of (data ?? []) as ContaToken[]) {
    const acao = decidirAcaoToken(c, agora);
    if (acao === "nada") continue;
    acoes[c.username] = acao;

    if (acao === "limpar") {
      await admin.from("ig_contas").update({ token_falhando_desde: null })
        .eq("id", c.id).eq("token_status", "ok").is("token_alerta_em", null);
      continue;
    }

    if (acao === "alertar" || acao === "lembrar") {
      // Trava: só quem vira o token_alerta_em manda (dois ticks juntos não duplicam).
      const limite = new Date(agora - REPETIR_TOKEN_H * 3_600_000).toISOString();
      const { data: pego } = await admin.from("ig_contas")
        .update({ token_alerta_em: agoraIso })
        .eq("id", c.id)
        .or(`token_alerta_em.is.null,token_alerta_em.lt."${limite}"`)
        .select("id");
      if (!pego?.length) { acoes[c.username] = "travado"; continue; }
      const n = await numerosDoApagao(admin, c);
      const enviados = await enviarATodos(admin, textoAlertaToken(c, n, acao === "lembrar", agoraIso), erros);
      if (!enviados) {
        // Ninguém recebeu: devolve a trava para o próximo tick tentar de novo.
        await admin.from("ig_contas").update({ token_alerta_em: c.token_alerta_em }).eq("id", c.id);
        acoes[c.username] = `${acao}_falhou`;
      } else {
        acoes[c.username] = `${acao}:${enviados}`;
      }
      continue;
    }

    // voltou: zera o estado ANTES de mandar (dois ticks juntos não mandam dois "voltou").
    const { data: pego } = await admin.from("ig_contas")
      .update({ token_alerta_em: null, token_falhando_desde: null })
      .eq("id", c.id).eq("token_status", "ok").not("token_alerta_em", "is", null)
      .select("id");
    if (!pego?.length) continue;
    const n = await numerosDoApagao(admin, c);
    // "Voltou" é cortesia: se falhar o envio, não se repete (o acesso já está de pé).
    const enviados = await enviarATodos(admin, textoVoltouToken(c, n, agoraIso), erros);
    acoes[c.username] = `voltou:${enviados}`;
  }

  return { acoes, ...(erros.length ? { erros } : {}) };
}
