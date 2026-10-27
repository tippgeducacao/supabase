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
  /** Anexos já baixados p/ o Storage (ver `_shared/waMediaInbound.ts`). Sem isso a foto/
   *  áudio/vídeo/documento do convidado virava só o texto "[image]" no SAC. */
  anexos?: any[] | null;
  waMessageId?: string | null;
  /** `context.id` da Meta quando o convidado respondeu CITANDO uma mensagem nossa. */
  replyToWaMessageId?: string | null;
  templateName?: string | null;
  /** id/payload do botão clicado (inbound). Sem isso o clique vira texto solto no chat. */
  botaoClicado?: string | null;
  enviadaEm?: string;           // ISO; default agora
}

// Botões de RECUSA dos modelos de podcast ("Agora não" em podcast_followup_2_v2,
// podcast_agenda_2_v2 e mais_info_podcast; "Não tenho interesse" no convite do host).
// O whatsapp-webhook usa para encerrar o contato em vez de marcar "Interessado".
// Comparação EXATA do rótulo, sem acento: é clique em botão, não frase solta — um
// "agora não posso, mas semana que vem sim" digitado continua indo para o humano.
const BOTOES_DE_RECUSA = new Set(["agora nao", "nao tenho interesse"]);

function normalizarRotulo(rotulo: string | null | undefined): string {
  return (rotulo || "")
    .normalize("NFD").replace(/\p{M}/gu, "")
    .toLowerCase().replace(/[,.!]+/g, " ").replace(/\s+/g, " ").trim();
}

export function ehBotaoDeRecusa(rotulo: string | null | undefined): boolean {
  return BOTOES_DE_RECUSA.has(normalizarRotulo(rotulo));
}

// Botões que pedem uma RESPOSTA imediata, conforme o fluxo do time (documento de 13/10/2026):
//  · "Quero saber mais" → mais_info_podcast (como funciona a gravação);
//  · "Tenho interesse" / "Vamos agendar" / "Sim, vamos agendar" → o link da agenda.
// Não é follow-up (esse segue no clique do atendente, decisão do Rafael): é responder, na
// hora, a um pedido que o convidado acabou de fazer. Mesma comparação exata da recusa.
export type AcaoCliquePodcast = "mais_info" | "agenda";
const BOTOES_DE_ACAO: Record<string, AcaoCliquePodcast> = {
  "quero saber mais": "mais_info",
  "tenho interesse": "agenda",
  "vamos agendar": "agenda",
  "sim vamos agendar": "agenda",
};

export function acaoDoCliquePodcast(rotulo: string | null | undefined): AcaoCliquePodcast | null {
  return BOTOES_DE_ACAO[normalizarRotulo(rotulo)] ?? null;
}

// Botões do fluxo do PDF "Processo de Podcasts PPGVET" (22/10/2026). O MESMO rótulo faz coisas
// diferentes conforme o MODELO de onde veio — "Agora não" no mais_info manda o pedido de indicação;
// no próprio pedido de indicação, só encerra. O modelo é o da mensagem CITADA (o clique chega com o
// context.id dela; ped_conversas_mensagens.template_name). Sem saber o modelo, vale o caso comum.
export type AcaoBotaoPodcast =
  | AcaoCliquePodcast
  | "pedido_indicacao" // recusa: Convidar em 6 meses + manda o podcast_pedido_indicacao
  | "encerramento"     // "Não tenho interesse" no follow-up 2 do PDF: podcast_encerramento_convite + Rejeitado
  | "encerramento_6m"  // "Agora não" no follow-up 2 antigo (v2): encerramento + Convidar em 6 meses
  | "recusa"           // "Agora não" no pedido de indicação: só o Convidar em 6 meses
  | "indicacao"        // "Indicar alguém": avisa a equipe na tela (a conversa segue com o humano)
  | "alerta"           // "Preciso reagendar"/"Tive um imprevisto"/"Preciso de ajuda": alerta urgente na tela
  | "confirmou";       // "Confirmado"/"Tudo certo": registra na gravação

/** As ações que encerram o contato do convidado (candidatura → recusou). */
export const ACOES_DE_RECUSA: ReadonlySet<AcaoBotaoPodcast> = new Set(["pedido_indicacao", "encerramento", "encerramento_6m", "recusa"]);

export function acaoDoBotaoPodcast(rotulo: string | null | undefined, modelo: string | null | undefined): AcaoBotaoPodcast | null {
  const r = normalizarRotulo(rotulo);
  const m = String(modelo ?? "").toLowerCase();
  const clique = BOTOES_DE_ACAO[r];
  if (clique) return clique;
  switch (r) {
    case "nao tenho interesse":
      // só os follow-ups 2 do PDF (v3 em diante) têm este botão; o v2 tem "Agora não"
      return m.startsWith("podcast_followup_2") ? "encerramento" : "pedido_indicacao";
    case "agora nao":
      if (m.startsWith("podcast_pedido_indicacao")) return "recusa";
      if (m.startsWith("podcast_followup_2")) return "encerramento_6m";
      return "pedido_indicacao"; // mais_info_podcast, podcast_agenda_2, ou modelo desconhecido
    case "indicar alguem":
    case "quero indicar alguem":
      return "indicacao";
    case "preciso reagendar":
    case "tive um imprevisto":
    case "tenho um imprevisto":
    case "preciso de ajuda":
      return "alerta";
    case "confirmado":
    case "tudo certo":
    case "estou pronto(a)":
      return "confirmou";
  }
  // "Tenho uma dúvida", "Não consegui acessar", "Prefiro outro horário", "Já agendei", "Vou enviar a
  // foto", "Foi ótimo!", "Gostei muito!", "Tenho um feedback/uma sugestão": só o SAC (humano)
  return null;
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
      anexos: m.anexos ?? [],
      template_name: m.templateName ?? null,
      botao_clicado: m.botaoClicado ?? null,
      wa_message_id: m.waMessageId ?? null,
      reply_to_wa_message_id: m.replyToWaMessageId ?? null,
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
