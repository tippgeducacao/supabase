// wa-uazapi-espelho
// ----------------------------------------------------------------------------
// "WhatsApp completo" de uma linha Uazapi — a visão idêntica ao WhatsApp Web que SÓ O DIRETOR
// abre, a partir de CRM → WhatsApp Web (botão no card da linha).
//
// Por que existe: o CRM só grava o que o webhook recebe (e o webhook descarta grupos e quem
// não é lead). Para o diretor ver o número INTEIRO — todas as conversas, grupos, histórico — a
// leitura é AO VIVO na Uazapi, pelo token da instância, que nunca sai do servidor.
//
// Ações (todas exigem o diretor logado — RPC `pode_ver_whatsapp_completo`):
//   chats          lista de conversas (busca, não lidas, grupos, arquivadas, paginação)
//   abrir_conversa registra no log que o diretor abriu a conversa
//   mensagens      histórico de uma conversa (paginado, do mais novo para trás)
//   midia          decripta uma mídia e devolve o link (a Uazapi guarda ~2 dias)
//   enviar_texto   responde pela linha (texto)
//   enviar_midia   responde pela linha (arquivo já subido pelo diretor no bucket whatsapp-anexos)
//
// AUDITORIA: cada abertura de conversa e cada envio grava uma linha em `wa_espelho_acessos`
// (quem, qual linha, qual conversa, quando). É a linha de uma pessoa — o rastro é obrigatório.
//
// NÃO marca a conversa como lida no aparelho da pessoa: olhar não pode apagar o "não lida" dela.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/cors.ts";
import { AcessoNegado, exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import { getWaProvider } from "../_shared/waProviders.ts";
import { destinoDeEnvio, normalizarChats, normalizarMensagens } from "../_shared/waEspelho.ts";
import { criarMidiaEnvio } from "../_shared/midiaEnvioAutorizada.ts";
import { MidiaInvalida, objetoDoStorage } from "../_shared/midiaRecebida.ts";
import { conferirUrlPublica } from "../_shared/urlMidiaPublica.ts";
import type { Chamador } from "../_shared/acesso.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PROVIDER = "uazapi";
const BUCKET_ANEXOS = "whatsapp-anexos";
const TIPOS_MIDIA = new Set(["image", "video", "audio", "document", "sticker"]);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function inteiro(v: unknown, padrao: number, min: number, max: number): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : padrao;
}

