// generate-cronograma-aluno-pdf
//
// O PDF do cronograma da TURMA, gerado na hora, para ir no cabeçalho de documento do D+1 da
// integração do aluno (int_aluno_01_boasvindas_cronograma, número do Suporte 3250) e para
// quem mais precisar do arquivo sem abrir o navegador. É o mesmo PDF que o Pedagógico e o
// comercial baixam (layout portado em ./render.ts, dados pelas mesmas RPCs em ./dados.ts).
//
// CONTRATO (detalhe em docs/CRM — Integração do Aluno.md, seção "PDF do cronograma"):
//
//   GET  [/<nome>.pdf]?turma_id=<uuid>[&v=<qualquer coisa>]  → os bytes do PDF (application/pdf,
//        inline) e o header X-Aulas-Futuras (aulas ao vivo de hoje em diante, ver ./dados.ts).
//        PÚBLICO, sem JWT: é o que o crm-whatsapp-send e a Meta baixam. Sem efeito colateral e
//        sem cache nenhum (decisão do Rafael): cada chamada lê o banco e gera de novo.
//        O caminho depois do nome da função é IGNORADO (o edge-runtime roteia pelo 1º segmento,
//        como no agendamentos-api): serve para pôr o nome do arquivo na URL, e o
//        crm-whatsapp-send tira dele o formato DOCUMENT (pela extensão) e o nome do card.
//        ⚠️ O `v` é ignorado aqui, mas quem manda por WhatsApp PRECISA dele, único por envio:
//        o crm-whatsapp-send guarda o media_id por URL durante 25 dias
//        (crm_whatsapp_media_cache), e uma URL fixa por turma mandaria o PDF da primeira
//        geração para todos os alunos da turma até o cache vencer.
//   HEAD igual ao GET, sem corpo: é a conferência que quem dispara faz antes de mandar.
//   POST { turma_id } ou { oportunidade_id }    → gera, grava no bucket público
//        `whatsapp-anexos` num caminho único e devolve { ok, url, filename, aulas_futuras, ... }.
//        Exige a chave de serviço do container (edge chamando edge) ou o JWT de um usuário
//        logado. Não serve para chamada do banco via pg_net: `_get_service_role_key()` do banco
//        é outra chave (docs/Infraestrutura e Deploy.md); o banco usa a URL do GET.
//
// ERROS (JSON { ok:false, code, error }) e por que 4xx é de propósito: o crm-whatsapp-send trata
// 4xx da origem como "arquivo não existe", ABORTA o envio (422 anexo_indisponivel) e abre alerta
// crítico em Saúde da conta. É o certo para turma inexistente, sem cronograma ou banco sem a
// migration: melhor não mandar do que mandar PDF vazio. Falha transitória é 5xx, que ele trata
// mandando por link.
// ⚠️ Mesmo assim o 4xx NÃO deve chegar ao crm-whatsapp-send: o alerta dele agrupa pela URL, e
// com o `v` único cada aluno abriria um alerta crítico separado. Quem dispara confere ANTES
// (POST, ou HEAD na mesma URL) e só manda com 200 e aulas futuras > 0; o resto é o D+1 sem anexo.
//   400 turma_id_invalido · oportunidade_id_invalido · parametro_ausente
//   401 nao_autorizado (só POST)
//   404 turma_nao_encontrada · turma_nao_identificada (POST por oportunidade: sem turma, ou
//       ambígua) · oportunidade_nao_encontrada (POST: o id não existe, erro de quem chamou)
//   422 sem_cronograma (turma sem aula ao vivo publicada)
//   424 rpc_sem_acesso (migration 20260911223000, ou a 20260911222900 no POST por
//       oportunidade, não aplicada: as RPCs voltam vazias para a chave de serviço, ver ./dados.ts)
//   500 erro_interno
//
// Por que a função é pública sem config: no self-hosted o edge-runtime NÃO lê o config.toml; o
// JWT é decidido pela VERIFY_JWT global do container (false) e o Kong não pede apikey em
// /functions/v1/*. A entrada no config.toml só documenta a intenção. O POST se protege sozinho.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
// 4.2.1 e não a 3.0.4 do front: o build Node do jsPDF (o que o `npm:` resolve) até a 3.0.4 lê
// arquivo LOCAL quando addImage/addFont/html recebem caminho (CVE-2025-68428), e esta função é
// pública e roda com a chave de serviço no ambiente. A 4.2.1 fecha também as de 4.0 a 4.2.0.
import { jsPDF } from "npm:jspdf@4.2.1";
// Import NOMEADO: o default do jspdf-autotable quebra o deno check (TS2322).
import { autoTable } from "npm:jspdf-autotable@5.0.8";
import { carregarCronograma, turmaDaOportunidade, type Admin, type CronogramaCarregado, type Falha } from "./dados.ts";
import { nomeArquivoAscii, renderCronogramaAlunoPdf, type PdfGerado } from "./render.ts";

