// ped-aula-avaliacao-enviar: manda ao PROFESSOR a avaliação que os alunos deram da aula dele.
//
// Fluxo: a equipe abre o painel de revisão na planilha (Controle de Aulas ao Vivo → coluna NPS),
// ESCOLHE quais comentários vão, pode ajustar nota/contagem, confere a prévia e clica em enviar.
// Nada sai sozinho — não existe cron aqui.
//
// DOIS CANAIS no mesmo clique (pedido do Rafael 2026-10-01: professor sem e-mail, e-mail que cai
// no spam): o E-MAIL de sempre, agora com o PDF anexo, e o WHATSAPP pelo número do pedagógico,
// com o modelo aprovado `avaliacao_aula_professor` (UTILITY) levando o PDF no cabeçalho. O PDF
// é gerado na TELA com o que a equipe escolheu (o mesmo conteúdo da prévia) e chega aqui em
// base64. Cada canal tem o seu resultado: um falhar não desfaz o outro, e a resposta diz qual
// saiu — para a equipe reenviar SÓ o que faltou (desmarcando o canal que já foi).
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
import {
  TEMPLATE_WA_AVALIACAO,
  TEMPLATE_WA_IDIOMA,
  bytesParaBase64,
  componentesDoCorpo,
  decodificarPdf,
  erroWhatsappAmigavel,
  nomeDoPdf,
  parametrosWhatsapp,
  slugArquivo,
  traduzirStatusModelo,
} from "./whatsapp.ts";
import { telefoneEnviavel } from "../_shared/telefone.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Caixa do Pedagógico. ⚠️ email_remetentes.gmail_caixa_email vinha VAZIO e derrubava o
// email-send com 412 (corrigido em 20260810173802) — aqui resolvemos a caixa direto.
const CAIXA_PEDAGOGICO = "secretaria@ppgeducacao.com.br";

// O PDF vai para bucket PÚBLICO (a Meta baixa de lá) e o caminho tem um uuid — não é listável.
const BUCKET_PDF = "whatsapp-anexos";
// ⚠️ getPublicUrl dentro da edge devolve o host INTERNO do Kong (kong:8000), que nem a Meta nem
// o navegador resolvem. Troca pelo domínio público (mesmo padrão do whatsapp-send-media).
const PUBLIC_SUPABASE_URL = Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site";
const toPublicUrl = (u: string) => u.replace(/^https?:\/\/(supabase-)?kong:8000/i, PUBLIC_SUPABASE_URL);

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
/**
 * 9.7 → "9,70". Regra de ouro do projeto: 2 casas, nunca arredondar para inteiro.
 * ⚠️ null/undefined/"" viram "—", NUNCA "0,00": `Number(null)` é 0 e passaria por finito,
 * publicando "0,00 de 10" — que se lê como "os alunos deram zero ao professor".
 */