/** Só arquivo que NÓS subimos no bucket de anexos do CRM pode ser mandado por esta porta. */
export function ehAnexoDoCrm(url: string): boolean {
  try {
    return objetoDoStorage(url)?.bucket === BUCKET_ANEXOS;
  } catch (e) {
    if (e instanceof MidiaInvalida) return false;
    throw e;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "use POST" }, 405);

  let usuarioId: string;
  let quem: Chamador;
  try {
    quem = await exigirAcesso(req, { usuario: true, rpcPermissao: "pode_ver_whatsapp_completo" });
    if (quem.tipo !== "usuario") return json({ error: "só o diretor logado" }, 403);
    usuarioId = quem.usuarioId;
  } catch (e) {
    return respostaAcessoNegado(e, corsHeaders);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action ?? "");
  const conexaoId = String(body?.conexao_id ?? "");
  if (!conexaoId) return json({ error: "conexao_id é obrigatório" }, 400);

  const { data: conex } = await admin.from("wa_conexoes")
    .select("id, server_url, status_conexao, ativo, provider").eq("id", conexaoId).maybeSingle();
  if (!conex || conex.ativo === false) return json({ error: "linha não encontrada" }, 404);
  const { data: sec } = await admin.from("wa_conexoes_secrets").select("token").eq("conexao_id", conexaoId).maybeSingle();
  if (!sec?.token) return json({ error: "linha sem credencial — reconecte pelo QR" }, 422);
  if (conex.status_conexao !== "conectado") {
    return json({ error: "a linha está desconectada — reconecte pelo QR antes de abrir" }, 422);
  }

  const provider = getWaProvider(conex.provider ?? PROVIDER);
  const server = conex.server_url as string;
  const token = sec.token as string;

  async function auditar(acao: string, chatId: string | null, detalhe: Record<string, unknown> = {}) {
    const { error } = await admin.from("wa_espelho_acessos").insert({
      usuario_id: usuarioId, wa_conexao_id: conexaoId, acao, chat_id: chatId, detalhe,
    });
    // A auditoria é a razão de a porta existir: se não grava, o envio NÃO acontece (ver abaixo).
    if (error) throw new Error(`falha ao registrar o acesso: ${error.message}`);
  }

  try {
    switch (action) {
      case "chats": {
        const filtro = String(body?.filtro ?? "todas");
        const busca = String(body?.busca ?? "").slice(0, 80);
        const limit = inteiro(body?.limit, 40, 1, 100);
        const offset = inteiro(body?.offset, 0, 0, 100000);
        const cru = await provider.listChats(server, token, {
          limit, offset, busca,
          somenteNaoLidas: filtro === "nao_lidas",
          somenteGrupos: filtro === "grupos",
          arquivadas: filtro === "arquivadas",
        });
        const r = normalizarChats(cru);
        let chats = r.chats;
        // Com busca a Uazapi ignora os filtros (operador OR) — aplica aqui.
        if (busca) {
          if (filtro === "nao_lidas") chats = chats.filter((c) => c.naoLidas > 0);
          if (filtro === "grupos") chats = chats.filter((c) => c.grupo);
        }
        // Fixadas primeiro, depois por recência (a Uazapi ordena só por recência).
        if (!busca && offset === 0) chats = [...chats].sort((a, b) => Number(b.fixada) - Number(a.fixada) || (b.ultimaEm ?? 0) - (a.ultimaEm ?? 0));
        return json({ ok: true, chats, temMais: r.temMais, proximoOffset: r.proximoOffset || offset + limit, total: r.total });
      }

      // O diretor acabou de abrir esta conversa. Ação própria (e não parte de `mensagens`) porque
      // o recarregar automático chama `mensagens` a cada poucos segundos — auditar aquilo seria ruído.
      case "abrir_conversa": {
        const chatId = String(body?.chat_id ?? "");
        if (!chatId || chatId.length > 80) return json({ error: "chat_id inválido" }, 400);
        await auditar("abriu_conversa", chatId);
        return json({ ok: true });
      }

      case "mensagens": {
        const chatId = String(body?.chat_id ?? "");
        if (!chatId) return json({ error: "chat_id é obrigatório" }, 400);
        const limit = inteiro(body?.limit, 50, 1, 100);
        const offset = inteiro(body?.offset, 0, 0, 100000);
        const cru = await provider.findMessages(server, token, chatId, { limit, offset });
        const r = normalizarMensagens(cru);
        // Sem `pagination.hasMore` na resposta, página cheia = pode ter mais.
        const temMais = r.temMais || r.mensagens.length >= limit;
        return json({ ok: true, mensagens: r.mensagens, temMais, proximoOffset: offset + limit });
      }

      case "midia": {
        const messageId = String(body?.message_id ?? "");
        if (!messageId) return json({ error: "message_id é obrigatório" }, 400);
        const m = await provider.downloadMedia(server, token, messageId, { audioMp3: body?.audio_mp3 !== false, timeoutMs: 45000 });
        if (!m.url) return json({ error: "a mídia não está mais disponível (a Uazapi guarda ~2 dias)" }, 422);
        return json({ ok: true, url: m.url, mime: m.mime });
      }

      case "enviar_texto": {
        const destino = destinoDeEnvio(String(body?.chat_id ?? ""));
        if (!destino) return json({ error: "conversa inválida para envio" }, 400);
        const texto = String(body?.texto ?? "").trim();
        if (!texto) return json({ error: "mensagem vazia" }, 400);
        if (texto.length > 4000) return json({ error: "mensagem longa demais (máx. 4000 caracteres)" }, 400);
        await auditar("enviou_texto", String(body.chat_id), { tamanho: texto.length, trecho: texto.slice(0, 120) });
        const r = await provider.sendText(server, token, destino, texto);
        if (!r.ok) return json({ error: "a Uazapi recusou o envio", detalhe: JSON.stringify(r.raw).slice(0, 200) }, 422);
        return json({ ok: true, externalId: r.externalId });
      }

      case "enviar_midia": {
        const destino = destinoDeEnvio(String(body?.chat_id ?? ""));
        if (!destino) return json({ error: "conversa inválida para envio" }, 400);
        const url = String(body?.url ?? "");
        if (!ehAnexoDoCrm(url)) return json({ error: "arquivo não permitido" }, 400);
        const tipo = String(body?.tipo ?? "");
        if (!TIPOS_MIDIA.has(tipo)) return json({ error: "tipo de arquivo inválido" }, 400);
        const legenda = String(body?.legenda ?? "").slice(0, 1000);
        // O bucket é privado (30/10/2026): o link gravado vira um link assinado, com a sessão do
        // diretor, que a Uazapi consegue baixar. Mesma peça do crm-whatsapp-send.
        const midia = criarMidiaEnvio(quem, {
          base: SUPABASE_URL, chaveAnon: Deno.env.get("SUPABASE_ANON_KEY") ?? "", chaveServico: SERVICE_ROLE,
          publico: Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site",
          conferirExterna: async (u) => { await conferirUrlPublica(u); },
        });
        const urlParaUazapi = await midia.paraTerceiros(url);
        await auditar("enviou_midia", String(body.chat_id), { tipo, nome: String(body?.nome ?? "").slice(0, 120) });
        const r = await provider.sendMedia(server, token, destino, {
          tipo: tipo as "image" | "video" | "audio" | "document" | "sticker",
          url: urlParaUazapi,
          caption: legenda || undefined,
          filename: String(body?.nome ?? "") || undefined,
        });
        if (!r.ok) return json({ error: "a Uazapi recusou o envio", detalhe: JSON.stringify(r.raw).slice(0, 200) }, 422);
        return json({ ok: true, externalId: r.externalId });
      }

      default:
        return json({ error: `ação desconhecida: ${action}` }, 400);
    }
  } catch (e) {
    if (e instanceof AcessoNegado) return respostaAcessoNegado(e, corsHeaders);
    if (e instanceof MidiaInvalida) return json({ error: "arquivo não permitido" }, 400);
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[wa-uazapi-espelho]", action, msg);
    // 422 (nunca 502/504): o Cloudflare engole 502/504 da origem sem headers CORS.
    return json({ error: msg.includes("registrar o acesso") ? msg : `falha ao falar com o WhatsApp: ${msg}` }, 422);
  }
});
