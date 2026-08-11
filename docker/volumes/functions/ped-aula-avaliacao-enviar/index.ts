// ped-aula-avaliacao-enviar: manda ao PROFESSOR a avaliação que os alunos deram da aula dele.
//
// Fluxo: a equipe abre o painel de revisão na planilha (Controle de Aulas ao Vivo → coluna NPS),
// ESCOLHE quais comentários vão, pode ajustar nota/contagem, confere a prévia e clica em enviar.
// Nada sai sozinho — não existe cron aqui.
//
// ⚠️ O QUE A EQUIPE EDITA VALE SÓ PARA O E-MAIL. O NPS da planilha continua sendo a média do
// aluno (trigger ped_aula_feedback_reflete_nps). O que foi enviado é gravado à parte, em
// ped_aula_avaliacao_envios — auditável sem contaminar a métrica.
//
// ⚠️ RECUSA = 422, NUNCA 502/504 (regra do projeto): a api.ppgeducacao.site está atrás do
// Cloudflare, que SUBSTITUI 502/504 da origem pela página de erro dele SEM CORS — o navegador
// veria só "Failed to send a request to the Edge Function" e esconderia o motivo real.
//
// ⚠️ Deploy por git push (deploy-edges.yml), NUNCA pelo "Deploy" do Dokploy (apaga functions).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ensureToken, base64UrlEncode, encodeHeaderUtf8, encodeDisplayName } from "../_shared/gmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Caixa do Pedagógico. ⚠️ email_remetentes.gmail_caixa_email vinha VAZIO e derrubava o
// email-send com 412 (corrigido em 20260810173802) — aqui resolvemos a caixa direto.
const CAIXA_PEDAGOGICO = "secretaria@ppgeducacao.com.br";

