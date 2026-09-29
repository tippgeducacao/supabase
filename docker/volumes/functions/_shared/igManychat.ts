// Envio do direct PELO MANYCHAT quando ele é o dono da conversa (28/09/2026).
//
// Pelo roteamento de conversas da Meta, o ManyChat fica dono da conversa por ~24h depois
// de mandar o "Oii, tudo bem?" (fim de semana 26–28/09: 58 de 70 respostas da IA barradas
// com (#100) subcode 2534037). O nosso app (Instagram API with Instagram Login) não tem
// `take_thread_control`. Então: a resposta é decidida aqui como sempre e, SÓ quando o
// Instagram recusa por dono da conversa, sai pela API do ManyChat (sendContent), que é o
// dono e passa. Quem chama nem precisa saber: `enviarComDonoDaConversa` tenta um, depois
// o outro.
//
// O eco do envio pelo ManyChat volta pelo nosso webhook com cara de "humano". Antes de
// mandar, gravamos o envio em `ig_envios_manychat`; o gatilho do banco
// (trg_ig_mensagens_eco_manychat) casa o eco pelo texto e grava a origem certa — é o que
// impede a IA de se pausar achando que alguém do time respondeu.
//
// Chave da API: ig_contas_secrets.manychat_api_key (por conta; nunca no repo).
// Contato do ManyChat: achado por NOME (findByName, o único filtro da API que serve) e
// conferido pelo ig_id / @ que o ManyChat devolve; fica em cache (ig_manychat_contatos).
// Mapa: docs/Instagram (IA + Chat).md
import { type ErroEnvioIg, enviarTextoIg, type ResultadoEnvioIg } from "./igMensageria.ts";

export const MANYCHAT_API_URL = "https://api.manychat.com";

/**
 * Contato NOVO no ManyChat só ganha nome depois que a pessoa RESPONDE (a Meta só libera o
 * perfil depois de uma mensagem dela) — e a IA responde segundos depois dessa resposta.
 * 29/09/2026, 1º dia ligado: Sarah (9 s depois da resposta) e Jucilene (24 s) deram
 * "contato não encontrado", e horas depois as duas eram achadas pelo nome. Por isso a IA
 * procura de novo por ~1 min antes de desistir. O SAC não espera: o atendente está na tela.
 */
export const ESPERAS_BUSCA_MANYCHAT_IA_MS = [15_000, 20_000, 25_000];

/** Alguém do time respondeu enquanto a IA esperava o ManyChat: ela não fala por cima. */
const HUMANO_ASSUMIU = "ManyChat: parou de procurar — alguém do time assumiu a conversa";

export function humanoAssumiuDuranteBusca(erro: ErroEnvioIg): boolean {
  return erro.status === 409 && erro.message === HUMANO_ASSUMIU;
}

