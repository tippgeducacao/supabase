/**
 * De qual NÚMERO sai a reação (16/10/2026).
 *
 * A Meta só aceita reagir pelo mesmo número que tem a mensagem na conversa. De outro número
 * ela recusa com code 100: "Cannot react to a message if it's more than 30 days old or
 * doesn't correspond to any message in the conversation".
 *
 * O chat (`CrmChatPanel`) manda só telefone + wamid. Sem linha explícita a rota caía no
 * auto-detect, e no número oficial isso é `get_crm_wa_account(null)` = a conta MAIS ANTIGA
 * (IA SDR). Toda reação em conversa de outro número oficial (Pedagógico/Podcast, 3250,
 * Cobrança, Comercial…) falhava: em 30 dias, 223 de 223 pelo número errado; as 2 que saíram
 * pelo número certo chegaram.
 *
 * Quem diz o número é a mensagem reagida: `sac_mensagens` → `sac_conversas`
 * (`wa_account_id` | `wa_conexao_id`); reserva: a própria linha em `crm_whatsapp_messages`.
 * Não achou ou deu erro ⇒ null, e o chamador segue a rota de antes (nunca pior).
 */

export type LinhaDaReacao = { waAccountId: string | null; waConexaoId: string | null };

type Linha = { wa_account_id?: string | null; wa_conexao_id?: string | null } | null | undefined;
// deno-lint-ignore no-explicit-any
type Banco = { from(tabela: string): any };

function linhaDe(r: Linha): LinhaDaReacao | null {
  if (r?.wa_conexao_id) return { waAccountId: null, waConexaoId: String(r.wa_conexao_id) };
  if (r?.wa_account_id) return { waAccountId: String(r.wa_account_id), waConexaoId: null };
  return null;
}

export async function linhaDaMensagemReagida(admin: Banco, wamid: unknown): Promise<LinhaDaReacao | null> {
  const alvo = String(wamid ?? "").trim();
  if (!alvo) return null;
  try {
    const { data: msgs } = await admin
      .from("sac_mensagens")
      .select("conversa_id")
      .eq("wa_message_id", alvo)
      .not("conversa_id", "is", null)
      .limit(1);
    const conversaId = (msgs as { conversa_id?: string }[] | null)?.[0]?.conversa_id;
    if (conversaId) {
      const { data: conversa } = await admin
        .from("sac_conversas")
        .select("wa_account_id, wa_conexao_id")
        .eq("id", conversaId)
        .maybeSingle();
      const linha = linhaDe(conversa);
      if (linha) return linha;
    }
    const { data: crm } = await admin
      .from("crm_whatsapp_messages")
      .select("wa_account_id, wa_conexao_id")
      .eq("wa_message_id", alvo)
      .maybeSingle();
    return linhaDe(crm);
  } catch (e) {
    console.warn("[crm-whatsapp-send] linha da mensagem reagida indisponível, usando a rota padrão:", e instanceof Error ? e.message : e);
    return null;
  }
}
