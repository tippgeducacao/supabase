/**
 * Link da agenda pública do comercial no BOTÃO do modelo (16/11/2026).
 *
 * Pedido: "criar um token com o link no momento do envio para add no template, assim vamos
 * poder criar um por lead ... já fica setado pelo número que será feito o envio".
 *
 * Mesmo desenho da mídia do cabeçalho: quem põe o parâmetro é a `crm-whatsapp-send`, o ponto
 * único de todo envio. Assim o link sai igual por fluxo, automação do funil, CRM v2, SAC v2 e
 * envio manual, sem cada editor precisar conhecer a variável. A edge só age em modelo cujo
 * botão de URL aponta para /agendar-reuniao/{{1}}: a lista fica em `agenda_lead_modelos`,
 * gravada pela `crm-whatsapp-templates` toda vez que alguém lista os modelos de um número.
 *
 * Quem assina o link é o banco (`agenda_lead_link_para_envio`); aqui é só o encaixe.
 */

type Rpc = {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

/** O caminho que identifica o modelo: o botão de URL termina em `/agendar-reuniao/{{1}}`. */
export const CAMINHO_AGENDA_REUNIAO = "/agendar-reuniao/";

const TTL_MS = 60_000;
const TTL_FALHA_MS = 10_000;
let memo: { ate: number; chaves: Set<string> } | null = null;

/** Só para teste: esquece a lista guardada em memória. */
export function esquecerModelosDaAgenda(): void {
  memo = null;
}

/**
 * Este modelo, nesta conta da Meta, leva o link da agenda no botão?
 *
 * A lista é pequena e fica 60 s em memória: o envio de qualquer outro modelo não paga nada.
 * Falha ao ler = "nenhum modelo": o envio segue como sempre foi.
 */
export async function modeloLevaLinkDaAgenda(admin: Rpc, wabaId: unknown, template: unknown): Promise<boolean> {
  const waba = String(wabaId ?? "").trim();
  const nome = String(template ?? "").trim();
  if (!waba || !nome) return false;
  if (!memo || Date.now() > memo.ate) {
    try {
      const { data, error } = await admin.rpc("agenda_lead_modelos_chaves");
      if (error) throw new Error(error.message ?? "erro");
      memo = { ate: Date.now() + TTL_MS, chaves: new Set(Array.isArray(data) ? data.map(String) : []) };
    } catch (e) {
      console.error("[agenda-lead-link] lista de modelos indisponível:", (e as Error)?.message);
      memo = { ate: Date.now() + TTL_FALHA_MS, chaves: memo?.chaves ?? new Set() };
    }
  }
  return memo.chaves.has(`${waba}|${nome}`);
}

/**
 * Os modelos de uma listagem da Meta que levam o link da agenda: nome, posição do botão e
 * situação. É o que a `crm-whatsapp-templates` grava em `agenda_lead_modelos`.
 */
export function modelosComLinkDaAgenda(
  templates: Array<{ name?: unknown; status?: unknown; components?: unknown }>,
): Array<{ nome: string; indice: number; status: string }> {
  const achados: Array<{ nome: string; indice: number; status: string }> = [];
  for (const t of templates ?? []) {
    const comps = Array.isArray(t?.components) ? (t.components as Array<Record<string, unknown>>) : [];
    const botoes = comps.find((c) => String(c?.type ?? "").toUpperCase() === "BUTTONS")?.buttons;
    if (!Array.isArray(botoes)) continue;
    const indice = botoes.findIndex((b: Record<string, unknown>) => {
      const url = String(b?.url ?? "");
      return String(b?.type ?? "").toUpperCase() === "URL" && url.includes(CAMINHO_AGENDA_REUNIAO) && url.includes("{{");
    });
    const nome = String(t?.name ?? "");
    if (indice >= 0 && nome) achados.push({ nome, indice, status: String(t?.status ?? "") });
  }
  return achados;
}

/**
 * Os componentes do envio com o botão da agenda. Se quem chamou já mandou um parâmetro para
 * aquele botão (o editor do CRM v2 manda o link sem o número), ele é trocado pelo daqui, que
 * leva o número que está enviando.
 */
export function comBotaoDaAgenda(comps: unknown[], indice: number, valor: string): unknown[] {
  const outros = (Array.isArray(comps) ? comps : []).filter((c) => {
    const x = c as Record<string, unknown>;
    return !(
      String(x?.type ?? "").toLowerCase() === "button" &&
      String(x?.sub_type ?? "").toLowerCase() === "url" &&
      Number(x?.index ?? 0) === indice
    );
  });
  return [
    ...outros,
    { type: "button", sub_type: "url", index: indice, parameters: [{ type: "text", text: valor }] },
  ];
}

/** O que dizer quando o modelo leva o link e não há link para este envio. */
export const MOTIVO_SEM_LINK_DA_AGENDA: Record<string, string> = {
  ja_tem_reuniao: "O lead já tem reunião marcada: o convite da agenda não foi enviado de novo.",
  agenda_desligada: "A agenda pública está desligada: o modelo com o link da agenda não foi enviado.",
  sem_lead: "Envio sem lead e sem link deste número: crie um link para o número em Agenda Geral, Link público.",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type LinkDaAgendaNoEnvio =
  | { aplica: false }
  | { aplica: true; ok: true; comps: unknown[]; tipo: string }
  | { aplica: true; ok: false; erro: string };

/**
 * Resolve o botão da agenda para UM envio. `aplica: false` = modelo comum, nada muda.
 * `ok: false` = o modelo leva o link e não dá para montar: quem chama NÃO envia (a Meta
 * recusaria o modelo sem o parâmetro do botão, e o lead ficaria sem nada).
 */
export async function linkDaAgendaNoEnvio(
  admin: Rpc,
  p: { wabaId: unknown; template: unknown; contaId: unknown; leadId: unknown; comps: unknown[] },
): Promise<LinkDaAgendaNoEnvio> {
  if (!(await modeloLevaLinkDaAgenda(admin, p.wabaId, p.template))) return { aplica: false };
  const lead = String(p.leadId ?? "");
  const { data, error } = await admin.rpc("agenda_lead_link_para_envio", {
    p_waba_id: String(p.wabaId),
    p_template: String(p.template),
    p_conta: p.contaId ?? null,
    p_lead: UUID.test(lead) ? lead : null,
  });
  if (error) return { aplica: true, ok: false, erro: "Não foi possível montar o link da agenda deste lead. Nada foi enviado." };
  const r = (data ?? {}) as { aplica?: boolean; ok?: boolean; indice?: number; valor?: string; motivo?: string; tipo?: string };
  // o modelo saiu da lista entre a memória e a consulta: é um modelo comum
  if (r.aplica !== true) return { aplica: false };
  if (r.ok !== true || !r.valor) {
    return {
      aplica: true,
      ok: false,
      erro: MOTIVO_SEM_LINK_DA_AGENDA[String(r.motivo ?? "")] ?? "O link da agenda não pôde ser montado. Nada foi enviado.",
    };
  }
  return { aplica: true, ok: true, comps: comBotaoDaAgenda(p.comps, Number(r.indice ?? 0), String(r.valor)), tipo: String(r.tipo ?? "") };
}

/**
 * "LINK DE AGENDAMENTO" NO TEXTO DO MODELO (17/11/2026, pedido do Gustavo: "cria uma variável,
 * Link de agendamento").
 *
 * A variável é resolvida no banco (`crm_template_montar_components`), que devolve o endereço
 * inteiro do link do lead com 56 hex: aquele ponto não sabe por qual número o envio vai sair.
 * Aqui, onde o número é conhecido, o link vira o de 88 hex (lead + número que envia), o mesmo
 * que o botão leva. Só age quando há um link desses no texto: modelo comum não consulta nada.
 * Se a troca falhar, o link de 56 hex segue como veio: ele abre a agenda do lead do mesmo
 * jeito, só não diz de qual número saiu.
 */
const LINK_DO_LEAD_NO_TEXTO = /\/agendar-reuniao\/([0-9a-f]{56})(?![0-9a-f])/g;
const TOKEN_DO_ENVIO = /^[0-9a-f]{88}$/;

export async function linkDeAgendamentoComNumero(admin: Rpc, comps: unknown[], contaId: unknown): Promise<unknown[]> {
  const conta = String(contaId ?? "");
  if (!Array.isArray(comps) || !UUID.test(conta)) return comps;

  const tokens = new Set<string>();
  for (const c of comps) {
    const params = (c as Record<string, unknown>)?.parameters;
    if (!Array.isArray(params)) continue;
    for (const p of params) {
      const texto = (p as Record<string, unknown>)?.text;
      if (typeof texto !== "string") continue;
      for (const m of texto.matchAll(LINK_DO_LEAD_NO_TEXTO)) tokens.add(m[1]);
    }
  }
  if (tokens.size === 0) return comps;

  const trocas = new Map<string, string>();
  for (const token of tokens) {
    try {
      const { data, error } = await admin.rpc("agenda_lead_link_com_numero", { p_token: token, p_conta: conta });
      if (error) throw new Error(error.message ?? "erro");
      if (typeof data === "string" && TOKEN_DO_ENVIO.test(data)) trocas.set(token, data);
    } catch (e) {
      console.error("[agenda-lead-link] link do texto segue sem o número:", (e as Error)?.message);
    }
  }
  if (trocas.size === 0) return comps;

  return comps.map((c) => {
    const comp = c as Record<string, unknown>;
    if (!Array.isArray(comp?.parameters)) return c;
    return {
      ...comp,
      parameters: comp.parameters.map((p) => {
        const param = p as Record<string, unknown>;
        if (typeof param?.text !== "string") return p;
        return {
          ...param,
          text: param.text.replace(LINK_DO_LEAD_NO_TEXTO, (tudo: string, token: string) =>
            trocas.has(token) ? `/agendar-reuniao/${trocas.get(token)}` : tudo,
          ),
        };
      }),
    };
  });
}
