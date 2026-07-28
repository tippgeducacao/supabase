// Espelha a conversa de CONVITE DE PODCAST (WhatsApp, número do podcast) para o SAC do
// PEDAGÓGICO. Não escreve em sac_* direto: faz find-or-create de ped_conversas_avulsas
// (1 thread por convidado) + insere a mensagem em ped_conversas_mensagens; os triggers
// sac_mirror_from_ped_conversa / sac_mirror_from_ped_msg levam ao funil "Atendimento".
// Dedupe da thread por (professor em professores_alvo) + metadata.origem='podcast_convite'.
// metadata.wa_account_id guarda a conta do podcast → a resposta pela SAC sai por ela
// (whatsapp-send-message resolve a conta pela conversa).

export interface PodcastConversaMsg {
  professorId: string;          // ped_professores.id do convidado
  telefone?: string | null;     // contato_whatsapp do convidado (fallback do mirror p/ contato)
  nome?: string | null;         // nome do convidado (profile_name)
  podcastId?: string | null;
  waAccountId?: string | null;  // conta Meta do podcast (p/ a resposta sair por ela)
  direcao: "inbound" | "outbound";
  conteudo: string;
  waMessageId?: string | null;
  templateName?: string | null;
  /** id/payload do botão clicado (inbound). Sem isso o clique vira texto solto no chat. */
  botaoClicado?: string | null;
  enviadaEm?: string;           // ISO; default agora
}

// Best-effort: nunca lança (o disparo/webhook não pode falhar por causa do espelho no SAC).
export async function logPodcastConversaSac(admin: any, m: PodcastConversaMsg): Promise<void> {
  try {
    const now = m.enviadaEm ?? new Date().toISOString();

    // 1) find-or-create da conversa avulsa (1 por convidado)
    let conversaId: string | null = null;
    const { data: existente } = await admin
      .from("ped_conversas_avulsas")
      .select("id")
      .contains("professores_alvo", [m.professorId])
      .filter("metadata->>origem", "eq", "podcast_convite")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existente?.id) {
      conversaId = existente.id;
    } else {
      const { data: nova, error: convErr } = await admin
        .from("ped_conversas_avulsas")
        .insert({
          tipo: "outro",
          assunto: "Convite de podcast",
          professores_alvo: [m.professorId],
          status: "em_conversa",
          ultima_atividade_em: now,
          primeira_mensagem_em: now,
          metadata: {
            origem: "podcast_convite",
            telefone: m.telefone ?? null,
            profile_name: m.nome ?? null,
            podcast_id: m.podcastId ?? null,
            wa_account_id: m.waAccountId ?? null,
          },
        })
        .select("id")
        .single();
      if (convErr) { console.error("[podcastSac] cria conversa erro:", convErr.message); return; }
      conversaId = nova?.id ?? null;
    }
    if (!conversaId) return;

    // 2) insere a mensagem (o trigger de espelho deduplica por wa_message_id)
    const { error: msgErr } = await admin.from("ped_conversas_mensagens").insert({
      conversa_id: conversaId,
      direcao: m.direcao,
      conteudo: m.conteudo,
      template_name: m.templateName ?? null,
      botao_clicado: m.botaoClicado ?? null,
      wa_message_id: m.waMessageId ?? null,
      enviada_em: now,
    });
    if (msgErr) { console.error("[podcastSac] insere msg erro:", msgErr.message); return; }

    // 3) toca a conversa (mantém ordenação por atividade)
    await admin.from("ped_conversas_avulsas")
      .update({ ultima_atividade_em: now, status: "em_conversa" })
      .eq("id", conversaId);
  } catch (e) {
    console.error("[podcastSac] erro:", String(e));
  }
}
