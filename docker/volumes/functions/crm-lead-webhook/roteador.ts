// Roteador dos sites (16/11/2026). PPGVET, PPG, Escola e Blog mandam todo lead para
// `?int=sites` com um secret só. A etiqueta (site + formulario + pos + evento) escolhe a rota em
// `crm_webhook_rotas`, e a integração destino ("ficha") roda a receita dela como sempre, por
// chamada interna. Teste (`teste: true` ou e-mail @teste.ppgvet.com.br) responde o que
// aconteceria e só grava o log. Contrato do payload: docs/CRM — Webhooks.md, "Roteador dos sites".

export const DOMINIO_TESTE = "teste.ppgvet.com.br";

const CAMPOS = ["site", "formulario", "pos", "evento"] as const;
// pos pesa mais que evento, que pesa mais que formulario e site: a rota mais específica vence.
const PESO = { pos: 8, evento: 4, formulario: 2, site: 1 } as const;

export type Etiqueta = Record<(typeof CAMPOS)[number], string>;
export type Rota = Etiqueta & { curso: string | null; integration_id: string };
type Payload = Record<string, unknown>;

const limpo = (v: unknown) => String(v ?? "").trim().toLowerCase();

export function etiquetaDoPayload(p: Payload): Etiqueta {
  return { site: limpo(p.site), formulario: limpo(p.formulario), pos: limpo(p.pos), evento: limpo(p.evento) };
}

export function ehTeste(p: Payload): boolean {
  return p.teste === true || p.teste === "true" || limpo(p.email).endsWith("@" + DOMINIO_TESTE);
}

/** A rota que casa com mais peso ('*' casa qualquer valor); `null` sem nenhuma. */
export function escolherRota<R extends Etiqueta>(rotas: R[], e: Etiqueta): R | null {
  let melhor: R | null = null;
  let nota = -1;
  for (const r of rotas) {
    if (!CAMPOS.every((c) => r[c] === "*" || r[c] === e[c])) continue;
    const n = CAMPOS.reduce((s, c) => s + (r[c] === "*" ? 0 : PESO[c]), 0);
    if (n > nota) [melhor, nota] = [r, n];
  }
  return melhor;
}

/** Campos sem os quais o lead não serve; o teste devolve a lista. */
export function camposFaltando(p: Payload): string[] {
  const contato = limpo(p.formulario) === "newsletter" ? ["nome", "email"] : ["nome", "email", "whatsapp"];
  return ["site", "formulario", ...contato].filter((k) => !String(p[k] ?? "").trim());
}

/**
 * O corpo que a ficha recebe: o payload v1 mais os nomes antigos que as receitas leem
 * (pós: eu_sou, curso; blog e cursos: os nomes da GreatPages). Campo próprio do formulário
 * (ex.: `acesso` do hub da Escola) passa como veio.
 * shortcut: apelidos dos nomes antigos; tirar quando as receitas das fichas lerem o v1.
 */
export function corpoParaFicha(p: Payload, rota: Pick<Rota, "curso">, slugDestino: string): Payload {
  const { teste: _teste, ...resto } = p;
  const enviado = typeof p.enviado_em === "string" ? new Date(p.enviado_em) : new Date();
  return {
    ...resto,
    eu_sou: p.profissao ?? p.eu_sou,
    // O curso da rota; sem ele (hub), a pós escolhida no formulário.
    curso: rota.curso || p.curso_interesse || p.curso,
    Nome: p.nome,
    E_mail: p.email,
    Seu_WhatsApp: p.whatsapp ? `+${p.whatsapp}` : undefined,
    Eu_sou: p.profissao,
    UTM_Source: p.utm_source,
    UTM_Medium: p.utm_medium,
    UTM_Campaign: p.utm_campaign,
    UTM_Content: p.utm_content,
    UTM_Term: p.utm_term,
    UTM_Id: p.utm_id,
    URL: p.url,
    IP_do_usuario: p.ip,
    Dispositivo: p.dispositivo,
    Tempo_de_Formacao: p.tempo_formacao,
    Dificuldade_profissional: p.dificuldade,
    Politicas_de_privacidade: "true",
    Data_da_conversao: (isNaN(+enviado) ? new Date() : enviado).toISOString().slice(0, 19).replace("T", " "),
    Id_do_formulario: slugDestino,
    Cidade_do_usuario: p.cidade,
    Regiao_do_usuario: p.estado,
    Pais_do_usuario: p.pais,
    Referral_Source: p.referrer,
    ...(p.id_envio ? { dados_completos: { id: p.id_envio } } : {}),
  };
}

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type Admin = any;

