// Públicos do CRM na Meta (Públicos Personalizados de lista de clientes) · 04/11/2026.
//
// O CRM monta e mantém, na conta de anúncios, os públicos que o tráfego usa nos conjuntos:
//   - quem MARCOU reunião de cada pós, com qualquer resultado (retroalimenta o público daquela pós);
//   - os alunos compradores de todas as pós (exclusão e semente);
//   - os leads por profissão do formulário (veterinários e zootecnistas), semente do semelhante;
//   - a soma de públicos do catálogo (regra uniao: compradores + reuniões de bovinos), semente do
//     semelhante que entra nos conjuntos de bovinos;
//   - os semelhantes 1% BR, dos veterinários e zootecnistas e dos compradores + reuniões de bovinos.
// O catálogo é a tabela meta_publicos: público novo é INSERT, não deploy. As linhas saem do
// banco JÁ em SHA-256 (meta_publicos_linhas); e-mail, telefone e nome crus não passam por aqui.
// Ver docs/Marketing — Mídia Paga.md → "Públicos do CRM na Meta".
//
// Atualização semanal (pg_cron): a lista inteira vai por /usersreplace, que troca o conteúdo
// SEM reiniciar o aprendizado dos conjuntos que usam o público (POST/DELETE em /users
// reiniciam). A 1ª carga de um público recém-criado vai por /users, porque ele ainda não está
// em conjunto nenhum. O semelhante, a Meta recalcula sozinha a cada 3 dias enquanto ele
// estiver num conjunto ativo.
//
// Quem pode chamar: o cron, com o segredo do cofre no cabeçalho x-meta-publicos-cron
// (conferido por meta_publicos_validar_cron; o segredo não sai do banco), a chave de serviço
// exata, ou quem está logado no painel "Públicos da Meta" do Portal Marketing e passa em
// meta_publicos_pode_gerenciar (Marketing OU diretoria/admin, a régua dos Lançamentos).
//
// Cada mudança num público vira um evento em meta_publicos_eventos, que fica "para conferir"
// no painel até alguém conferir: público criado, gente que entrou ou saiu, erro e aviso da Meta.
// A cada rodada a edge também grava o nome da conta e da BM em meta_publicos_contas.
//
// Corpo (JSON, tudo opcional):
//   { "modo": "simular" }            conta as linhas de cada público; NÃO fala com a Meta
//   { "modo": "listar" }             lê da Meta, sem enviar nada: os públicos da conta, o status
//                                    de cada público do catálogo e a BM de toda conta ativa (o cron
//                                    de 3 em 3 horas usa este)
//   { "modo": "envio" }              (padrão) cria o que falta e atualiza as listas
//   { "chaves": ["reunioes_cmcb"] }  restringe a rodada a esses públicos do catálogo
//   { "modo": "excluir", "chaves": [...] }  APAGA da Meta esses públicos e os tira do catálogo. Só o
//                                    cron ou o serviço, só com as chaves ditas nome por nome, e
//                                    nunca a origem de um semelhante ativo.
//
// Token: o da conta em meta_accounts (CA 01 I VETERINARIOS é o mesmo do sync-meta-ads e do
// meta-crm-capi). Ele não sai do servidor nem entra no registro da rodada.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { exigirAcesso, respostaAcessoNegado } from "../_shared/acesso.ts";
import { corsHeaders } from "../_shared/cors.ts";
import {
  acaoDaLista, corpoDoLote, dividirEmLotes, especificacaoSemelhante, eventoDoItem, impedimentoParaExcluir,
  mensagemDeErroMeta, modoDoCorpo, novaSessao, type Linha,
} from "./regras.ts";

const API = "https://graph.facebook.com/v26.0";
const CAMPOS_STATUS =
  "id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,operation_status,delivery_status,time_updated";

type Publico = {
  id: string;
  chave: string;
  nome: string;
  descricao: string | null;
  regra: "reunioes" | "alunos" | "profissao" | "semelhante" | "uniao";
  origem_chave: string | null;
  semelhanca: number | null;
  pais: string;
  ad_account_id: string;
  meta_audience_id: string | null;
  ultimo_resultado: Record<string, unknown> | null;
};

type RespostaLinhas = {
  linhas: Linha[];
  hashes: string[];
  linhas_total: number;
  emails_distintos: number;
  telefones_distintos: number;
};