const dormirPadrao = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** (#100) subcode 2534037: outro app (o ManyChat) é o dono da conversa. */
export function ehConversaDeOutroApp(erro: ErroEnvioIg): boolean {
  return erro.subcode === 2534037;
}

export type SubscriberManychat = {
  id: string | number;
  name?: string | null;
  ig_id?: string | number | null;
  ig_username?: string | null;
};

const arroba = (v: string | null | undefined) => String(v ?? "").trim().replace(/^@+/, "").toLowerCase();

/** O contato certo numa lista do findByName: o ig_id bate com o IGSID; senão, o @. */
export function casaSubscriber(
  lista: SubscriberManychat[],
  igsid: string,
  username: string | null | undefined,
): SubscriberManychat | null {
  const porId = lista.find((s) => s.ig_id != null && String(s.ig_id) === String(igsid));
  if (porId) return porId;
  const user = arroba(username);
  if (!user) return null;
  return lista.find((s) => arroba(s.ig_username) === user) ?? null;
}

async function chamarManychat(
  chave: string,
  caminho: string,
  corpo: Record<string, unknown> | null,
  f: typeof fetch,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  try {
    const r = await f(`${MANYCHAT_API_URL}${caminho}`, {
      method: corpo ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${chave.trim()}`,
        Accept: "application/json",
        ...(corpo ? { "Content-Type": "application/json" } : {}),
      },
      ...(corpo ? { body: JSON.stringify(corpo) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    // deno-lint-ignore no-explicit-any
    const json: any = await r.json().catch(() => ({}));
    return { ok: r.ok && json?.status === "success", status: r.status, json: json ?? {} };
  } catch (e) {
    return { ok: false, status: 0, json: { message: e instanceof Error ? e.message : String(e) } };
  }
}

/**
 * Procura o contato no ManyChat pelos nomes dados (nome do perfil, @) e confere o id.
 * `resumo` diz o que o ManyChat respondeu a cada nome: antes, erro da API e "não existe"
 * davam a mesma mensagem, e a falha não tinha como ser lida depois.
 */
export async function buscarSubscriberManychat(
  chave: string,
  nomes: (string | null | undefined)[],
  igsid: string,
  username: string | null | undefined,
  f: typeof fetch = fetch,
): Promise<{ achado: SubscriberManychat | null; resumo: string }> {
  const tentativas = [...new Set(nomes.map((n) => String(n ?? "").trim()).filter(Boolean))];
  const partes: string[] = [];
  for (const nome of tentativas) {
    const r = await chamarManychat(chave, `/fb/subscriber/findByName?name=${encodeURIComponent(nome)}`, null, f);
    if (!r.ok || !Array.isArray(r.json.data)) {
      const msg = r.json?.message ? ` ${String(r.json.message).slice(0, 60)}` : "";
      partes.push(`"${nome}": HTTP ${r.status}${msg}`);
      continue;
    }
    const lista = r.json.data as SubscriberManychat[];
    const achado = casaSubscriber(lista, igsid, username);
    if (achado) return { achado, resumo: `"${nome}": achado` };
    partes.push(`"${nome}": ${lista.length} resultado(s), nenhum com este IGSID/@`);
  }
  return { achado: null, resumo: partes.join("; ") || "sem nome nem @ para procurar" };
}

/** Um balão de texto pelo ManyChat (conteúdo dinâmico v2, canal instagram). */
export async function enviarPeloManychat(
  chave: string,
  subscriberId: string | number,
  texto: string,
  f: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; erro: ErroEnvioIg }> {
  const r = await chamarManychat(chave, "/fb/sending/sendContent", {
    subscriber_id: Number(subscriberId),
    data: { version: "v2", content: { type: "instagram", messages: [{ type: "text", text: texto }] } },
  }, f);
  if (r.ok) return { ok: true };
  // deno-lint-ignore no-explicit-any
  const j: any = r.json;
  const detalhe = typeof j?.details === "object" ? JSON.stringify(j.details).slice(0, 200) : "";
  return {
    ok: false,
    erro: {
      status: r.status,
      code: typeof j?.code === "number" ? j.code : undefined,
      message: `ManyChat: ${String(j?.message ?? `HTTP ${r.status}`).slice(0, 200)}${detalhe ? ` ${detalhe}` : ""}`,
    },
  };
}

export type ResultadoEnvioDireto = ResultadoEnvioIg & { via: "instagram" | "manychat" };

export type AlvoDireto = {
  contaId: string;
  igsid: string;
  token: string;
  /** Para achar o contato no ManyChat. */
  nome?: string | null;
  username?: string | null;
};

export type QuemEnvia = {
  origem: "ia" | "humano" | "sistema";
  enviadoPorId?: string | null;
  enviadoPorNome?: string | null;
};

export type OpcoesEnvioDireto = {
  /** Pausas entre novas buscas do contato no ManyChat enquanto ele não aparece. */
  esperasBuscaMs?: number[];
  /** Conferido antes de cada nova busca: false = parar (alguém do time assumiu). */
  aindaPode?: () => Promise<boolean>;
  dormir?: (ms: number) => Promise<void>;
};

/**
 * Manda pelo Instagram; se a conversa é do ManyChat e a conta tem a chave dele, manda
 * pelo ManyChat. `via: "manychat"` com ok = enviado, SEM mid: a linha em ig_mensagens
 * nasce do eco (com a origem certa) — quem chama NÃO deve gravar a saída.
 */
export async function enviarComDonoDaConversa(
  // deno-lint-ignore no-explicit-any
  db: any,
  alvo: AlvoDireto,
  texto: string,
  quem: QuemEnvia,
  f: typeof fetch = fetch,
  opcoes: OpcoesEnvioDireto = {},
): Promise<ResultadoEnvioDireto> {
  const direto = await enviarTextoIg(alvo.token, alvo.igsid, texto, f);
  if (direto.ok || !ehConversaDeOutroApp(direto.erro)) return { ...direto, via: "instagram" };

  const { data: segredo } = await db.from("ig_contas_secrets").select("manychat_api_key")
    .eq("conta_id", alvo.contaId).maybeSingle();
  const chave = String(segredo?.manychat_api_key ?? "").trim();
  if (!chave) return { ...direto, via: "instagram" };

  let subscriberId: string | number | null = null;
  let buscas = 0;
  let resumo = "";
  const { data: cache } = await db.from("ig_manychat_contatos").select("subscriber_id")
    .eq("conta_id", alvo.contaId).eq("igsid", alvo.igsid).maybeSingle();
  if (cache?.subscriber_id) {
    subscriberId = cache.subscriber_id;
  } else {
    for (const espera of [0, ...(opcoes.esperasBuscaMs ?? [])]) {
      if (espera > 0) {
        await (opcoes.dormir ?? dormirPadrao)(espera);
        if (opcoes.aindaPode && !(await opcoes.aindaPode())) {
          return { ok: false, via: "manychat", erro: { status: 409, message: HUMANO_ASSUMIU } };
        }
      }
      buscas++;
      const b = await buscarSubscriberManychat(chave, [alvo.nome, alvo.username], alvo.igsid, alvo.username, f);
      resumo = b.resumo;
      if (b.achado) {
        subscriberId = b.achado.id;
        await db.from("ig_manychat_contatos").upsert({
          conta_id: alvo.contaId, igsid: alvo.igsid, subscriber_id: Number(b.achado.id),
          ig_username: b.achado.ig_username ?? alvo.username ?? null, atualizado_em: new Date().toISOString(),
        }, { onConflict: "conta_id,igsid" });
        break;
      }
    }
  }
  if (subscriberId == null) {
    const detalhe = `${buscas} busca(s); última: ${resumo}`;
    return {
      ok: false, via: "manychat",
      erro: {
        status: 404,
        message: `ManyChat: contato não encontrado (a conversa é do ManyChat e não achei a pessoa nele — ${detalhe})`.slice(0, 480),
      },
    };
  }

  // O envio pendente vai ANTES da chamada: o eco pode chegar antes de a API responder.
  const { data: pend } = await db.from("ig_envios_manychat").insert({
    conta_id: alvo.contaId, igsid: alvo.igsid, texto, origem: quem.origem,
    enviado_por_id: quem.enviadoPorId ?? null, enviado_por_nome: quem.enviadoPorNome ?? null,
  }).select("id").maybeSingle();

  const r = await enviarPeloManychat(chave, subscriberId, texto, f);
  if (!r.ok) {
    if (pend?.id) await db.from("ig_envios_manychat").update({ status: "falhou", erro: r.erro.message }).eq("id", pend.id);
    return { ok: false, erro: r.erro, via: "manychat" };
  }
  return { ok: true, mid: "", via: "manychat" };
}
