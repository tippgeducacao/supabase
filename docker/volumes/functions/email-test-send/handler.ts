import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { autorizarEnvioEmail, conferirContaEnvioEmail, ErroAcessoEnvioEmail } from "../_shared/emailSendAuth.ts";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (valor: unknown, status = 200) => new Response(JSON.stringify(valor), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const objeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export function criarHandlerTesteEmail(deps: { cliente: SupabaseClient; urlSupabase: string; buscar?: typeof fetch }) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);
    try {
      // Sem fallback de service_role: um teste representa a sessão que o solicitou.
      const acesso = await autorizarEnvioEmail(deps.cliente, req.headers.get("Authorization"));
      let corpo: unknown;
      try { corpo = await req.json(); } catch { return json({ error: "Pedido de teste inválido." }, 400); }
      if (!objeto(corpo)) return json({ error: "Pedido de teste inválido." }, 400);
      conferirContaEnvioEmail(corpo.usuario_esperado, acesso.usuarioId);
      const { template_id, variaveis, assunto, corpo_html, corpo_texto, remetente_id } = corpo;
      const destinatario_email = typeof corpo.destinatario_email === "string" ? corpo.destinatario_email.trim() : "";
      const temAvulso = typeof corpo_html === "string" && !!corpo_html.trim();
      if (destinatario_email.length > 254 || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(destinatario_email)
        || !temAvulso && (typeof template_id !== "string" || !UUID.test(template_id))
        || temAvulso && (typeof assunto !== "string" || !assunto.trim() || assunto.length > 200 || /[\r\n]/.test(assunto) || corpo_html.length > 1000000)
        || corpo_texto != null && (typeof corpo_texto !== "string" || corpo_texto.length > 300000)
        || remetente_id != null && (typeof remetente_id !== "string" || !UUID.test(remetente_id))
        || variaveis != null && (!objeto(variaveis) || Object.keys(variaveis).length > 200 || Object.entries(variaveis).some(([k, v]) => !/^[\w.]+$/.test(k) || k.length > 120 || typeof v !== "string" || v.length > 20000))) {
        return json({ error: "Confira destinatário, modelo e conteúdo do teste." }, 400);
      }
      let remetenteAvulso = remetente_id ?? null;
      if (temAvulso && !remetenteAvulso) {
        const { data, error } = await deps.cliente.from("email_remetentes").select("id").eq("ativo", true).order("criado_em", { ascending: true }).limit(1).maybeSingle();
        if (error) return json({ error: "Não foi possível consultar o remetente do teste." }, 503);
        remetenteAvulso = data?.id ?? null;
        if (!remetenteAvulso) return json({ error: "Nenhum remetente ativo para enviar o teste. Cadastre um em Remetentes." }, 400);
      }
      const varsFake = { nome_aluno: "João da Silva (TESTE)", curso: "Pós-Graduação em Clínica Médica de Pequenos Animais", modalidade: "EAD", instituicao_parceira: "PPGVET",
        nome_atendente: "Secretaria Acadêmica", link_portal: "https://portal.ppgeducacao.com.br", docs_faltantes: "<ul><li>Termo de Aceite de Orientação</li><li>Ficha de Cadastro do Orientador</li></ul>",
        observacoes: "Observações de teste.", ...(variaveis ?? {}) as Record<string, string> };
      const resposta = await (deps.buscar ?? fetch)(`${deps.urlSupabase.replace(/\/$/, "")}/functions/v1/email-send`, {
        method: "POST", headers: { Authorization: acesso.authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ ...(temAvulso ? { assunto, corpo_html, corpo_texto, remetente_id: remetenteAvulso } : { template_id }),
          destinatario_email, destinatario_nome: "Destinatário de teste", variaveis: varsFake, contexto_tipo: "teste", usuario_esperado: acesso.usuarioId }),
      });
      const data: unknown = await resposta.json().catch(() => null);
      if (!resposta.ok) return json({ error: objeto(data) && typeof data.error === "string" ? data.error : "O serviço não confirmou o envio do teste." }, resposta.status);
      // Supressão é 200 no motor, mas não significa que o destinatário recebeu.
      if (!objeto(data) || data.ok !== true || data.error || data.suprimido || data.duplicado) return json({ error: objeto(data) && data.suprimido ? "O destinatário está suprimido. O teste não foi enviado." : "O serviço não confirmou um novo envio de teste." }, 422);
      return json({ ...data, success: true });
    } catch (e) {
      if (e instanceof ErroAcessoEnvioEmail) return json({ error: e.message, code: e.code }, e.status);
      return json({ error: "Não foi possível confirmar o teste. Confira o histórico antes de tentar novamente." }, 503);
    }
  };
}
