// acesso: publico — cadastro pelo LINK ÚNICO (/embaixador/cadastro, sem código) só com o interruptor ligado na gestão, Turnstile fail-closed e freio por IP; convite pessoal, nova senha e confirmar e-mail são por token de uso único (32 bytes, só o hash SHA-256 no banco); o "esqueci" só manda e-mail a embaixador com conta e no máximo 1 a cada 10 min. As ações minha_foto e trocar_foto exigem o token de uma conta 'embaixador' (conferido no Auth) e só mexem na foto dela.
//
// Edge Function: emb-cadastro-publico — Programa de Embaixadores (23/11/2026).
// 24/11/2026: o cadastro aberto é um LINK ÚNICO, /embaixador/cadastro (sem código), que a gestão pausa e
// liga (emb_link_cadastro). O convite pessoal continua com código (?c=…).
// O embaixador abre o link, preenche o cadastro com a foto, aceita o
// termo e cria a senha. A conta nasce no Auth com role = 'embaixador' (só alcança /rpc/emb_portal_*)
// e SEM profile. Também: confirmar o e-mail, criar nova senha e "esqueci a senha".
// Nunca toca em conta de colaborador nem da IES. Ver docs/Embaixadores.md.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { problemaDaSenha } from "../_shared/senhaForte.ts";
import {
  apelidoDoNome, dadosNormalizados, fotoDoDataUrl, validarCadastro, type CadastroEmbaixador,
} from "../_shared/embaixadorCadastro.ts";
import {
  emailValido, enviarEmailDoEmbaixador, hashToken, ipDoPedido, linkDoToken, novoToken, origemDoPortal,
  VALIDADE_CONFIRMAR_EMAIL_MS, VALIDADE_NOVA_SENHA_MS,
} from "../_shared/embaixadores.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Corpo {
  acao?: "conferir" | "cadastrar" | "confirmar_email" | "criar_senha" | "esqueci" | "minha_foto" | "trocar_foto";
  token?: string;
  dados?: CadastroEmbaixador;
  senha?: string;
  foto?: string;
  email?: string;
  turnstile_token?: string;
}

interface Convite {
  id: string; motivo: "cadastro" | "convite" | "nova_senha" | "confirmar_email"; embaixador_id: string | null;
  usos: number; usos_max: number | null; expira_em: string | null; ativo: boolean;
}

// O link assinado sai com o host interno (kong:8000): troca pela origem pública (a assinatura não depende dele).
const API_PUBLICA = (Deno.env.get("SUPABASE_PUBLIC_URL") || Deno.env.get("PUBLIC_SUPABASE_URL") || "https://api.ppgeducacao.site")
  .replace(/\/$/, "");
const linkPublico = (assinado: string) => assinado.replace(/^https?:\/\/[^/]+/, API_PUBLICA);

const LINK_INVALIDO = "Este link não vale mais. Peça um novo à equipe do Programa de Embaixadores.";
const LINK_PAUSADO = "As inscrições para o Programa de Embaixadores estão pausadas no momento. Tente de novo mais tarde.";
// Mesmo widget do Turnstile da agenda e da página pública (mesmo domínio): src/lib/agendaLeadPublica.ts.
const CHAVE_TURNSTILE = "AGENDA_LEAD_TURNSTILE_SECRET";

// ── Freio por IP do link único (em memória, por worker): 5 cadastros a cada 10 min ──────────────────
const JANELA_MS = 10 * 60_000;
const baldeCadastro = new Map<string, { n: number; ate: number }>();
function dentroDoLimite(ip: string): boolean {
  const agora = Date.now();
  if (baldeCadastro.size > 5000) for (const [k, v] of baldeCadastro) if (agora > v.ate) baldeCadastro.delete(k);
  const t = baldeCadastro.get(ip);
  if (!t || agora > t.ate) { baldeCadastro.set(ip, { n: 1, ate: agora + JANELA_MS }); return true; }
  t.n += 1;
  return t.n <= 5;
}
const IP_PRIVADO_RE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:)/i;
function ipDe(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  let ip = cf ? cf.trim() : "";
  if (!ip) {
    const partes = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (let i = partes.length - 1; i >= 0 && !ip; i--) if (!IP_PRIVADO_RE.test(partes[i])) ip = partes[i];
    if (!ip) ip = partes[partes.length - 1] ?? "";
  }
  return ip ? ip.slice(0, 45) : "desconhecido";
}