/** O que a receita da ficha faria, com nomes legíveis (só leitura). */
async function resumirReceita(admin: Admin, config: any) {
  const itens: any[] = config?.acoes?.itens ?? [];
  const de = (tipo: string) => itens.filter((a) => a?.tipo === tipo).map((a) => a.params ?? {});
  const nomes = async (tabela: string, ids: string[]) => {
    if (!ids.length) return [];
    const { data } = await admin.from(tabela).select("id, nome").in("id", ids);
    return ids.map((id) => data?.find((r: any) => r.id === id)?.nome ?? id);
  };
  const cards = await Promise.all(de("criar_oportunidade").map(async (c) => ({
    funil: (await nomes("crm_funis", [c.funilId].filter(Boolean)))[0] ?? null,
    etapa: (await nomes("crm_funis_etapas", [c.etapaId].filter(Boolean)))[0] ?? null,
    titulo: c.titulo ?? null,
  })));
  return {
    cards,
    tags: await nomes("crm_tags", de("modificar_tags").flatMap((t) => t.adicionar ?? [])),
    segmentos: await nomes("crm_segmentos", de("modificar_segmentos").flatMap((s) => s.adicionar ?? [])),
    whatsapp: de("enviar_mensagem_whatsapp").map((w) => w.template_id ?? null),
    email: de("enviar_email").map((e) => e.template_id ?? null),
    responsavel: de("definir_responsavel_contato").map((r) => r.estrategia ?? null),
  };
}

export async function rotearSites(args: {
  req: Request;
  payload: Payload;
  admin: Admin;
  roteador: { id: string; slug: string };
  ipOrigem: string | null;
  receber: (req: Request) => Promise<Response>;
}): Promise<Response> {
  const { req, payload, admin, roteador, ipOrigem, receber } = args;
  const e = etiquetaDoPayload(payload);
  // Só rota de ficha ativa: ficha despublicada na tela cai na reserva em vez de devolver 403
  // (o site não repete 4xx e o lead se perderia). Ficha = o próprio roteador também (laço).
  const { data: rotas, error } = await admin
    .from("crm_webhook_rotas")
    .select("site, formulario, pos, evento, curso, integration_id, crm_webhook_integrations!inner(ativa)")
    .eq("ativa", true)
    .eq("crm_webhook_integrations.ativa", true)
    .neq("integration_id", roteador.id)
    .in("site", [e.site, "*"]).in("formulario", [e.formulario, "*"])
    .in("pos", [e.pos, "*"]).in("evento", [e.evento, "*"]);
  // 503: o site tenta de novo (falha passageira não pode perder o lead).
  if (error) return json({ error: "temporarily_unavailable" }, 503);
  const rota = escolherRota((rotas ?? []) as Rota[], e);
  const { data: destino } = rota
    ? await admin.from("crm_webhook_integrations").select("id, slug, nome, secret, ativa, config").eq("id", rota.integration_id).maybeSingle()
    : { data: null };
  if (!rota || !destino) {
    await admin.from("crm_webhook_logs").insert({
      integration_id: roteador.id, slug: roteador.slug, payload, status: "erro", ip_origem: ipOrigem,
      erro: `roteador: sem rota nem reserva para ${JSON.stringify(e)}`,
    });
    return json({ error: "temporarily_unavailable" }, 503);
  }

  if (ehTeste(payload)) {
    const resultado = {
      teste: true,
      rota: e,
      sem_rota: rota.pos === "*",
      destino: { integracao: destino.slug, nome: destino.nome, ativa: destino.ativa, ...(await resumirReceita(admin, destino.config)) },
      faltando: camposFaltando(payload),
    };
    await admin.from("crm_webhook_logs").insert({
      integration_id: destino.id, slug: destino.slug, payload, status: "teste", ip_origem: ipOrigem, resultado,
    });
    return json({ ok: true, ...resultado });
  }

  const url = new URL(req.url);
  url.search = "";
  url.searchParams.set("int", destino.slug);
  return receber(new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-secret": destino.secret,
      ...(ipOrigem ? { "x-forwarded-for": ipOrigem } : {}),
    },
    body: JSON.stringify(corpoParaFicha(payload, rota, destino.slug)),
  }));
}