function nota2(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
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

/**
 * Monta o RFC 822 do e-mail. Com PDF ⇒ multipart/mixed (HTML + anexo); sem PDF ⇒ o HTML puro de
 * sempre. ⚠️ Tudo em ASCII dentro do `raw` (HTML e PDF em base64): o `base64UrlEncode` do
 * _shared/gmail trata a string como texto UTF-8.
 */
function montarRaw(p: {
  from: string;
  to: string;
  assunto: string;
  html: string;
  pdf: { bytes: Uint8Array; nome: string } | null;
}): string {
  const cab = [`From: ${p.from}`, `To: ${p.to}`, `Subject: ${encodeHeaderUtf8(p.assunto)}`, "MIME-Version: 1.0"];
  if (!p.pdf) return [...cab, 'Content-Type: text/html; charset="UTF-8"', "", p.html].join("\r\n");

  const fronteira = `aval_${crypto.randomUUID().replace(/-/g, "")}`;
  const quebra76 = (b64: string) => b64.replace(/(.{76})/g, "$1\r\n");
  const htmlB64 = btoa(unescape(encodeURIComponent(p.html)));
  // nome do anexo: RFC 2231 (`filename*`, com acento) + um nome ASCII de reserva para cliente velho
  const nomeAscii = p.pdf.nome.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "_");
  const nomeUtf8 = encodeURIComponent(p.pdf.nome).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return [
    ...cab,
    `Content-Type: multipart/mixed; boundary="${fronteira}"`,
    "",
    `--${fronteira}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    quebra76(htmlB64),
    `--${fronteira}`,
    `Content-Type: application/pdf; name="${nomeAscii}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${nomeAscii}"; filename*=UTF-8''${nomeUtf8}`,
    "",
    quebra76(bytesParaBase64(p.pdf.bytes)),
    `--${fronteira}--`,
  ].join("\r\n");
}

/**
 * Status do modelo `avaliacao_aula_professor` NA WABA da conta (APPROVED, PENDING, PAUSED…).
 * null = não deu para consultar — quem chama segue (fail-open) e o próprio envio responde.
 * ⚠️ `name=` na Graph casa por PREFIXO: confere o nome exato e o idioma.
 */
async function situacaoDoModelo(admin: any, crmContaId: string): Promise<string | null> {
  try {
    const { data: contaRow } = await admin.rpc("get_crm_wa_account", { p_account_id: crmContaId });
    const conta = Array.isArray(contaRow) ? contaRow[0] : contaRow;
    if (!conta?.waba_id || !conta?.access_token) return null;
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${conta.waba_id}/message_templates?name=${TEMPLATE_WA_AVALIACAO}` +
        `&fields=name,status,language&limit=50`,
      { headers: { Authorization: `Bearer ${conta.access_token}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const t = (Array.isArray(j?.data) ? j.data : []).find(
      (x: any) => x?.name === TEMPLATE_WA_AVALIACAO && x?.language === TEMPLATE_WA_IDIOMA,
    );
    return t ? String(t.status ?? "").toUpperCase() || null : "INEXISTENTE";
  } catch {
    return null;
  }
}

type ResultadoCanal = { tentado: boolean; ok: boolean; para: string | null; erro: string | null; id: string | null };
const naoTentado = (): ResultadoCanal => ({ tentado: false, ok: false, para: null, erro: null, id: null });

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
        professor_sem_contato:
          "O professor não tem e-mail nem WhatsApp cadastrado. Cadastre na ficha dele para conseguir enviar.",
        professor_sem_email: "O professor não tem e-mail cadastrado. Cadastre na ficha dele para conseguir enviar.",
      };
      return json(
        { erro: motivos[String(dossie?.motivo_bloqueio)] ?? "Esta aula não pode ser enviada.", motivo: dossie?.motivo_bloqueio },
        422,
      );
    }

    // 3) CANAIS. ⚠️ Sem `canais` no corpo é o front ANTIGO (só e-mail) — continua só e-mail, que é
    // exatamente o que aquela tela prometia. Com `canais`, vale o que a equipe marcou.
    const fichaEmail: string | null = dossie.professor?.email ?? null;
    const fichaWhatsapp: string | null = dossie.professor?.whatsapp ?? null;
    const temCanais = body?.canais != null && typeof body.canais === "object";
    const querEmail = temCanais ? body.canais.email === true : true;
    const querWa = temCanais ? body.canais.whatsapp === true : false;
    if (!querEmail && !querWa) return json({ erro: "Escolha pelo menos um canal: e-mail ou WhatsApp." }, 422);

    let destinatario = "";
    if (querEmail) {
      // ⚠️ o caminho de saída para "sem e-mail" é a FICHA (mesma régua de 2026-08-11): sem e-mail
      // cadastrado o canal não existe, mesmo que alguém mande um endereço no corpo.
      if (!fichaEmail) {
        return json({ erro: "O professor não tem e-mail na ficha — desmarque o e-mail ou cadastre na ficha dele." }, 422);
      }
      destinatario = String(body?.email ?? fichaEmail).trim();
      if (!destinatario) return json({ erro: "Sem e-mail de destino" }, 422);
      // ⚠️ header To com string sem cara de e-mail faz o Gmail recusar com erro críptico — melhor
      // dizer aqui o que está errado.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destinatario)) {
        return json({ erro: `E-mail de destino inválido: ${destinatario}` }, 422);
      }
    }
    if (querWa && !fichaWhatsapp) {
      return json({ erro: "O professor não tem WhatsApp na ficha — desmarque o WhatsApp ou cadastre na ficha dele." }, 422);
    }

    // ⚠️ VALIDAR, nunca "consertar sozinho". O `??` sozinho tratava `nota: null` como "não
    // informado" e RESTAURAVA a média do aluno — a equipe aprovava um número na prévia e o
    // professor recebia outro. E `Number(null)` é 0, então null "válido" viraria 0,00 de 10.
    // Régua ESPELHADA de src/components/pedagogico-v2/planilha/avaliacaoEnvioCampos.ts.
    const temNota = body != null && Object.prototype.hasOwnProperty.call(body, "nota");
    const notaBruta = temNota ? body.nota : dossie.nota_media;
    const nota =
      notaBruta === null || notaBruta === undefined || notaBruta === "" ? NaN : Number(notaBruta);
    if (!Number.isFinite(nota) || nota < 0 || nota > 10) {
      return json({ erro: "Nota inválida — precisa ser um número de 0 a 10." }, 422);
    }

    const temTotal = body != null && Object.prototype.hasOwnProperty.call(body, "total_respostas");
    const totalBruto = temTotal ? body.total_respostas : dossie.total_respostas;
    const total =
      totalBruto === null || totalBruto === undefined || totalBruto === "" ? NaN : Number(totalBruto);
    // 0 respostas com nota é número sem denominador: o e-mail diria "9,37 de 10 · 0 respostas".
    if (!Number.isInteger(total) || total < 1) {
      return json({ erro: "Número de respostas inválido — precisa ser um inteiro de 1 ou mais." }, 422);
    }
    // ⚠️ comentários vêm do PAINEL (só os marcados, já editados). Array vazio é LEGÍTIMO:
    // a equipe pode mandar só a nota, sem nenhum comentário.
    const comentarios: string[] = Array.isArray(body?.comentarios)
      ? body.comentarios.map((c: unknown) => String(c ?? "").trim()).filter(Boolean)
      : [];

    // 4) PDF (o mesmo para os dois canais). O WhatsApp NÃO sai sem ele — o modelo aprovado tem
    // cabeçalho de documento; no e-mail ele é anexo, e sem ele o e-mail sai como sempre saiu.
    let pdf: { bytes: Uint8Array; nome: string } | null = null;
    if (body?.pdf_base64) {
      const dec = decodificarPdf(body.pdf_base64);
      if (!dec.ok) return json({ erro: `PDF da avaliação recusado: ${dec.erro}.` }, 422);
      pdf = { bytes: dec.bytes, nome: nomeDoPdf(body?.pdf_nome, dossie.aula?.titulo, dossie.aula?.data) };
    }
    if (querWa && !pdf) {
      return json({ erro: "O WhatsApp leva o PDF da avaliação, e ele não chegou ao servidor. Tente de novo." }, 422);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // ── PRÉ-VOO do WhatsApp ── tudo que pode barrar o WhatsApp é conferido ANTES de o e-mail sair.
    // Sem isto, cada recusa previsível (modelo em análise, número impossível, variável vazia)
    // virava envio pela METADE: o e-mail saía, o WhatsApp não, e o reenvio mandava o e-mail de novo.
    let paramsWa: string[] = [];
    let crmContaId: string | null = null;
    if (querWa) {
      // número da ficha que não pode existir: a Meta só recusaria depois (131026)
      if (!telefoneEnviavel(fichaWhatsapp)) {
        return json({
          erro: `O WhatsApp da ficha do professor (${fichaWhatsapp}) não é um número válido. Corrija na ficha ou desmarque o WhatsApp.`,
        }, 422);
      }
      // as variáveis do modelo: vazia faz a Meta recusar o modelo inteiro (131008)
      const p = parametrosWhatsapp({
        professorNome: dossie.professor?.nome,
        titulo: dossie.aula?.titulo,
        data: dossie.aula?.data,
        nota,
        total,
      });
      if (!p.ok) return json({ erro: `Não dá para montar o WhatsApp: falta ${p.faltando} da aula.` }, 422);
      paramsWa = p.valores;

      // A conta é a do NÚMERO do pedagógico (get_wa_account_pedagogico) — a mesma da régua de
      // convites —, no cadastro do CRM, que é onde o crm-whatsapp-send resolve token e WABA.
      // ⚠️ Sempre pelo id: sem `wa_account_id` o crm-whatsapp-send AUTO-DETECTA a conta pela
      // última conversa daquele telefone e poderia mandar por outro número.
      const { data: pedRow, error: errPed } = await admin.rpc("get_wa_account_pedagogico");
      const ped = Array.isArray(pedRow) ? pedRow[0] : pedRow;
      if (errPed || !ped?.phone_number_id) {
        return json({ erro: "A conta de WhatsApp do pedagógico não está configurada. Desmarque o WhatsApp ou avise a TI." }, 422);
      }
      const { data: crmConta } = await admin
        .from("crm_whatsapp_accounts")
        .select("id")
        .eq("phone_number_id", ped.phone_number_id)
        .eq("ativo", true)
        .maybeSingle();
      if (!crmConta?.id) {
        return json({ erro: "O número do pedagógico não está ativo no cadastro do CRM. Desmarque o WhatsApp ou avise a TI." }, 422);
      }
      crmContaId = crmConta.id;

      // O modelo está APROVADO nesta WABA? (em análise, pausado, recusado ⇒ não manda nada).
      // ⚠️ Falha ao CONSULTAR não barra (fail-open): aí quem responde é o próprio envio.
      const situacao = await situacaoDoModelo(admin, crmContaId!);
      if (situacao && situacao !== "APPROVED") {
        return json({
          erro: `O modelo de WhatsApp ainda não pode ser usado (na Meta ele está ${traduzirStatusModelo(situacao)}). ` +
            "Desmarque o WhatsApp para mandar só o e-mail agora.",
          modelo_status: situacao,
        }, 422);
      }
    }

    // PDF guardado em TODO envio (cópia congelada do que o professor recebeu — auditoria). Para o
    // WhatsApp ele é obrigatório (a Meta baixa daqui); só para o e-mail, falhar não impede o envio.
    let pdfUrl: string | null = null;
    if (pdf) {
      const caminho =
        `avaliacao-aula/${aulaId}/${new Date().toISOString().slice(0, 10)}-` +
        `${crypto.randomUUID()}-${slugArquivo(String(dossie.aula?.titulo ?? "aula"))}.pdf`;
      const { error: errUp } = await admin.storage
        .from(BUCKET_PDF)
        .upload(caminho, pdf.bytes, { contentType: "application/pdf", upsert: false });
      if (!errUp) {
        pdfUrl = toPublicUrl(admin.storage.from(BUCKET_PDF).getPublicUrl(caminho).data.publicUrl);
      } else {
        console.error("[aval-enviar] upload do PDF falhou", aulaId, errUp.message);
        if (querWa) return json({ erro: `Não foi possível guardar o PDF para o WhatsApp (${errUp.message}). Tente de novo.` }, 422);
      }
    }

    const email = naoTentado();
    const wa = naoTentado();

    // 5) E-MAIL — caixa do Pedagógico + token
    if (querEmail) {
      email.tentado = true;
      email.para = destinatario;
      try {
        const { assunto, html } = montarEmail({
          professorNome: String(dossie.professor?.nome ?? ""),
          tituloAula: String(dossie.aula?.titulo ?? "sua aula"),
          curso: dossie.aula?.curso ?? null,
          data: dossie.aula?.data ?? null,
          nota,
          total,
          comentarios,
        });
        const { data: caixa } = await admin
          .from("email_caixas_conectadas")
          .select("id, email_caixa, nome_exibicao, calendar_integration_id, ativo")
          .eq("email_caixa", CAIXA_PEDAGOGICO)
          .eq("ativo", true)
          .maybeSingle();
        if (!caixa) throw new Error(`a caixa ${CAIXA_PEDAGOGICO} não está conectada`);

        const { data: integ } = await admin
          .from("calendar_integrations")
          .select("*")
          .eq("id", caixa.calendar_integration_id)
          .maybeSingle();
        if (!integ) throw new Error("a integração Google da caixa não foi encontrada");

        let token: string;
        try {
          token = await ensureToken(admin, integ);
        } catch (e) {
          throw new Error(`não foi possível autenticar a caixa (${String(e)})`);
        }

        const raw = montarRaw({
          from: `${encodeDisplayName(caixa.nome_exibicao || "PPGVET")} <${caixa.email_caixa}>`,
          to: destinatario,
          assunto,
          html,
          pdf,
        });
        const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw: base64UrlEncode(raw) }),
        });
        if (!r.ok) {
          const detalhe = await r.text();
          console.error("[aval-enviar] gmail fail", destinatario, detalhe);
          throw new Error(`o Gmail recusou o envio (${detalhe.slice(0, 200)})`);
        }
        const enviado = await r.json().catch(() => ({}));
        email.ok = true;
        email.id = enviado?.id ?? null;
      } catch (e) {
        email.erro = e instanceof Error ? e.message : String(e);
      }
    }

    // 6) WHATSAPP — modelo pelo número do pedagógico (via crm-whatsapp-send), PDF no cabeçalho
    let waIncerto = false;
    if (querWa) {
      wa.tentado = true;
      wa.para = fichaWhatsapp;
      const inicio = new Date(Date.now() - 5_000).toISOString();
      let r: Response | null = null;
      let resp: Record<string, unknown> | null = null;
      try {
        // ⚠️ Com o JWT de QUEM CLICOU (não a service_role): o crm-whatsapp-send carimba a mensagem
        // como enviada por uma pessoa, com o nome dela, no chat — é um envio humano.
        r = await fetch(`${SUPABASE_URL}/functions/v1/crm-whatsapp-send`, {
          method: "POST",
          headers: { Authorization: authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({
            wa_account_id: crmContaId,
            telefone: fichaWhatsapp,
            tipo: "template",
            template_name: TEMPLATE_WA_AVALIACAO,
            template_lang: TEMPLATE_WA_IDIOMA,
            template_components: componentesDoCorpo(paramsWa),
            header_media_url: pdfUrl,
            header_media_format: "DOCUMENT",
            header_media_filename: pdf!.nome,
            origem: "humano",
          }),
          signal: AbortSignal.timeout(45_000),
        });
        resp = (await r.json().catch(() => null)) as Record<string, unknown> | null;
      } catch (e) {
        console.error("[aval-enviar] whatsapp sem resposta", aulaId, String(e));
      }

      if (r && resp && r.status < 500) {
        // resposta DEFINITIVA da crm-whatsapp-send
        if (r.ok && resp.success === true) {
          wa.ok = true;
          wa.id = typeof resp.wa_message_id === "string" ? resp.wa_message_id : null;
        } else {
          console.error("[aval-enviar] whatsapp fail", aulaId, r.status, JSON.stringify(resp).slice(0, 400));
          wa.erro = erroWhatsappAmigavel(resp, r.status);
        }
      } else {
        // ⚠️ SEM resposta (tempo esgotado, worker reciclado, 5xx): a Meta pode ter aceitado. Dizer
        // "nada foi enviado" convidaria a reenviar e o professor receberia duas vezes. Procura o
        // rastro que a crm-whatsapp-send grava; sem rastro, trata como "pode ter saído".
        const { data: rastro } = await admin
          .from("crm_whatsapp_messages")
          .select("wa_message_id, status_entrega, erro")
          .eq("wa_account_id", crmContaId!)
          .eq("template_name", TEMPLATE_WA_AVALIACAO)
          .eq("direcao", "outbound")
          .eq("metadata->>enviado_por_id", user.id)
          .gte("created_at", inicio)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (rastro?.wa_message_id && rastro.status_entrega !== "failed") {
          wa.ok = true;
          wa.id = rastro.wa_message_id;
        } else if (rastro && rastro.status_entrega === "failed") {
          wa.erro = "a Meta recusou o envio";
        } else {
          wa.ok = true;
          waIncerto = true;
        }
      }
    }

    const resultado = {
      email: { tentado: email.tentado, ok: email.ok, para: email.para, erro: email.erro },
      whatsapp: { tentado: wa.tentado, ok: wa.ok, para: wa.para, erro: wa.erro, incerto: waIncerto },
    };

    // nada saiu ⇒ nada a registrar; a equipe pode simplesmente tentar de novo
    if (!email.ok && !wa.ok) {
      const partes = [
        email.tentado ? `e-mail: ${email.erro}` : null,
        wa.tentado ? `WhatsApp: ${wa.erro}` : null,
      ].filter(Boolean);
      return json({ erro: `Nada foi enviado — ${partes.join(" · ")}`, ...resultado }, 422);
    }

    // 7) registra DEPOIS de pelo menos um canal sair — nunca antes (senão grava envio que não saiu).
    // O WhatsApp "incerto" entra como possivelmente enviado (sem wa_message_id ⇒ o painel mostra
    // "aguardando confirmação"): errar para o lado de NÃO reenviar.
    const { error: errRegistro } = await admin.rpc("ped_aula_avaliacao_registrar_envio", {
      p_aula_id: aulaId,
      p_email: email.tentado ? email.para : null,
      p_nome: dossie.professor?.nome ?? null,
      p_nota: nota,
      p_total: total,
      p_comentarios: comentarios,
      p_user_id: user.id,
      p_gmail_id: email.id,
      p_whatsapp: wa.tentado ? wa.para : null,
      p_wa_message_id: wa.id,
      p_wa_erro: wa.tentado && !wa.ok ? wa.erro : null,
      p_email_erro: email.tentado && !email.ok ? email.erro : null,
      p_pdf_url: pdfUrl,
    });

    const avisos: string[] = [];
    // um canal saiu e o outro não: não é erro (reenviar tudo duplicaria o que saiu), mas a equipe
    // precisa saber QUAL faltou para reenviar só ele
    if (email.tentado && !email.ok) {
      avisos.push(`O WhatsApp saiu, mas o e-mail NÃO: ${email.erro}. Para reenviar só o e-mail, desmarque o WhatsApp.`);
    }
    if (wa.tentado && !wa.ok) {
      avisos.push(`O e-mail saiu, mas o WhatsApp NÃO: ${wa.erro}. Para reenviar só o WhatsApp, desmarque o e-mail.`);
    }
    if (waIncerto) {
      avisos.push(
        "O WhatsApp demorou a responder e não deu para confirmar se saiu. Ele ficou registrado como " +
          "enviado: confira com o professor antes de mandar de novo.",
      );
    }
    // ⚠️ Já SAIU — falhar aqui não pode virar erro (a equipe reenviaria e o professor receberia
    // duas vezes). Mas também não pode passar em SILÊNCIO: sem o registro, o painel não mostra
    // "já enviada Nx" e a auditoria do que o professor recebeu some.
    if (errRegistro) {
      console.error("[aval-enviar] registro falhou", aulaId, errRegistro.message);
      avisos.push(
        "A avaliação FOI enviada, mas o registro no histórico falhou — esta aula não vai aparecer " +
          "como 'já enviada'. Avise a TI antes de tentar de novo, para o professor não receber duas vezes.",
      );
    }

    return json({
      ok: true,
      para: email.ok ? email.para : null,
      comentarios_enviados: comentarios.length,
      ...resultado,
      ...(avisos.length ? { aviso: avisos.join(" ") } : {}),
    });
  } catch (e) {
    console.error("[aval-enviar] erro", String(e));
    return json({ erro: String(e) }, 500);
  }
});
