// crm-transcrever-audio
// OpenAI primeiro; Gemini cobre falha, limite, timeout ou transcrição vazia.
// O mesmo caminho atende três chamadores, e NENHUM deles envia mensagem:
//   1. botão do SAC          (POST com mensagem_id e JWT de atendente)
//   2. memória humana do SDR (?mode=historico-sdr, saída humana da linha comercial)
//   3. áudio do ALUNO        (?mode=aluno-inbound, entrada na linha do assistente pedagógico,
//      desde 12/09/2026). A fila é outra, o segredo é outro, o worker é o mesmo.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  acessoWorkerAutorizado,
  FILA_ALUNO,
  processarFilaAudio,
  processarHistoricoSdr,
} from "./historicoSdr.ts";
import { codigoErroSeguro, transcreverAudio } from "./transcricao.ts";
import { resolverGemini } from './configuracao.ts';
import { criarTelemetria } from '../crm-agente-sdr/eventos.ts';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_KEY = Deno.env.get("AGENTE_SDR_OPENAI_KEY") ?? Deno.env.get("OPENAI_API_KEY") ?? "";
const MODELO = Deno.env.get("OPENAI_TRANSCRIBE_MODEL") ?? "whisper-1";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "método não permitido" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  let configuracao: ReturnType<typeof resolverGemini> | undefined;
  const transcrever = async (url: string, mime: string | null) => {
    // Só resolve a chave depois da autorização e quando não há cache de texto.
    configuracao ??= resolverGemini(admin, nome => Deno.env.get(nome));
    const gemini = await configuracao;
    const tel = criarTelemetria(admin, 'crm-transcrever-audio');
    return transcreverAudio(url, mime, { chave: OPENAI_KEY, modelo: MODELO, gemini,
      registrar: evento => tel.registrar('transcricao_audio_' + evento.fase, evento) });
  };

  const modo = new URL(req.url).searchParams.get("mode");

  // Áudio de entrada na linha do assistente pedagógico. Segredo PRÓPRIO, em tabela própria: a
  // config do assistente tem leitura para diretor, e chave de endpoint não entra num select de
  // tela. Quem chama é a trigger do banco (na hora) e o cron `onb-agente-audio` (as falhas).
  if (modo === "aluno-inbound") {
    try {
      const { data: chave, error: chaveErr } = await admin.from("onb_agente_audio_chave")
        .select("chave").eq("id", true).maybeSingle();
      if (chaveErr) return json({ error: "configuracao_indisponivel" }, 500);
      if (!acessoWorkerAutorizado(req.method, req.headers.get("x-onb-audio-key"), chave?.chave)) {
        return json({ error: "não autorizado" }, 401);
      }
      const resultado = await processarFilaAudio({
        rpc: async (nome, parametros) => await admin.rpc(nome, parametros),
        transcrever,
        fila: FILA_ALUNO,
      });
      return json({ ok: true, ...resultado });
    } catch (erro) {
      return json({ error: codigoErroSeguro(erro) }, 500);
    }
  }

  if (modo === "historico-sdr") {
    try {
      // O service_role do cron pode diferir do container no self-hosted. O segredo
      // compartilhado só é lido no servidor; JWT de atendente não autoriza o worker.
      const { data: cfg, error: cfgErr } = await admin.from("crm_agente_sdr_config")
        .select("followup_secret").eq("id", 1).maybeSingle();
      if (cfgErr) return json({ error: "configuracao_indisponivel" }, 500);
      if (!acessoWorkerAutorizado(req.method, req.headers.get("x-sdr-historico-key"), cfg?.followup_secret)) {
        return json({ error: "não autorizado" }, 401);
      }
      const resultado = await processarHistoricoSdr({
        rpc: async (nome, parametros) => await admin.rpc(nome, parametros),
        transcrever,
      });
      return json({ ok: true, ...resultado });
    } catch (erro) {
      return json({ error: codigoErroSeguro(erro) }, 500);
    }
  }

  try {
    const body = await req.json().catch(() => ({}));
    const mensagemId = String(body?.mensagem_id ?? "").trim();
    if (!mensagemId) return json({ error: "mensagem_id obrigatório" }, 400);

    // Só atendente logado transcreve (não anon). O front chama via invoke (manda o JWT).
    const authToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!authToken || authToken === SERVICE_ROLE) return json({ error: "não autorizado" }, 401);
    const { data: u } = await admin.auth.getUser(authToken);
    if (!u?.user?.id) return json({ error: "não autorizado" }, 401);

    const { data: msg, error: msgErr } = await admin
      .from("sac_mensagens")
      .select("id, anexos, transcricao")
      .eq("id", mensagemId)
      .maybeSingle();
    if (msgErr) return json({ error: msgErr.message }, 500);
    if (!msg) return json({ error: "mensagem não encontrada" }, 404);

    // Cache: já transcrito → devolve.
    if (msg.transcricao && String(msg.transcricao).trim()) {
      return json({ transcricao: msg.transcricao, cached: true });
    }

    const anexos = Array.isArray(msg.anexos) ? msg.anexos : [];
    const audio = anexos.find((a: any) =>
      (a?.mime_type ?? "").startsWith("audio/") || a?.tipo === "audio"
    ) ?? anexos[0];
    const audioUrl = audio?.url ?? audio?.url_storage;
    if (!audioUrl) return json({ error: "mensagem sem áudio" }, 400);

    let transcricao: string;
    try {
      transcricao = await transcrever(String(audioUrl), audio?.mime_type ?? null);
    } catch (erro) {
      const codigo = codigoErroSeguro(erro);
      // O botão reconhece transcrição vazia como ausência de fala, sem toast de erro.
      return json({ error: codigo === "TRANSCRICAO_VAZIA" ? "transcrição vazia" : codigo }, 422);
    }

    // O trigger propaga a transcrição ao CRM e à memória do SDR. Não devolvemos
    // sucesso se o banco não salvou: o operador precisa poder tentar novamente.
    const { error: salvarErr } = await admin.from("sac_mensagens").update({ transcricao }).eq("id", mensagemId);
    if (salvarErr) return json({ error: "falha ao salvar transcrição" }, 500);

    return json({ transcricao, cached: false });
  } catch (e) {
    return json({ error: (e as Error).message ?? "erro" }, 500);
  }
});
