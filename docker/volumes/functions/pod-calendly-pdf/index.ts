// pod-calendly-pdf: gera o PDF do E-MAIL DE AGENDAMENTO do Calendly e o deixa pronto para anexar na tarefa do
// episódio no Gestor (09/11/2026; pedido da equipe: "o Pedagógico só registra e valida").
//
// Quem chama: SÓ o cron de 5 em 5 min (pg_cron). Ele se prova pelo segredo do Vault `pod_gravacao_cron_secret`
// no cabeçalho `x-pod-gravacao-cron-secret` (o MESMO do cron dos lembretes: a chave de serviço que o banco manda
// não é a do runtime, ver docs/SECURITY.md); a chave de serviço exata também passa (operação manual).
//
// O que faz a cada rodada: `pod_calendly_pdf_fila` entrega até 10 avisos do Calendly (novo/atualizado) de
// gravações ainda abertas que não têm PDF; cada um vira um PDF (render.ts), vai para o bucket PRIVADO
// `gt-doc-assets` (o link no formato antigo `…/object/public/…` abre pelo /arquivo-privado, com a sessão de quem
// está logado) e `pod_calendly_pdf_registrar` guarda o endereço e, se a gravação já tem tarefa, anexa. Gravação
// que ganha a tarefa DEPOIS (a validação cria a tarefa) recebe o PDF na rodada seguinte, por
// `pod_calendly_pdf_anexar_pendentes` (chamada no começo de cada rodada). Falha de um aviso não derruba os outros:
// o motivo fica em `pod_calendly_avisos.pdf_erro` e o aviso tenta de novo até 3 vezes.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
// mesma versão da edge generate-cronograma-aluno-pdf (4.2.1; até a 3.0.4 o build Node lê arquivo local pelo addImage)
import { jsPDF } from "npm:jspdf@4.2.1";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { montarPdfEmail, nomeArquivoPdf, type EmailParaPdf } from "./render.ts";

const FN = "pod-calendly-pdf";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PUBLIC_SUPABASE_URL = (Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site").replace(/\/+$/, "");
const BUCKET = "gt-doc-assets";
const POR_RODADA = 10;

/** getPublicUrl dentro do container devolve o host INTERNO do Kong; nem o navegador nem o /arquivo-privado o resolvem. */
const toPublicUrl = (u: string) => u.replace(/^https?:\/\/(supabase-)?kong:8000/i, PUBLIC_SUPABASE_URL);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

interface LinhaDaFila {
  aviso_id: string;
  agendamento_id: string;
  acao: string | null;
  assunto: string | null;
  de_nome: string | null;
  de_email: string | null;
  para: unknown;
  recebido_em: string | null;
  convidado_nome: string | null;
  body_html: string | null;
}

const paraEmail = (l: LinhaDaFila): EmailParaPdf => ({
  assunto: l.assunto,
  de_nome: l.de_nome,
  de_email: l.de_email,
  para: l.para,
  recebido_em: l.recebido_em,
  acao: l.acao,
  convidado_nome: l.convidado_nome,
  body_html: l.body_html,
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, erro: "Método não permitido" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });

  const segredoCron = req.headers.get("x-pod-gravacao-cron-secret");
  if (segredoCron) {
    const { data, error } = await admin.rpc("pod_gravacao_validar_cron", { p_segredo: segredoCron });
    if (error || data !== true) return json({ ok: false, erro: "Não autorizado" }, 401);
  } else {
    try {
      await exigirAcesso(req, { servico: true });
    } catch (e) {
      return respostaAcessoNegado(e, corsHeaders);
    }
  }

  // A tarefa pode ter nascido (na validação) DEPOIS de o PDF ficar pronto: anexa o que está pendente. É aqui, e não no
  // clique de Validar, de propósito: o Gestor só deixa vincular arquivo de bucket privado em contexto de serviço
  // (migration 20261031182000), e a sessão de quem valida não tem acesso ao original.
  const { data: anexados, error: erroAnexo } = await admin.rpc("pod_calendly_pdf_anexar_pendentes");
  if (erroAnexo) console.error(`[${FN}] anexar pendentes:`, erroAnexo.message);

  const { data: fila, error: erroFila } = await admin.rpc("pod_calendly_pdf_fila", { p_limite: POR_RODADA });
  if (erroFila) {
    console.error(`[${FN}] fila:`, erroFila.message);
    return json({ ok: false, erro: "falha ao ler a fila" }, 500);
  }

  const linhas = (fila ?? []) as LinhaDaFila[];
  let gerados = 0;
  let falhas = 0;
  for (const l of linhas) {
    try {
      const email = paraEmail(l);
      const bytes = montarPdfEmail({ jsPDF }, email);
      const caminho = `podcast-calendly/${l.aviso_id}.pdf`;
      const { error: erroUp } = await admin.storage.from(BUCKET).upload(caminho, bytes, {
        contentType: "application/pdf",
        upsert: true,
      });
      if (erroUp) throw new Error(`upload: ${erroUp.message}`);
      const url = toPublicUrl(admin.storage.from(BUCKET).getPublicUrl(caminho).data.publicUrl);
      const { error: erroReg } = await admin.rpc("pod_calendly_pdf_registrar", {
        p_aviso: l.aviso_id,
        p_url: url,
        p_nome: nomeArquivoPdf(email),
        p_tamanho: bytes.byteLength,
        p_erro: null,
      });
      if (erroReg) throw new Error(`registrar: ${erroReg.message}`);
      gerados++;
    } catch (e) {
      falhas++;
      const motivo = e instanceof Error ? e.message : String(e);
      console.error(`[${FN}] aviso ${l.aviso_id}:`, motivo);
      await admin.rpc("pod_calendly_pdf_registrar", {
        p_aviso: l.aviso_id, p_url: null, p_nome: null, p_tamanho: null, p_erro: motivo.slice(0, 300),
      });
    }
  }

  return json({ ok: true, fila: linhas.length, gerados, falhas, anexados_pendentes: typeof anexados === "number" ? anexados : 0 });
});