const FN = "generate-cronograma-aluno-pdf";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PUBLIC_SUPABASE_URL = (Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site").replace(/\/+$/, "");
/** Bucket público da mídia de WhatsApp (50 MB, sem restrição de tipo). */
const BUCKET = "whatsapp-anexos";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  // o navegador só lê o nome do arquivo (e as aulas futuras) se o header estiver exposto
  "Access-Control-Expose-Headers": "Content-Disposition, Content-Length, X-Aulas-Futuras",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      // erro também não pode ficar guardado no Cloudflare nem na Meta
      "Cache-Control": "no-store, max-age=0",
      ...extra,
    },
  });
}

const responderFalha = (f: Falha) => json({ ok: false, code: f.code, error: f.error }, f.status);

/**
 * getPublicUrl dentro do container devolve o host INTERNO do Kong (http://kong:8000 ou
 * http://supabase-kong:8000), que nem a Meta nem o navegador resolvem. Mesma pegadinha do
 * crm-webchat e do assistente-interno-whatsapp.
 */
const toPublicUrl = (u: string) => u.replace(/^https?:\/\/(supabase-)?kong:8000/i, PUBLIC_SUPABASE_URL);

/** Valor de `filename*` (RFC 5987): UTF-8 percent-encoded, inclusive os que o encodeURIComponent deixa passar. */
const rfc5987 = (s: string) =>
  encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Nome de arquivo para o caminho no Storage: ASCII, minúsculo, sem espaço. */
const slug = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\.pdf$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "cronograma";

/** Comparação em tempo constante (a chave de serviço não pode vazar por tempo de resposta). */
function iguaisTempoConstante(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

let adminCache: Admin | null = null;
function adminClient(): Admin {
  if (!adminCache) {
    adminCache = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    }) as Admin;
  }
  return adminCache;
}

type Gerado = { ok: true; dados: CronogramaCarregado; pdf: PdfGerado };

async function gerarPdf(admin: Admin, turmaId: string, via: string): Promise<Gerado | Falha> {
  const t0 = performance.now();
  const dados = await carregarCronograma(admin, turmaId);
  if (!dados.ok) {
    console.warn(`[${FN}] ${via} turma=${turmaId} → ${dados.status} ${dados.code}`);
    return dados;
  }
  const pdf = renderCronogramaAlunoPdf(
    { jsPDF, autoTable },
    { turma: dados.turma, aulas: dados.aulas, praticos: dados.praticos, marca: dados.marca },
  );
  console.log(JSON.stringify({
    fn: FN,
    via,
    turma_id: turmaId,
    marca: pdf.marca,
    bytes: pdf.bytes.length,
    paginas: pdf.paginas,
    aulas_ao_vivo: dados.contagem.aoVivo,
    aulas_futuras: dados.contagem.aoVivoFuturas,
    modulos_ead: dados.contagem.ead,
    praticos: dados.contagem.praticos,
    ms: (performance.now() - t0).toFixed(2),
  }));
  return { ok: true, dados, pdf };
}

function respostaPdf(pdf: PdfGerado, aulasFuturas: number, semCorpo: boolean): Response {
  const headers: Record<string, string> = {
    ...corsHeaders,
    "Content-Type": "application/pdf",
    "Content-Length": String(pdf.bytes.length),
    // valor de header é ByteString: acento só dentro do filename* (percent-encoded)
    "Content-Disposition":
      `inline; filename="${nomeArquivoAscii(pdf.nomeArquivo)}"; filename*=UTF-8''${rfc5987(pdf.nomeArquivo)}`,
    // gerado na hora, sem cache: nem Cloudflare, nem navegador, nem a Meta guardam
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    // a conferência de quem dispara: 0 = turma sem aula ao vivo daqui para a frente, D+1 sem anexo
    "X-Aulas-Futuras": String(aulasFuturas),
  };
  return new Response(semCorpo ? null : pdf.bytes, { status: 200, headers });
}

async function servirPdf(req: Request): Promise<Response> {
  // Só a query importa: o caminho depois do nome da função (o nome do arquivo) é ignorado.
  const turmaId = (new URL(req.url).searchParams.get("turma_id") ?? "").trim();
  if (!UUID_RE.test(turmaId)) {
    return json({ ok: false, code: "turma_id_invalido", error: "informe turma_id (uuid) na query" }, 400);
  }
  const r = await gerarPdf(adminClient(), turmaId, req.method);
  if (!r.ok) return responderFalha(r);
  return respostaPdf(r.pdf, r.dados.contagem.aoVivoFuturas, req.method === "HEAD");
}

