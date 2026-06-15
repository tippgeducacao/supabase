// Extrai blueprint (módulos + aulas) de um PDF de PPC usando Lovable AI Gateway (Gemini).
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

const SYSTEM_PROMPT = `Você é um assistente que extrai a grade curricular de PDFs de Projeto Pedagógico de Curso (PPC) de pós-graduação veterinária.
Analise o PDF e devolva APENAS um JSON válido (sem texto extra, sem markdown) seguindo exatamente este schema:

{
  "modulos": [
    {
      "modulo_numero": 1,
      "modulo_nome": "Nome do módulo",
      "aulas": [
        { "titulo": "Título da aula", "ementa": "Resumo/ementa em 1-3 frases", "ordem_no_modulo": 1, "duracao_minutos": 180 }
      ]
    }
  ]
}

Regras:
- modulo_numero: sequencial começando em 1, na ordem em que aparecem no PDF.
- ordem_no_modulo: sequencial dentro de cada módulo começando em 1.
- duracao_minutos: use o valor declarado no PDF; se não houver, use 180.
- Não invente conteúdo. Se o PDF não tiver módulos claros, agrupe as aulas em um único módulo "Conteúdo programático".
- Mantenha títulos e ementas em português.
- Retorne SOMENTE o JSON.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY ausente");

    const contentType = req.headers.get("content-type") || "";
    let pdfBytes: Uint8Array | null = null;
    let filename = "documento.pdf";

    if (contentType.includes("multipart/form-data")) {
      const fd = await req.formData();
      const f = fd.get("file");
      if (f instanceof File) {
        pdfBytes = new Uint8Array(await f.arrayBuffer());
        filename = f.name;
      }
    } else if (contentType.includes("application/json")) {
      const body = await req.json().catch(() => ({}));
      if (body?.base64) {
        const bin = atob(body.base64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        pdfBytes = arr;
        filename = body.filename ?? filename;
      }
    }

    if (!pdfBytes || pdfBytes.byteLength === 0) {
      return new Response(JSON.stringify({ ok: false, error: "Nenhum PDF recebido." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // base64 do PDF (em chunks para evitar stack overflow)
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < pdfBytes.length; i += chunk) {
      binary += String.fromCharCode(...pdfBytes.subarray(i, i + chunk));
    }
    const b64 = btoa(binary);
    const dataUrl = `data:application/pdf;base64,${b64}`;

    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: `Arquivo: ${filename}. Extraia a grade conforme o schema.` },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!aiResp.ok) {
      const txt = await aiResp.text();
      return new Response(JSON.stringify({ ok: false, error: `AI Gateway ${aiResp.status}: ${txt}` }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiJson = await aiResp.json();
    const content: string = aiJson?.choices?.[0]?.message?.content ?? "{}";

    let parsed: any = {};
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch { /* ignore */ } }
    }

    const modulos = Array.isArray(parsed?.modulos) ? parsed.modulos : [];

    return new Response(JSON.stringify({ ok: true, filename, modulos }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
