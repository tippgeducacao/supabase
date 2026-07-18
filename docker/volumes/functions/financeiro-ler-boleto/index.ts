// financeiro-ler-boleto
// Recebe uma FOTO (image/*) ou um PDF de boleto/pagamento e devolve os campos estruturados
// (valor, vencimento, beneficiário, linha digitável, código de barras, descrição…) via Gemini.
// O Gemini lê imagem E PDF nativamente (inlineData), então um caminho único cobre os dois.
// Clonado de extract-pdf-blueprint + padrão de chave de mimosa-analise (ai_api_keys → env).
// Deploy: git push (deploy-edges.yml), NUNCA Deploy do Dokploy.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_TIMEOUT_MS = 60_000;
const MAX_BYTES = 20 * 1024 * 1024; // 20MB (Gemini inline ~aguenta; boleto é pequeno)

const SYSTEM_PROMPT = `Você extrai os dados de um BOLETO ou comprovante de pagamento brasileiro (imagem ou PDF).
Devolva APENAS um JSON válido (sem markdown, sem texto extra) exatamente neste schema:

{
  "valor": 1234.56,               // valor A PAGAR em reais, número (ponto decimal). null se não achar.
  "vencimento": "2026-07-31",     // data de vencimento em YYYY-MM-DD. null se não houver.
  "beneficiario": "Nome de quem RECEBE",   // cedente/favorecido. null se não achar.
  "pagador": "Nome de quem PAGA",          // sacado/pagador. null se não achar.
  "documento": "número do documento/nosso número", // null se não achar.
  "linha_digitavel": "APENAS dígitos, sem espaços/pontos",  // null se não houver.
  "codigo_barras": "APENAS dígitos",       // null se não houver.
  "banco_emissor": "Banco que emitiu o boleto (informativo)", // null se não achar.
  "descricao": "resumo curto do que é o pagamento"  // 1 frase. null se não der pra inferir.
}

Regras:
- valor: só o valor a pagar (não some juros/multa a menos que já estejam no "valor cobrado"/"valor do documento"). Número puro, ex.: 3907.75.
- Datas SEMPRE em YYYY-MM-DD. Converta dd/mm/aaaa.
- linha_digitavel e codigo_barras: SOMENTE os dígitos (remova pontos, espaços e a barra).
- Não invente. Campo não encontrado = null.
- Retorne SOMENTE o JSON.`;

function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

// Chave do Google: ai_api_keys(google) é a fonte de verdade (a env GEMINI/GOOGLE já veio inválida antes).
async function getGoogleKey(): Promise<string | null> {
  try {
    const { data } = await adminClient()
      .from("ai_api_keys")
      .select("api_key")
      .eq("provider", "google")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.api_key) return data.api_key as string;
  } catch (_) { /* fallback */ }
  return Deno.env.get("GOOGLE_API_KEY") || Deno.env.get("GEMINI_API_KEY") || null;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout (${label}) após ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function guessMime(name: string, fallback = "application/octet-stream"): string {
  const n = name.toLowerCase();
  if (n.endsWith(".pdf")) return "application/pdf";
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  return fallback;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const contentType = req.headers.get("content-type") || "";
    let bytes: Uint8Array | null = null;
    let mimeType = "";
    let filename = "boleto";

    if (contentType.includes("multipart/form-data")) {
      const fd = await req.formData();
      const f = fd.get("file");
      if (f instanceof File) {
        bytes = new Uint8Array(await f.arrayBuffer());
        filename = f.name || filename;
        mimeType = f.type || guessMime(filename);
      }
    } else {
      const body = await req.json().catch(() => ({} as any));
      if (body?.base64) {
        // aceita "data:...;base64,XXXX" ou base64 cru
        const raw = String(body.base64).replace(/^data:[^;]+;base64,/, "");
        const bin = atob(raw);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        bytes = arr;
        filename = body.filename ?? filename;
        mimeType = body.mimeType || guessMime(filename, "image/jpeg");
      }
    }

    if (!bytes || bytes.byteLength === 0) {
      return json({ ok: false, error: "Nenhum arquivo recebido (envie foto ou PDF do boleto)." }, 400);
    }
    if (bytes.byteLength > MAX_BYTES) {
      return json({ ok: false, error: `Arquivo muito grande (${Math.round(bytes.byteLength / 1024 / 1024)}MB).` }, 413);
    }
    if (!mimeType) mimeType = guessMime(filename, "image/jpeg");

    const apiKey = await getGoogleKey();
    if (!apiKey) return json({ ok: false, error: "Chave do Google (Gemini) não configurada em ai_api_keys." }, 500);

    const b64 = bytesToBase64(bytes);

    const aiRes = await withTimeout(
      fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{
            role: "user",
            parts: [
              { text: `Arquivo: ${filename}. Extraia os campos do boleto conforme o schema.` },
              { inlineData: { mimeType, data: b64 } },
            ],
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048, responseMimeType: "application/json" },
        }),
      }),
      GEMINI_TIMEOUT_MS,
      "gemini",
    );

    if (!aiRes.ok) {
      const txt = await aiRes.text();
      console.error("financeiro-ler-boleto Gemini error:", aiRes.status, txt.slice(0, 300));
      // 422 (nunca 502/504): o Cloudflare engole 502/504 da origem sem headers CORS.
      return json({ ok: false, error: `Erro Gemini ${aiRes.status}: ${txt.slice(0, 200)}` }, 422);
    }

    const data = await aiRes.json();
    const content: string =
      data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") ?? "{}";

    let parsed: any = {};
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch { /* ignore */ } }
    }

    const num = (v: any) => {
      if (typeof v === "number" && isFinite(v)) return v;
      if (typeof v === "string") {
        const n = parseFloat(v.replace(/[^\d.,-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
        return isFinite(n) ? n : null;
      }
      return null;
    };
    const str = (v: any) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const digits = (v: any) => (typeof v === "string" ? v.replace(/\D/g, "") || null : null);

    const dados = {
      valor: num(parsed.valor),
      vencimento: str(parsed.vencimento),
      beneficiario: str(parsed.beneficiario),
      pagador: str(parsed.pagador),
      documento: str(parsed.documento),
      linha_digitavel: digits(parsed.linha_digitavel),
      codigo_barras: digits(parsed.codigo_barras),
      banco_emissor: str(parsed.banco_emissor),
      descricao: str(parsed.descricao),
    };

    return json({ ok: true, filename, mimeType, dados });
  } catch (e) {
    const msg = (e as Error)?.message || "Erro desconhecido";
    const isTimeout = /Timeout/i.test(msg);
    return json({ ok: false, error: msg }, isTimeout ? 422 : 500);
  }
});