// ── Turnstile (fail-closed: sem segredo, sem token, recusado ou Cloudflare muda = não cadastra) ───────
// deno-lint-ignore no-explicit-any
async function segredoTurnstile(admin: any): Promise<string> {
  try {
    const { data } = await admin.from("app_secrets").select("valor").eq("chave", CHAVE_TURNSTILE).maybeSingle();
    const v = String(data?.valor ?? "").trim();
    if (v) return v;
  } catch { /* cai no env */ }
  return (Deno.env.get(CHAVE_TURNSTILE) ?? "").trim();
}
async function turnstileOk(segredo: string, token: string, ip: string): Promise<boolean> {
  if (!segredo || !token) return false;
  try {
    const form = new URLSearchParams({ secret: segredo, response: token });
    if (ip && ip !== "desconhecido") form.set("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(),
      signal: AbortSignal.timeout(6000),
    });
    return (await res.json())?.success === true;
  } catch (e) {
    console.error(`[emb-cadastro-publico] siteverify não respondeu: ${(e as Error).message}`);
    return false;
  }
}
/** E-mail como padrão do ilike: `_` e `%` são curingas e casariam outro endereço. */
const literalIlike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  try {
    const corpo = (await req.json().catch(() => ({}))) as Corpo;
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const origem = origemDoPortal(req.headers.get("origin"));
    const registrar = (embaixadorId: string | null, quem: string, acao: string, detalhe?: Record<string, unknown>) =>
      admin.from("emb_registros").insert({ embaixador_id: embaixadorId, quem, acao, detalhe: detalhe ?? {} });

    /** Convite que vale AGORA pelo token. */
    const conviteDoToken = async (token: string | undefined): Promise<Convite | null> => {
      const t = (token ?? "").trim();
      if (t.length < 30 || t.length > 100) return null;
      const { data } = await admin.from("emb_convites")
        .select("id, motivo, embaixador_id, usos, usos_max, expira_em, ativo")
        .eq("token_hash", await hashToken(t)).maybeSingle();
      const c = data as Convite | null;
      if (!c || !c.ativo) return null;
      if (c.expira_em && new Date(c.expira_em).getTime() < Date.now()) return null;
      if (c.motivo === "cadastro") return c.usos_max === null || c.usos < c.usos_max ? c : null;
      return c.usos === 0 ? c : null;
    };

    const termoVigente = async () => {
      const { data } = await admin.from("emb_termos").select("versao, texto")
        .lte("vigente_desde", new Date().toISOString().slice(0, 10))
        .order("vigente_desde", { ascending: false }).limit(1).maybeSingle();
      return data as { versao: string; texto: string } | null;
    };

    const embaixadorDoConvite = async (c: Convite) => {
      if (!c.embaixador_id) return null;
      const { data } = await admin.from("emb_embaixadores")
        .select("id, user_id, nome, email, status").eq("id", c.embaixador_id).maybeSingle();
      return data as null | { id: string; user_id: string | null; nome: string; email: string; status: string };
    };

    // ---------------------------------------------------------------------------------------------
    // Foto do perfil do embaixador logado (26/11/2026). O Storage é privado e o papel 'embaixador' não o
    // alcança: a conta é conferida aqui pelo token e só mexe na própria linha.
    if (corpo.acao === "minha_foto" || corpo.acao === "trocar_foto") {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      const { data: quem } = token ? await admin.auth.getUser(token) : { data: { user: null } };
      const conta = quem?.user as { id: string; role?: string } | null | undefined;
      if (!conta || conta.role !== "embaixador") return json({ error: "Entre na sua conta de embaixador." }, 401);
      const { data: linhaEmb } = await admin.from("emb_embaixadores")
        .select("id, status, foto_path").eq("user_id", conta.id).maybeSingle();
      const emb = linhaEmb as { id: string; status: string; foto_path: string | null } | null;
      if (!emb || !["onboarding", "ativo", "encerrado"].includes(emb.status)) return json({ error: "Seu acesso ao painel não está ativo." }, 403);

      let caminho = emb.foto_path;
      if (corpo.acao === "trocar_foto") {
        if (emb.status === "encerrado") return json({ error: "A participação foi encerrada: o perfil fica só para consulta." }, 403);
        const nova = fotoDoDataUrl(corpo.foto);
        if (!nova) return json({ error: "Envie uma foto de rosto (JPG ou PNG, até 1,5 MB)." }, 400);
        const extensao = nova.mime === "image/png" ? "png" : nova.mime === "image/webp" ? "webp" : "jpg";
        caminho = `${emb.id}/perfil-${Date.now()}.${extensao}`;
        const conteudo = Uint8Array.from(atob(nova.base64), (ch) => ch.charCodeAt(0));
        const { error: erroEnvio } = await admin.storage.from("emb-fotos").upload(caminho, conteudo, { contentType: nova.mime, upsert: false });
        if (erroEnvio) return json({ error: "Não foi possível guardar a foto. Tente de novo." }, 500);
        const { error: erroLinha } = await admin.from("emb_embaixadores")
          .update({ foto_path: caminho, atualizado_em: new Date().toISOString() }).eq("id", emb.id);
        if (erroLinha) {
          await admin.storage.from("emb-fotos").remove([caminho]);
          return json({ error: "Não foi possível gravar a foto. Tente de novo." }, 500);
        }
        await registrar(emb.id, "embaixador", "trocou_foto");
      }
      if (!caminho) return json({ ok: true, foto_url: null });
      const { data: assinado } = await admin.storage.from("emb-fotos").createSignedUrl(caminho, 3600);
      return json({ ok: true, foto_url: assinado?.signedUrl ? linkPublico(assinado.signedUrl) : null });
    }

    // ---------------------------------------------------------------------------------------------
    if (corpo.acao === "conferir") {
      // Link único (sem código): vale enquanto a gestão deixar ligado.
      if (!String(corpo.token ?? "").trim()) {
        const { data: ligado } = await admin.rpc("emb_link_cadastro_ligado");
        if (ligado !== true) return json({ error: LINK_PAUSADO, pausado: true }, 410);
        return json({ ok: true, motivo: "cadastro", unico: true, nome: null, email: null, termo: await termoVigente() });
      }
      const c = await conviteDoToken(corpo.token);
      if (!c) return json({ error: LINK_INVALIDO }, 410);
      const emb = await embaixadorDoConvite(c);
      if (c.motivo === "convite" && emb?.status !== "convidado") return json({ error: LINK_INVALIDO }, 410);
      const precisaTermo = c.motivo === "cadastro" || c.motivo === "convite";
      return json({
        ok: true,
        motivo: c.motivo,
        nome: emb?.nome ?? null,
        email: emb?.email ?? null,
        termo: precisaTermo ? await termoVigente() : null,
      });
    }

    // ---------------------------------------------------------------------------------------------
    if (corpo.acao === "cadastrar") {
      const unico = !String(corpo.token ?? "").trim();
      let c: Convite | null = null;
      if (unico) {
        // Link único: interruptor ligado, freio por IP e Turnstile, nesta ordem (o barato primeiro).
        const ip = ipDe(req);
        if (!dentroDoLimite(ip)) return json({ error: "Muitas tentativas. Aguarde alguns minutos." }, 429);
        const { data: ligado } = await admin.rpc("emb_link_cadastro_ligado");
        if (ligado !== true) return json({ error: LINK_PAUSADO, pausado: true }, 410);
        if (!(await turnstileOk(await segredoTurnstile(admin), String(corpo.turnstile_token ?? ""), ip))) {
          return json({ error: "Não foi possível confirmar a verificação de segurança. Tente de novo." }, 403);
        }
      } else {
        c = await conviteDoToken(corpo.token);
        if (!c || (c.motivo !== "cadastro" && c.motivo !== "convite")) return json({ error: LINK_INVALIDO }, 410);
      }
      const pessoal = c?.motivo === "convite";
      const embConvidado = pessoal && c ? await embaixadorDoConvite(c) : null;
      if (pessoal && (!embConvidado || embConvidado.status !== "convidado")) return json({ error: LINK_INVALIDO }, 410);

      const dados = { ...(corpo.dados ?? {}) } as CadastroEmbaixador;
      if (pessoal) { dados.email = embConvidado!.email; dados.email_confirmacao = embConvidado!.email; }
      const erros = validarCadastro(dados, { pessoal });
      const problemaSenha = problemaDaSenha(corpo.senha);
      if (problemaSenha) erros.senha = problemaSenha;
      const foto = fotoDoDataUrl(corpo.foto);
      if (!foto) erros.foto = "Envie uma foto de rosto (JPG ou PNG, até 1,5 MB).";
      if (Object.keys(erros).length) return json({ error: "Confira os campos destacados.", erros }, 400);
      const n = dadosNormalizados(dados);

      // E-mail não pode ser de colaborador, de conta da IES nem de outro embaixador.
      const checar = async (tabela: string, coluna: string) => {
        const { data, error } = await admin.from(tabela).select(coluna).ilike("email", literalIlike(n.email)).limit(1);
        if (error) throw new Error("Não foi possível conferir o e-mail. Tente de novo.");
        return (data ?? []) as Array<Record<string, string>>;
      };
      if ((await checar("profiles", "id")).length) {
        return json({ error: "Este e-mail é de um colaborador da PPGVET. Use um e-mail pessoal.", erros: { email: "E-mail de colaborador." } }, 409);
      }
      if ((await checar("ies_portal_usuarios", "user_id")).length) {
        return json({ error: "Este e-mail já tem outro acesso na PPGVET. Use outro e-mail.", erros: { email: "E-mail já usado." } }, 409);
      }
      const outros = (await checar("emb_embaixadores", "id")).filter((r) => r.id !== embConvidado?.id);
      if (outros.length) {
        return json({ error: "Este e-mail já tem cadastro no programa. Entre pelo painel ou peça ajuda à equipe.", erros: { email: "E-mail já cadastrado." } }, 409);
      }

      const termo = await termoVigente();
      if (!termo) return json({ error: "O termo do programa não está disponível. Avise a equipe do programa." }, 503);

      // Reserva o uso do link ANTES de criar a conta (dois envios ao mesmo tempo não passam do limite).
      // O link único não tem uso a reservar.
      let reservou = true;
      if (c) {
        const reserva = pessoal
          ? await admin.from("emb_convites").update({ usos: 1 }).eq("id", c.id).eq("usos", 0).select("id")
          : await admin.rpc("emb_convite_reservar_uso", { p_id: c.id });
        reservou = pessoal ? !!(reserva.data as unknown[] | null)?.length : reserva.data === true;
      }
      if (!reservou) return json({ error: LINK_INVALIDO }, 410);
      const devolverUso = async () => {
        if (!c) return;
        if (pessoal) await admin.from("emb_convites").update({ usos: 0 }).eq("id", c.id);
        else await admin.rpc("emb_convite_devolver_uso", { p_id: c.id });
      };

      const embId = embConvidado?.id ?? crypto.randomUUID();
      const apelido = await apelidoLivre(apelidoDoNome(n.nome), embId);

      // Foto primeiro: sem ela não há cadastro.
      const ext = foto!.mime === "image/png" ? "png" : foto!.mime === "image/webp" ? "webp" : "jpg";
      const fotoPath = `${embId}/perfil-${Date.now()}.${ext}`;
      const bytes = Uint8Array.from(atob(foto!.base64), (ch) => ch.charCodeAt(0));
      const { error: erroFoto } = await admin.storage.from("emb-fotos").upload(fotoPath, bytes, { contentType: foto!.mime, upsert: false });
      if (erroFoto) { await devolverUso(); return json({ error: "Não foi possível guardar a foto. Tente de novo." }, 500); }

      // Conta no Auth com papel próprio e sem profile (handle_new_user lê emb_autorizacao).
      await admin.from("emb_autorizacao").upsert({ email: n.email, criado_em: new Date().toISOString() });
      const { data: criado, error: erroCriar } = await admin.auth.admin.createUser({
        email: n.email,
        email_confirm: true,
        password: corpo.senha!,
        role: "embaixador",
        app_metadata: { portal: "embaixador", embaixador_id: embId },
        user_metadata: { name: n.nome },
      });
      const desfazer = async (userId?: string) => {
        if (userId) await admin.auth.admin.deleteUser(userId);
        await admin.storage.from("emb-fotos").remove([fotoPath]);
        await admin.from("emb_autorizacao").delete().eq("email", n.email);
        await devolverUso();
      };
      if (erroCriar || !criado?.user) {
        await desfazer();
        const jaExiste = /already|registered|exists/i.test(erroCriar?.message ?? "");
        return json({ error: jaExiste ? "Este e-mail já tem conta no sistema. Use outro e-mail." : "Não foi possível criar a conta. Tente de novo." }, jaExiste ? 409 : 500);
      }
      const userId = criado.user.id;
      let papel = (criado.user as { role?: string }).role;
      if (papel !== "embaixador") {
        const { data: corrigido } = await admin.auth.admin.updateUserById(userId, { role: "embaixador" });
        papel = (corrigido?.user as { role?: string } | undefined)?.role;
      }
      if (papel !== "embaixador") {
        await desfazer(userId);
        return json({ error: "A conta não ficou restrita ao painel; nada foi criado. Avise a equipe do programa." }, 500);
      }
      await admin.from("profiles").delete().eq("id", userId); // rede de segurança: nunca vira colaborador

      const agora = new Date().toISOString();
      const linha = {
        ...n, user_id: userId, status: "onboarding", apelido, foto_path: fotoPath,
        titulo: [n.area_atuacao, n.cidade && n.uf ? `${n.cidade}, ${n.uf}` : n.cidade].filter(Boolean).join(" · ") || null,
        formulario_respondido_em: agora,
        email_confirmado_em: pessoal ? agora : null,
        convite_id: c?.id ?? null,
        origem_cadastro: unico ? "link_unico" : pessoal ? "convite" : "link",
        atualizado_em: agora,
      };
      const gravado = pessoal
        ? await admin.from("emb_embaixadores").update(linha).eq("id", embId).eq("status", "convidado").select("id")
        : await admin.from("emb_embaixadores").insert({ id: embId, ...linha }).select("id");
      if (gravado.error || !(gravado.data as unknown[] | null)?.length) {
        console.error("[emb-cadastro-publico] gravar", gravado.error);
        await desfazer(userId);
        return json({ error: "Não foi possível gravar o cadastro. Tente de novo." }, 500);
      }

      await admin.from("emb_termos_aceites").insert({
        embaixador_id: embId, versao: termo.versao, ip: ipDoPedido(req), user_agent: (req.headers.get("user-agent") ?? "").slice(0, 400),
      });
      await registrar(embId, "embaixador", "respondeu_formulario", { link: unico ? "unico" : c!.motivo, termo: termo.versao });

      let emailEnviado = true;
      if (!pessoal) {
        const token = novoToken();
        const { data: conf } = await admin.from("emb_convites").insert({
          token_hash: await hashToken(token), motivo: "confirmar_email", embaixador_id: embId, usos_max: 1,
          expira_em: new Date(Date.now() + VALIDADE_CONFIRMAR_EMAIL_MS).toISOString(),
        }).select("id").single();
        emailEnviado = !!conf && await enviarEmailDoEmbaixador(admin, {
          para: n.email, nome: n.nome, link: linkDoToken(origem, "confirmar_email", token), motivo: "confirmar_email", chave: conf.id,
        });
      }
      return json({ ok: true, email: n.email, precisa_confirmar_email: !pessoal, email_enviado: emailEnviado });
    }

    // ---------------------------------------------------------------------------------------------
    if (corpo.acao === "confirmar_email") {
      const c = await conviteDoToken(corpo.token);
      if (!c || c.motivo !== "confirmar_email" || !c.embaixador_id) return json({ error: LINK_INVALIDO }, 410);
      const { data: marcado } = await admin.from("emb_convites").update({ usos: 1 }).eq("id", c.id).eq("usos", 0).select("id");
      if (!marcado?.length) return json({ error: "Este link já foi usado." }, 410);
      const { data: emb } = await admin.from("emb_embaixadores")
        .update({ email_confirmado_em: new Date().toISOString(), atualizado_em: new Date().toISOString() })
        .eq("id", c.embaixador_id).is("email_confirmado_em", null).select("email");
      await registrar(c.embaixador_id, "embaixador", "confirmou_email");
      const email = (emb as Array<{ email: string }> | null)?.[0]?.email;
      return json({ ok: true, email: email ?? null });
    }

    // ---------------------------------------------------------------------------------------------
    if (corpo.acao === "criar_senha") {
      const c = await conviteDoToken(corpo.token);
      if (!c || c.motivo !== "nova_senha") return json({ error: LINK_INVALIDO }, 410);
      const emb = await embaixadorDoConvite(c);
      if (!emb?.user_id) return json({ error: LINK_INVALIDO }, 410);
      const problema = problemaDaSenha(corpo.senha);
      if (problema) return json({ error: problema }, 400);
      // Marca o link como usado ANTES de trocar a senha: um segundo clique não troca de novo.
      const { data: marcado } = await admin.from("emb_convites").update({ usos: 1 }).eq("id", c.id).eq("usos", 0).select("id");
      if (!marcado?.length) return json({ error: "Este link já foi usado." }, 410);
      const { error } = await admin.auth.admin.updateUserById(emb.user_id, { password: corpo.senha });
      if (error) {
        await admin.from("emb_convites").update({ usos: 0 }).eq("id", c.id);
        return json({ error: "Não foi possível gravar a senha. Tente de novo." }, 500);
      }
      await registrar(emb.id, "embaixador", "trocou_senha");
      return json({ ok: true, email: emb.email });
    }

    // ---------------------------------------------------------------------------------------------
    if (corpo.acao === "esqueci") {
      // Resposta sempre igual e imediata: nem o texto nem o tempo revelam se o e-mail tem conta.
      const email = (corpo.email ?? "").trim().toLowerCase();
      const tarefa = mandarNovaSenha(email).catch((e) => console.error("[emb-cadastro-publico] esqueci", e));
      const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (rt?.waitUntil) rt.waitUntil(tarefa); else await tarefa;
      return json({ ok: true });
    }

    return json({ error: "Ação desconhecida." }, 400);

    /** "ana-souza", "ana-souza-2", … — o primeiro livre. */
    async function apelidoLivre(base: string, embId: string): Promise<string> {
      const { data } = await admin.from("emb_embaixadores").select("id, apelido").like("apelido", `${base}%`);
      const usados = new Set(((data ?? []) as Array<{ id: string; apelido: string }>).filter((r) => r.id !== embId).map((r) => r.apelido));
      if (!usados.has(base)) return base;
      for (let i = 2; i < 500; i++) if (!usados.has(`${base}-${i}`)) return `${base}-${i}`;
      return `${base}-${crypto.randomUUID().slice(0, 6)}`;
    }

    async function mandarNovaSenha(email: string): Promise<void> {
      if (!emailValido(email)) return;
      const { data: contas } = await admin.from("emb_embaixadores").select("id, user_id, nome, email, status")
        .ilike("email", literalIlike(email)).not("user_id", "is", null).limit(1);
      const conta = (contas ?? [])[0] as undefined | { id: string; nome: string; email: string; status: string };
      if (!conta || !["onboarding", "ativo", "encerrado"].includes(conta.status)) return;
      const { data: recente } = await admin.from("emb_convites").select("id").eq("embaixador_id", conta.id)
        .eq("motivo", "nova_senha").gt("criado_em", new Date(Date.now() - 10 * 60 * 1000).toISOString()).limit(1);
      if (recente?.length) return;
      await admin.from("emb_convites").update({ ativo: false }).eq("embaixador_id", conta.id).eq("motivo", "nova_senha").eq("usos", 0);
      const token = novoToken();
      const { data: conv } = await admin.from("emb_convites").insert({
        token_hash: await hashToken(token), motivo: "nova_senha", embaixador_id: conta.id, usos_max: 1,
        expira_em: new Date(Date.now() + VALIDADE_NOVA_SENHA_MS).toISOString(),
      }).select("id").single();
      if (!conv) return;
      const enviado = await enviarEmailDoEmbaixador(admin, {
        para: conta.email, nome: conta.nome, link: linkDoToken(origemDoPortal(req.headers.get("origin")), "nova_senha", token),
        motivo: "nova_senha", chave: conv.id,
      });
      await registrar(conta.id, "embaixador", "pediu_nova_senha", { email_enviado: enviado });
    }
  } catch (e) {
    console.error("[emb-cadastro-publico]", e);
    return json({ error: "Erro inesperado. Tente de novo em instantes." }, 500);
  }
});