type Item = Record<string, unknown>;

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

class ErroMeta extends Error {}

// Erro do supabase-js não é instanceof Error: tem .message solto no objeto.
const mensagem = (e: unknown) =>
  (e instanceof Error ? e.message : (e as { message?: string })?.message ?? JSON.stringify(e)).slice(0, 500);

async function lerMeta(resp: Response) {
  const r = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok || r.error) throw new ErroMeta(mensagemDeErroMeta(r, resp.status));
  return r;
}

async function metaGet(caminho: string, token: string, campos: string) {
  const url = new URL(`${API}/${caminho}`);
  url.searchParams.set("fields", campos);
  url.searchParams.set("access_token", token);
  return lerMeta(await fetch(url, { signal: AbortSignal.timeout(60_000) }));
}

async function metaPost(caminho: string, corpo: URLSearchParams) {
  return lerMeta(
    await fetch(`${API}/${caminho}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: corpo,
      signal: AbortSignal.timeout(120_000),
    }),
  );
}

/** Públicos que já existem na conta, por nome (a rodada que caiu antes de gravar o id é adotada). */
async function publicosNaConta(conta: string, token: string) {
  const porNome = new Map<string, Item>();
  const primeira = new URL(`${API}/act_${conta}/customaudiences`);
  primeira.searchParams.set("fields", CAMPOS_STATUS);
  primeira.searchParams.set("limit", "200");
  primeira.searchParams.set("access_token", token);
  let url: string | null = primeira.toString();
  for (let pagina = 0; url && pagina < 25; pagina++) {
    const r = await lerMeta(await fetch(url, { signal: AbortSignal.timeout(60_000) }));
    for (const a of (r.data as Item[] | undefined) ?? []) porNome.set(String(a.name), a);
    url = ((r.paging as { next?: string } | undefined)?.next) ?? null;
  }
  return porNome;
}

function resumoDoStatus(st: Item) {
  return {
    tamanho_min: st.approximate_count_lower_bound ?? null,
    tamanho_max: st.approximate_count_upper_bound ?? null,
    operation_status: st.operation_status ?? null,
    delivery_status: st.delivery_status ?? null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, erro: "Método não permitido" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let origem: "cron" | "servico" | "painel" = "servico";
  let usuarioId: string | null = null;
  const segredoCron = req.headers.get("x-meta-publicos-cron");
  if (segredoCron) {
    const { data, error } = await admin.rpc("meta_publicos_validar_cron", { p_segredo: segredoCron });
    if (error || data !== true) return json({ ok: false, erro: "Não autorizado" }, 401);
    origem = "cron";
  } else {
    try {
      const quem = await exigirAcesso(req, {
        servico: true,
        usuario: true,
        rpcPermissao: "meta_publicos_pode_gerenciar",
      });
      if (quem.tipo === "usuario") {
        origem = "painel";
        usuarioId = quem.usuarioId;
      }
    } catch (e) {
      return respostaAcessoNegado(e, corsHeaders);
    }
  }

  let corpo: { modo?: unknown; chaves?: unknown } = {};
  try {
    corpo = await req.json();
  } catch {
    corpo = {};
  }
  const modo = modoDoCorpo(corpo.modo);
  const chaves = Array.isArray(corpo.chaves)
    ? corpo.chaves.filter((c): c is string => typeof c === "string")
    : null;

  // Apagar não tem volta: só o cron ou o serviço, e só os públicos ditos nome por nome.
  if (modo === "excluir") {
    if (origem === "painel") return json({ ok: false, erro: "Apagar público não é feito pelo painel." }, 403);
    if (!chaves?.length) return json({ ok: false, erro: "Para apagar, diga as chaves dos públicos." }, 400);
  }

  const { data: execucao, error: erroExec } = await admin.rpc("meta_publicos_iniciar", {
    p_modo: modo,
    p_origem: origem,
  });
  if (erroExec) return json({ ok: false, erro: mensagem(erroExec) }, 500);
  if (!execucao) return json({ ok: false, erro: "Já há uma rodada de envio em andamento (menos de 30 min)." }, 409);
  if (usuarioId) {
    await admin.from("meta_publicos_execucoes").update({ disparado_por: usuarioId }).eq("id", execucao);
  }

  const itens: Item[] = [];
  let status: "ok" | "parcial" | "erro" = "ok";
  const falhou = () => {
    if (status === "ok") status = "parcial";
  };

  try {
    const { data: catalogo, error } = await admin
      .from("meta_publicos")
      .select("id, chave, nome, descricao, regra, origem_chave, semelhanca, pais, ad_account_id, meta_audience_id, ultimo_resultado")
      .eq("ativo", true)
      .order("ordem");
    if (error) throw error;
    const todos = (catalogo ?? []) as Publico[];
    const publicos = chaves ? todos.filter((p) => chaves.includes(p.chave)) : todos;

    // ── simular: só o banco ────────────────────────────────────────────────────────────────
    if (modo === "simular") {
      for (const p of publicos) {
        if (p.regra === "semelhante") {
          itens.push({ chave: p.chave, nome: p.nome, regra: p.regra, origem: p.origem_chave });
          continue;
        }
        const { data, error: e } = await admin.rpc("meta_publicos_linhas", { p_publico_id: p.id });
        if (e) throw e;
        const r = data as RespostaLinhas;
        itens.push({
          chave: p.chave,
          nome: p.nome,
          regra: p.regra,
          linhas: r.linhas_total,
          emails: r.emails_distintos,
          telefones: r.telefones_distintos,
        });
      }
      return await fechar();
    }

    // ── token de cada conta ────────────────────────────────────────────────────────────────
    const tokens = new Map<string, string>();
    for (const conta of new Set(publicos.map((p) => p.ad_account_id))) {
      const { data, error: e } = await admin
        .from("meta_accounts")
        .select("access_token")
        .eq("ad_account_id", conta)
        .eq("is_active", true)
        .maybeSingle();
      if (e) throw e;
      if (!data?.access_token) throw new Error(`Sem token ativo da conta ${conta} em meta_accounts`);
      tokens.set(conta, data.access_token as string);
    }

    // Nome da conta e da BM para o painel. No modo "listar" (o cron de 3 em 3 horas) entram TODAS as
    // contas ativas, não só as que têm público: o seletor de BM da tela mostra cada BM antes de ela
    // ganhar o primeiro público. Falhar aqui não derruba a rodada.
    const contasDoPainel = new Map(tokens);
    if (modo === "listar") {
      const { data: ativas, error: eAtivas } = await admin
        .from("meta_accounts")
        .select("ad_account_id, access_token")
        .eq("is_active", true);
      if (eAtivas) console.warn("meta-publicos-sync: contas ativas:", mensagem(eAtivas));
      for (const a of (ativas ?? []) as { ad_account_id: string; access_token: string | null }[]) {
        if (a.access_token && !contasDoPainel.has(a.ad_account_id)) contasDoPainel.set(a.ad_account_id, a.access_token);
      }
    }
    for (const [conta, token] of contasDoPainel) {
      try {
        const r = await metaGet(`act_${conta}`, token, "name,business{id,name}");
        const bm = r.business as { id?: string; name?: string } | undefined;
        await admin.from("meta_publicos_contas").upsert({
          ad_account_id: conta,
          nome_conta: (r.name as string | undefined) ?? null,
          bm_id: bm?.id ?? null,
          bm_nome: bm?.name ?? null,
          atualizado_em: new Date().toISOString(),
        });
      } catch (e) {
        console.warn(`meta-publicos-sync: conta/BM ${conta}:`, mensagem(e));
      }
    }

    // ── listar: o que já existe na conta ───────────────────────────────────────────────────
    if (modo === "listar") {
      for (const [conta, token] of tokens) {
        const porNome = await publicosNaConta(conta, token);
        itens.push({ conta, publicos: [...porNome.values()] });
        // O painel mostra o tamanho e o status que a Meta deu na ÚLTIMA leitura. Sem renovar aqui,
        // uma lista que ficou pronta depois do envio seguiria "processando" até a segunda seguinte.
        const porId = new Map([...porNome.values()].map((a) => [String(a.id), a]));
        for (const p of publicos.filter((x) => x.ad_account_id === conta && x.meta_audience_id)) {
          const lida = porId.get(p.meta_audience_id!);
          if (!lida) continue;
          await admin
            .from("meta_publicos")
            .update({ ultimo_resultado: { ...(p.ultimo_resultado ?? {}), meta: resumoDoStatus(lida) } })
            .eq("id", p.id);
        }
      }
      return await fechar();
    }

    // ── excluir: apaga da Meta e tira do catálogo ──────────────────────────────────────────
    if (modo === "excluir") {
      for (const p of publicos) {
        const item: Item = { chave: p.chave, nome: p.nome, acao: "excluir" };
        itens.push(item);
        try {
          const impedimento = impedimentoParaExcluir(p.chave, todos);
          if (impedimento) throw new Error(impedimento);
          if (p.meta_audience_id) {
            const url = new URL(`${API}/${p.meta_audience_id}`);
            url.searchParams.set("access_token", tokens.get(p.ad_account_id)!);
            await lerMeta(await fetch(url, { method: "DELETE", signal: AbortSignal.timeout(60_000) }));
          }
          // Sai do catálogo (as rodadas só olham o ativo) e o id vai para o histórico: se um dia o
          // público voltar, ele nasce de novo em vez de apontar para um id apagado.
          const agora = new Date().toISOString();
          const { error: e } = await admin
            .from("meta_publicos")
            .update({
              ativo: false,
              meta_audience_id: null,
              updated_at: agora,
              ultimo_resultado: {
                ...(p.ultimo_resultado ?? {}),
                excluido: { meta_audience_id: p.meta_audience_id, em: agora, execucao },
              },
            })
            .eq("id", p.id);
          if (e) throw e;
          Object.assign(item, { excluido: true, meta_audience_id: p.meta_audience_id });
        } catch (e) {
          item.erro = mensagem(e);
          falhou();
        }
      }
      if (itens.length && itens.every((i) => i.erro)) status = "erro";
      return await fechar();
    }

    // ── envio ──────────────────────────────────────────────────────────────────────────────
    const naConta = new Map<string, Map<string, Item>>();
    for (const [conta, token] of tokens) naConta.set(conta, await publicosNaConta(conta, token));
    const idPorChave = new Map(todos.map((p) => [p.chave, p.meta_audience_id]));

    const gravarId = async (p: Publico, id: string) => {
      const { error: e } = await admin
        .from("meta_publicos")
        .update({ meta_audience_id: id, updated_at: new Date().toISOString() })
        .eq("id", p.id);
      if (e) throw e;
      idPorChave.set(p.chave, id);
    };

    // 1) listas: reuniões e alunos
    for (const p of publicos.filter((x) => x.regra !== "semelhante")) {
      const item: Item = { chave: p.chave, nome: p.nome };
      itens.push(item);
      try {
        const token = tokens.get(p.ad_account_id)!;
        const { data, error: e } = await admin.rpc("meta_publicos_linhas", { p_publico_id: p.id });
        if (e) throw e;
        const r = data as RespostaLinhas;
        Object.assign(item, { linhas: r.linhas_total, emails: r.emails_distintos, telefones: r.telefones_distintos });
        if (!r.linhas.length) {
          item.aviso = "lista vazia: nada enviado";
          falhou();
          continue;
        }

        const existente = naConta.get(p.ad_account_id)?.get(p.nome);
        const { acao, endpoint } = acaoDaLista(p.meta_audience_id, existente?.id ? String(existente.id) : undefined);
        let audiencia = p.meta_audience_id ?? (existente?.id ? String(existente.id) : null);
        if (acao === "criar") {
          const c = new URLSearchParams({
            name: p.nome,
            subtype: "CUSTOM",
            customer_file_source: "USER_PROVIDED_ONLY",
            access_token: token,
          });
          if (p.descricao) c.set("description", p.descricao);
          audiencia = String((await metaPost(`act_${p.ad_account_id}/customaudiences`, c)).id);
        }
        if (acao !== "atualizar") await gravarId(p, audiencia!);
        Object.assign(item, { acao, meta_audience_id: audiencia, endpoint });

        // Substituir exige o público parado (operation_status 200). Ocupado = fica para a próxima.
        if (endpoint === "usersreplace") {
          const st = await metaGet(audiencia!, token, "operation_status");
          const codigo = (st.operation_status as { code?: number } | undefined)?.code;
          if (codigo !== undefined && codigo !== 200) {
            item.aviso = `a Meta ainda está processando este público (operation_status ${codigo}); fica para a próxima rodada`;
            falhou();
            continue;
          }
        }

        const sessao = novaSessao();
        let recebidos = 0;
        let invalidos = 0;
        for (const lote of dividirEmLotes(r.linhas)) {
          const resp = await metaPost(`${audiencia}/${endpoint}`, corpoDoLote(lote, sessao, r.linhas.length, token));
          // Na mesma sessão a Meta devolve o ACUMULADO: somar lote a lote contava a lista de novo a
          // cada lote (24.084 linhas em 3 lotes viravam 54.084 "recebidos" em 04/11/2026).
          recebidos = Math.max(recebidos, Number(resp.num_received ?? 0));
          invalidos = Math.max(invalidos, Number(resp.num_invalid_entries ?? 0));
        }
        Object.assign(item, { recebidos, invalidos });

        // Só depois de a Meta aceitar todos os lotes: quem entrou e quem saiu nesta rodada.
        const { data: mov, error: eMov } = await admin.rpc("meta_publicos_registrar_membros", {
          p_publico_id: p.id,
          p_hashes: r.hashes,
        });
        if (eMov) throw eMov;
        Object.assign(item, mov as Item);
      } catch (e) {
        item.erro = mensagem(e);
        falhou();
      }
    }

    // 2) semelhantes: criados uma vez; a Meta os recalcula a partir da origem
    for (const p of publicos.filter((x) => x.regra === "semelhante")) {
      const item: Item = { chave: p.chave, nome: p.nome };
      itens.push(item);
      try {
        const token = tokens.get(p.ad_account_id)!;
        let audiencia = p.meta_audience_id;
        if (audiencia) {
          item.acao = "manter (a Meta recalcula a cada 3 dias a partir da origem)";
        } else {
          const existente = naConta.get(p.ad_account_id)?.get(p.nome);
          if (existente?.id) {
            audiencia = String(existente.id);
            item.acao = "adotar";
          } else {
            const origemId = p.origem_chave ? idPorChave.get(p.origem_chave) : null;
            if (!origemId) {
              item.aviso = `a origem ${p.origem_chave} ainda não tem público na Meta`;
              falhou();
              continue;
            }
            const c = new URLSearchParams({
              name: p.nome,
              subtype: "LOOKALIKE",
              origin_audience_id: origemId,
              lookalike_spec: especificacaoSemelhante(Number(p.semelhanca), p.pais),
              access_token: token,
            });
            if (p.descricao) c.set("description", p.descricao);
            audiencia = String((await metaPost(`act_${p.ad_account_id}/customaudiences`, c)).id);
            item.acao = "criar";
          }
          await gravarId(p, audiencia);
        }
        item.meta_audience_id = audiencia;
      } catch (e) {
        item.erro = mensagem(e);
        falhou();
      }
    }

    // 3) como cada público está na Meta agora, e o carimbo no catálogo
    for (const item of itens) {
      const p = publicos.find((x) => x.chave === item.chave);
      if (!p) continue;
      const id = item.meta_audience_id as string | undefined;
      if (id) {
        try {
          item.meta = resumoDoStatus(await metaGet(id, tokens.get(p.ad_account_id)!, CAMPOS_STATUS));
        } catch (e) {
          item.meta_erro = mensagem(e);
        }
      }
      await admin
        .from("meta_publicos")
        .update({ ultima_sincronizacao_em: new Date().toISOString(), ultimo_resultado: item })
        .eq("id", p.id);
      // O que mudou fica "para conferir" no painel. Rodada sem mudança não gera evento.
      const evento = eventoDoItem(item);
      if (evento) {
        const { error: eEv } = await admin
          .from("meta_publicos_eventos")
          .insert({ publico_id: p.id, execucao_id: execucao, criado_por: usuarioId, ...evento });
        if (eEv) console.error("meta-publicos-sync: evento", p.chave, eEv.message);
      }
    }
    if (itens.length && itens.every((i) => i.erro)) status = "erro";
  } catch (e) {
    status = "erro";
    itens.push({ erro: mensagem(e) });
    console.error("meta-publicos-sync:", mensagem(e));
  }
  return await fechar();

  async function fechar() {
    await admin
      .from("meta_publicos_execucoes")
      .update({ status, terminada_em: new Date().toISOString(), resumo: { publicos: itens } })
      .eq("id", execucao);
    return json({ ok: status === "ok", modo, status, execucao, publicos: itens }, status === "erro" ? 500 : 200);
  }
});