function htmlEscape(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function primeiroNome(nome?: string | null): string {
  return String(nome ?? "").trim().split(/\s+/)[0] || "Professor(a)";
}
/** Data BR a partir de 'YYYY-MM-DD' sem passar por Date (que desloca o fuso e volta um dia). */
function dataBR(iso?: string | null): string {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}
/** 9.7 → "9,70". Regra de ouro do projeto: 2 casas, nunca arredondar para inteiro. */
function nota2(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2).replace(".", ",") : "—";
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * MODELO APROVADO PELO USUÁRIO (2026-08-10): blocos separados por linha, nota em destaque,
 * comentários um por parágrafo. Sem tabela, sem card colorido — o professor lê no celular.
 */
function montarEmail(p: {
  professorNome: string;
  tituloAula: string;
  curso: string | null;
  data: string | null;
  nota: unknown;
  total: number;
  comentarios: string[];
}) {
  const assunto = `Avaliação da sua aula de ${dataBR(p.data)}`;
  const linha = `<hr style="border:none;border-top:1px solid #e5e7eb;margin:22px 0">`;

  const blocoComentarios = p.comentarios.length
    ? `<p style="margin:0 0 10px;font-weight:600">O que os alunos escreveram</p>` +
      p.comentarios
        .map(
          (c) =>
            `<p style="margin:0 0 12px;padding-left:12px;border-left:3px solid #e5e7eb;color:#374151">${htmlEscape(
              c,
            )}</p>`,
        )
        .join("")
    : "";

  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#111827;max-width:560px">` +
    `<p>Olá, ${htmlEscape(primeiroNome(p.professorNome))}! Tudo bem?</p>` +
    `<p>Os alunos avaliaram a sua aula e queremos compartilhar o retorno com você.</p>` +
    linha +
    `<p style="margin:0 0 4px;font-weight:600">${htmlEscape(p.tituloAula)}</p>` +
    (p.curso ? `<p style="margin:0;color:#6b7280">${htmlEscape(p.curso)}</p>` : "") +
    `<p style="margin:4px 0 0;color:#6b7280">${dataBR(p.data)}</p>` +
    linha +
    `<p style="margin:0 0 6px;color:#6b7280">Nota dos alunos</p>` +
    `<p style="margin:0;font-size:34px;font-weight:700;line-height:1.1">${nota2(p.nota)}<span style="font-size:18px;font-weight:400;color:#6b7280"> de 10</span></p>` +
    `<p style="margin:6px 0 0;color:#6b7280">${p.total} ${p.total === 1 ? "resposta" : "respostas"}</p>` +
    (blocoComentarios ? linha + blocoComentarios : "") +
    linha +
    `<p>Obrigado por seguir com a gente — esse retorno ajuda a gente a evoluir junto.</p>` +
    `<p style="margin-top:20px;color:#6b7280">Equipe Pedagógica<br>PPGVET</p>` +
    `</div>`;

  return { assunto, html };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1) quem está mandando — o gate REAL é o dossiê (security definer + ped_aula_feedback_pode_gerir)
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ erro: "Não autenticado" }, 401);

    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser();
    const user = userData?.user;
    if (!user) return json({ erro: "Não autenticado" }, 401);

    const body = await req.json().catch(() => ({}));
    const aulaId = String(body?.aula_id ?? "");
    if (!aulaId) return json({ erro: "aula_id é obrigatório" }, 422);

    // 2) dossiê PELO USUÁRIO (respeita o gate). É a fonte da verdade do que PODE ser enviado.
    const { data: dossie, error: errDossie } = await userClient.rpc("ped_aula_avaliacao_dossie", {
      p_aula_id: aulaId,
    });
    if (errDossie) {
      const msg = String(errDossie.message ?? "");
      return json({ erro: msg.includes("Acesso negado") ? "Você não tem permissão para enviar" : msg }, 403);
    }

    if (!dossie?.pode_enviar) {
      const motivos: Record<string, string> = {
        aula_anterior_ao_inicio: "Esta aula é anterior ao início do envio automático — não enviamos notas retroativas.",
        sem_avaliacao: "Esta aula ainda não tem nenhuma avaliação de aluno.",
        professor_sem_email: "O professor não tem e-mail cadastrado. Cadastre na ficha dele para conseguir enviar.",
      };
      return json(
        { erro: motivos[String(dossie?.motivo_bloqueio)] ?? "Esta aula não pode ser enviada.", motivo: dossie?.motivo_bloqueio },
        422,
      );
    }

    // 3) o que a equipe DECIDIU mandar (o painel manda; o dossiê é o default)
    const destinatario = String(body?.email ?? dossie.professor?.email ?? "").trim();
    if (!destinatario) return json({ erro: "Sem e-mail de destino" }, 422);

    const nota = body?.nota ?? dossie.nota_media;
    const total = Number(body?.total_respostas ?? dossie.total_respostas ?? 0);
    // ⚠️ comentários vêm do PAINEL (só os marcados, já editados). Array vazio é LEGÍTIMO:
    // a equipe pode mandar só a nota, sem nenhum comentário.
    const comentarios: string[] = Array.isArray(body?.comentarios)
      ? body.comentarios.map((c: unknown) => String(c ?? "").trim()).filter(Boolean)
      : [];

    const { assunto, html } = montarEmail({
      professorNome: String(dossie.professor?.nome ?? ""),
      tituloAula: String(dossie.aula?.titulo ?? "sua aula"),
      curso: dossie.aula?.curso ?? null,
      data: dossie.aula?.data ?? null,
      nota,
      total,
      comentarios,
    });

    // 4) caixa do Pedagógico + token
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: caixa } = await admin
      .from("email_caixas_conectadas")
      .select("id, email_caixa, nome_exibicao, calendar_integration_id, ativo")
      .eq("email_caixa", CAIXA_PEDAGOGICO)
      .eq("ativo", true)
      .maybeSingle();
    if (!caixa) return json({ erro: `Caixa ${CAIXA_PEDAGOGICO} não está conectada` }, 422);

    const { data: integ } = await admin
      .from("calendar_integrations")
      .select("*")
      .eq("id", caixa.calendar_integration_id)
      .maybeSingle();
    if (!integ) return json({ erro: "Integração Google da caixa não encontrada" }, 422);

    let token: string;
    try {
      token = await ensureToken(admin, integ);
    } catch (e) {
      // ⚠️ 422 e não 502: token revogado é recusa de negócio ("reconecte a caixa"), não falha de rede.
      return json({ erro: `Não foi possível autenticar a caixa: ${String(e)}` }, 422);
    }

    const raw = [
      `From: ${encodeDisplayName(caixa.nome_exibicao || "PPGVET")} <${caixa.email_caixa}>`,
      `To: ${destinatario}`,
      `Subject: ${encodeHeaderUtf8(assunto)}`,
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset="UTF-8"',
      "",
      html,
    ].join("\r\n");

    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: base64UrlEncode(raw) }),
    });
    if (!r.ok) {
      const detalhe = await r.text();
      console.error("[aval-enviar] gmail fail", destinatario, detalhe);
      return json({ erro: "O Gmail recusou o envio", detalhe: detalhe.slice(0, 400) }, 422);
    }
    const enviado = await r.json().catch(() => ({}));

    // 5) registra DEPOIS do Gmail aceitar — nunca antes (senão grava envio que não saiu)
    await admin.rpc("ped_aula_avaliacao_registrar_envio", {
      p_aula_id: aulaId,
      p_email: destinatario,
      p_nome: dossie.professor?.nome ?? null,
      p_nota: nota,
      p_total: total,
      p_comentarios: comentarios,
      p_user_id: user.id,
      p_gmail_id: enviado?.id ?? null,
    });

    return json({ ok: true, para: destinatario, comentarios_enviados: comentarios.length });
  } catch (e) {
    console.error("[aval-enviar] erro", String(e));
    return json({ erro: String(e) }, 500);
  }
});