/** POST: chave de serviço do container (edge→edge) ou JWT de usuário logado. */
async function autorizado(req: Request, admin: Admin): Promise<boolean> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  if (SERVICE_ROLE && iguaisTempoConstante(token, SERVICE_ROLE)) return true;
  try {
    const { data, error } = await admin.auth.getUser(token);
    return !error && !!data?.user;
  } catch {
    return false;
  }
}

async function gerarEGuardar(req: Request): Promise<Response> {
  const admin = adminClient();
  if (!(await autorizado(req, admin))) {
    return json({ ok: false, code: "nao_autorizado", error: "envie a chave de serviço ou o JWT de um usuário logado" }, 401);
  }

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try {
    body = await req.json();
  } catch { /* corpo vazio ou inválido: cai no parametro_ausente */ }
  const turmaIdIn = typeof body?.turma_id === "string" ? body.turma_id.trim() : "";
  const oportunidadeId = typeof body?.oportunidade_id === "string" ? body.oportunidade_id.trim() : "";

  // turma_id vale mais que oportunidade_id quando vêm os dois: é o dado mais direto.
  let turmaId: string;
  let origem: string;
  if (turmaIdIn) {
    if (!UUID_RE.test(turmaIdIn)) return json({ ok: false, code: "turma_id_invalido", error: "turma_id não é um uuid" }, 400);
    turmaId = turmaIdIn;
    origem = "parametro";
  } else if (oportunidadeId) {
    if (!UUID_RE.test(oportunidadeId)) {
      return json({ ok: false, code: "oportunidade_id_invalido", error: "oportunidade_id não é um uuid" }, 400);
    }
    const r = await turmaDaOportunidade(admin, oportunidadeId);
    if (!r.ok) return responderFalha(r);
    turmaId = r.turmaId;
    origem = r.origem;
  } else {
    return json({ ok: false, code: "parametro_ausente", error: "informe turma_id ou oportunidade_id" }, 400);
  }

  const g = await gerarPdf(admin, turmaId, "POST");
  if (!g.ok) return responderFalha(g);
  const { dados, pdf } = g;

  // Caminho ÚNICO por geração: o cache de media_id do crm-whatsapp-send (por URL, 25 dias)
  // nunca devolve uma versão velha, e fica a cópia congelada do que foi mandado ao aluno.
  const agora = new Date();
  const dia = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(agora);
  const path = `cronograma-aluno/${turmaId}/${dia}/${agora.getTime()}-${slug(pdf.nomeArquivo)}.pdf`;
  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, pdf.bytes, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (upErr) {
    console.error(`[${FN}] upload falhou (${path}):`, upErr.message);
    return json({ ok: false, code: "erro_interno", error: "não foi possível gravar o PDF no Storage" }, 500);
  }

  const url = toPublicUrl(admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl);
  // Nunca devolver host interno: a Meta baixaria de um endereço que não existe lá fora.
  if (!url.startsWith(`${PUBLIC_SUPABASE_URL}/`)) {
    console.error(`[${FN}] URL pública inesperada (${url}); confira PUBLIC_SUPABASE_URL do container.`);
    return json({ ok: false, code: "erro_interno", error: "URL pública do Storage fora do host público" }, 500);
  }

  return json({
    ok: true,
    url,
    turma_id: turmaId,
    bytes: pdf.bytes.length,
    path,
    bucket: BUCKET,
    filename: pdf.nomeArquivo,
    turma_nome: dados.turma.nome,
    curso: dados.turma.pos?.nome ?? null,
    marca: pdf.marca,
    paginas: pdf.paginas,
    aulas: dados.contagem.aoVivo,
    // 0 = sem aula ao vivo daqui para a frente: quem dispara o D+1 manda sem anexo
    aulas_futuras: dados.contagem.aoVivoFuturas,
    modulos_ead: dados.contagem.ead,
    praticos: dados.contagem.praticos,
    origem_turma: origem,
    gerado_em: agora.toISOString(),
    // o mesmo cronograma, sempre atual, com o nome do arquivo no caminho (lembrar do &v= único
    // por envio, ver o topo)
    url_ao_vivo: `${PUBLIC_SUPABASE_URL}/functions/v1/${FN}/${encodeURIComponent(pdf.nomeArquivo)}?turma_id=${turmaId}`,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (req.method === "GET" || req.method === "HEAD") return await servirPdf(req);
    if (req.method === "POST") return await gerarEGuardar(req);
    return json({ ok: false, code: "metodo_nao_permitido", error: "use GET, HEAD ou POST" }, 405, {
      Allow: "GET, HEAD, POST, OPTIONS",
    });
  } catch (e) {
    console.error(`[${FN}] erro inesperado:`, e instanceof Error ? e.stack ?? e.message : e);
    return json({ ok: false, code: "erro_interno", error: "falha ao gerar o cronograma" }, 500);
  }
});
