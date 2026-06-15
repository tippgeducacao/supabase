import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "professor-photos";

function scoreName(name: string): number {
  const n = name.toLowerCase();
  let s = 0;
  if (/(foto|perfil|avatar|profile|photo)/.test(n)) s += 100;
  if (/(cv|curriculo|currículo|contrato|termo|doc|documento|rg|cpf)/.test(n)) s -= 100;
  // prefer shorter / "principal" / numeric "1"
  if (/(principal|main|01|_1\.|-1\.)/.test(n)) s += 10;
  s -= Math.min(n.length, 50) / 10;
  return s;
}

function extFromMime(mime: string, fallbackName?: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
  };
  if (map[mime]) return map[mime];
  if (fallbackName) {
    const m = fallbackName.match(/\.([a-zA-Z0-9]+)$/);
    if (m) return m[1].toLowerCase();
  }
  return "jpg";
}

function extractFolderId(link: string): string | null {
  const m = link.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  const m2 = link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("GOOGLE_DRIVE_API_KEY");
    if (!apiKey) throw new Error("GOOGLE_DRIVE_API_KEY not configured");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Ensure bucket exists (public)
    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.find((b) => b.name === BUCKET)) {
      await supabase.storage.createBucket(BUCKET, { public: true });
    }

    const body = await req.json().catch(() => ({}));
    const professor_ids: string[] | undefined = body?.professor_ids;
    const force: boolean = !!body?.force;
    const limit: number | undefined = body?.limit;

    let query = supabase
      .from("ped_professores")
      .select("id, nome, pasta_link, foto_url, foto_import_status")
      .not("pasta_link", "is", null);

    if (professor_ids?.length) query = query.in("id", professor_ids);
    if (!force) {
      query = query.is("foto_url", null);
      query = query.is("foto_import_status", null);
    }
    if (limit) query = query.limit(limit);

    const { data: profs, error: profsErr } = await query;
    if (profsErr) throw profsErr;

    const updateStatus = async (id: string, status: string) => {
      await supabase.from("ped_professores").update({ foto_import_status: status }).eq("id", id);
    };

    const detalhes: any[] = [];
    let importadas = 0,
      sem_imagem = 0,
      link_invalido = 0,
      ja_tem_foto = 0,
      erros = 0;

    for (const p of profs ?? []) {
      try {
        if (!force && p.foto_url) {
          ja_tem_foto++;
          detalhes.push({ professor_id: p.id, nome: p.nome, ok: false, reason: "ja_tem_foto" });
          continue;
        }

        const folderId = extractFolderId(p.pasta_link as string);
        if (!folderId) {
          link_invalido++;
          detalhes.push({ professor_id: p.id, nome: p.nome, ok: false, reason: "link_invalido" });
          continue;
        }

        const listFolder = async (fid: string) => {
          const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
            `'${fid}' in parents and trashed=false`
          )}&fields=${encodeURIComponent("files(id,name,mimeType)")}&key=${apiKey}`;
          const res = await fetch(url);
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`drive_list_failed_${res.status}: ${text.slice(0, 200)}`);
          }
          const j = await res.json();
          return (j.files ?? []) as any[];
        };

        let rootFiles: any[];
        try {
          rootFiles = await listFolder(folderId);
        } catch (e: any) {
          erros++;
          detalhes.push({ professor_id: p.id, nome: p.nome, ok: false, reason: e?.message ?? String(e) });
          continue;
        }

        const FOLDER_MIME = "application/vnd.google-apps.folder";
        const PRIORITY_NAMES = ["DOCUMENTOS", "DOCS", "FOTOS", "PERFIL", "PESSOAL"];
        const subfolders = rootFiles.filter((f) => f.mimeType === FOLDER_MIME);
        subfolders.sort((a, b) => {
          const ap = PRIORITY_NAMES.includes((a.name ?? "").toUpperCase()) ? 0 : 1;
          const bp = PRIORITY_NAMES.includes((b.name ?? "").toUpperCase()) ? 0 : 1;
          return ap - bp;
        });

        const allFiles: any[] = rootFiles.filter((f) => (f.mimeType ?? "").startsWith("image/"));
        for (const sf of subfolders) {
          try {
            const subFiles = await listFolder(sf.id);
            for (const f of subFiles) {
              if ((f.mimeType ?? "").startsWith("image/")) allFiles.push(f);
            }
          } catch (_) {
            // ignora subpasta com erro
          }
        }

        const files = allFiles;

        if (!files.length) {
          sem_imagem++;
          await updateStatus(p.id, "no_image");
          detalhes.push({ professor_id: p.id, nome: p.nome, ok: false, reason: "sem_imagem" });
          continue;
        }

        files.sort((a, b) => scoreName(b.name) - scoreName(a.name));
        const chosen = files[0];

        const dlUrl = `https://www.googleapis.com/drive/v3/files/${chosen.id}?alt=media&key=${apiKey}`;
        const dlRes = await fetch(dlUrl);
        if (!dlRes.ok) {
          const text = await dlRes.text();
          erros++;
          detalhes.push({
            professor_id: p.id,
            nome: p.nome,
            ok: false,
            reason: `drive_download_failed_${dlRes.status}: ${text.slice(0, 200)}`,
          });
          continue;
        }
        const buf = new Uint8Array(await dlRes.arrayBuffer());
        const ext = extFromMime(chosen.mimeType, chosen.name);
        const path = `${p.id}/foto.${ext}`;

        const { error: upErr } = await supabase.storage
          .from(BUCKET)
          .upload(path, buf, { contentType: chosen.mimeType, upsert: true });
        if (upErr) {
          erros++;
          detalhes.push({
            professor_id: p.id,
            nome: p.nome,
            ok: false,
            reason: `upload_failed: ${upErr.message}`,
          });
          continue;
        }

        const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
        const foto_url = pub.publicUrl;

        const { error: updErr } = await supabase
          .from("ped_professores")
          .update({ foto_url, foto_import_status: "imported" })
          .eq("id", p.id);
        if (updErr) {
          erros++;
          detalhes.push({
            professor_id: p.id,
            nome: p.nome,
            ok: false,
            reason: `update_failed: ${updErr.message}`,
          });
          continue;
        }

        importadas++;
        detalhes.push({ professor_id: p.id, nome: p.nome, ok: true, reason: "ok", foto_url });
      } catch (e: any) {
        erros++;
        await updateStatus(p.id, "error");
        detalhes.push({
          professor_id: p.id,
          nome: p.nome,
          ok: false,
          reason: `exception: ${e?.message ?? String(e)}`,
        });
      }
    }

    return new Response(
      JSON.stringify({
        total: profs?.length ?? 0,
        importadas,
        sem_imagem,
        link_invalido,
        ja_tem_foto,
        erros,
        detalhes,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message ?? String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
