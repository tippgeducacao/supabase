// crm-agendamento-lembretes — lembretes/confirmação de reunião ANTES do horário.
//
// TOQUES CONFIGURÁVEIS (tabela crm_lembrete_toques, tela "Lembretes de Reunião" do
// CRM): cada toque diz QUANTO TEMPO ANTES dispara (minutos_antes) e o CONTEÚDO por
// canal — template Meta (template_name/lang/variaveis) e texto livre (linha Uazapi).
// Padrão semeado: 2 horas e 30 minutos antes (comportamento histórico). Disparado por
// cron (a cada ~10 min). NÃO passa pela trava de 24h de marketing — lembrete de
// reunião é essencial e tem que sair sempre.
//
// NÚMERO QUE ENVIA — configurável POR RESPONSÁVEL (tabela crm_lembrete_numeros,
// mesma tela):
//   • Responsável da reunião: origem IA ('API SDR'/'Agendamento por IA') →
//     agendamento_responsavel_espelho() (o SDR que herdou o lead no SAC);
//     demais reuniões → sdr_id (quem marcou).
//   • Config canal='meta' → TEMPLATE pela conta Cloud API configurada (o template do
//     toque precisa estar APROVADO na WABA dessa conta).
//   • Config canal='web'  → TEXTO LIVRE pela linha WhatsApp Web/Uazapi (sem janela
//     24h/template) — o texto_livre do toque, placeholders {nome} {hora} {dia} {link}.
//   • SEM config ativa: comportamento ORIGINAL — reunião 'API SDR' sai pela conta
//     padrão (João); reunião marcada por humano NÃO recebe lembrete (opt-in).
//
// Janela de cada toque (minutos restantes até a reunião): dispara quando
//   max(minutos_antes − 30, 10) <= resta <= minutos_antes + 5
// — banda de 30 min garante que o cron de 10 min sempre acerta; piso de 10 min evita
// lembrete em cima da hora; reunião marcada DEPOIS da banda do toque não recebe aquele
// toque (igual ao comportamento histórico do T-2h).
//
// Dedup: claim atômico em crm_lembrete_envios (INSERT ON CONFLICT DO NOTHING por
// reunião × toque) antes de enviar; falhou o envio → remove a linha e tenta no
// próximo tick. (As colunas legadas agendamentos.lembrete_*_em viraram histórico.)
//
// TEMPLATE POR NÚMERO (crm_lembrete_toque_contas, 2026-07-11): o nome do template
// muda de WABA pra WABA (ex.: 30min é 'lembre_de_30_min_utility' no João e
// 'lembre_30_min_utility' na PPGVET - Pós-graduação IA). CADA NÚMERO SÓ ENVIA O
// TOQUE SE TIVER LINHA PRÓPRIA (decisão do usuário 2026-07-11: "o de 2 horas só
// precisa ir se for agendado pelo número do João") — cada número tem o SEU conjunto
// de toques:
//   • O toque só SE APLICA à reunião quando o NÚMERO DO LEAD (conta escolhida no
//     agendamento ?? conta da conversa) tem linha nele — lead da Pós-graduação IA
//     NÃO recebe o toque de 2h (nem via fallback pelo João).
//   • Rota Meta só é viável com linha própria da conta (SEM fallback pro template
//     principal do toque — as colunas template_* viraram compat: badge da listagem
//     + base do texto_livre; a migration 20260711150000 as materializou como linha).
//   • Lead SEM número Meta (nunca escreveu) segue pelas rotas configuradas
//     (responsável meta [se a conta dele tem linha], linha Web [texto livre] ou
//     conta padrão em reunião do agente) — o opt-in de reunião humana continua.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.50.3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SEND_URL = (Deno.env.get('AGENTE_SDR_SEND_URL') ?? `${SUPABASE_URL}/functions/v1/crm-whatsapp-send`).replace(/\/$/, '');

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Reuniões da IA têm sdr_id = conta "IA SDR" → o responsável real vem do espelho.
const IA_ORIGENS = ['API SDR', 'Agendamento por IA'];

// Janela do toque (ver cabeçalho).
const BANDA_MIN = 30; // largura da banda abaixo do alvo
const PISO_MIN = 10;  // nunca lembrar com menos de 10 min de antecedência
const FOLGA_MIN = 5;  // tolerância acima do alvo

// Brasília = UTC-3 fixo.
const BR_OFFSET_MS = 3 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, '0');
function brData(isoUtc: string) {
  const b = new Date(new Date(isoUtc).getTime() - BR_OFFSET_MS);
  const dia = `${pad(b.getUTCDate())}/${pad(b.getUTCMonth() + 1)}`;
  const hora = `${b.getUTCHours()}h${b.getUTCMinutes() ? pad(b.getUTCMinutes()) : ''}`;
  return { dia, hora };
}
const primeiroNome = (nome: string | null | undefined) =>
  String(nome ?? '').trim().split(/\s+/)[0] ?? '';

// FALLBACKS: a Meta REJEITA parâmetro de template vazio — sem o fallback a reunião
// sem link ficava SEM lembrete nenhum (o send falhava e o claim retentava até a
// janela passar). E o campo link_reuniao vem com lixo em ~7% das reuniões ("." ","
// ou texto sem URL — atendente preenchendo qualquer coisa): só passa link que
// COMEÇA com http(s); o resto vira o texto neutro abaixo.
const LINK_FALLBACK = 'vou te enviar aqui na conversa';
const linkDaReuniao = (raw: string | null | undefined): string => {
  const link = String(raw ?? '').trim();
  return /^https?:\/\//i.test(link) ? link : LINK_FALLBACK;
};

// ── Toques (crm_lembrete_toques) ────────────────────────────────────────────
type Ctx = { nome: string; dia: string; hora: string; link: string };
type Toque = {
  id: string;
  minutos_antes: number;
  rotulo: string | null;
  template_name: string | null;
  template_lang: string;
  template_variaveis: string[]; // tokens NA ORDEM dos {{N}} do template
  texto_livre: string;
};

const TOKEN_VALOR: Record<string, (c: Ctx) => string> = {
  nome: (c) => c.nome,
  hora: (c) => c.hora,
  dia: (c) => c.dia,
  link: (c) => c.link,
};
// Token dinâmico (nome/hora/dia/link) OU texto fixo `fixo:<valor>` (ex.: `fixo:1`).
const resolverToken = (token: string, c: Ctx) =>
  token.startsWith('fixo:') ? token.slice(5) : (TOKEN_VALOR[token]?.(c) ?? '');
const resolverTextoLivre = (texto: string, c: Ctx) =>
  texto.replace(/\{(nome|hora|dia|link)\}/g, (_, t) => resolverToken(t, c));

async function carregarToques(): Promise<Toque[]> {
  const { data, error } = await supabase
    .from('crm_lembrete_toques')
    .select('id, minutos_antes, rotulo, template_name, template_lang, template_variaveis, texto_livre')
    .eq('ativo', true)
    .order('minutos_antes', { ascending: false });
  if (error) throw new Error(`select crm_lembrete_toques: ${error.message}`);
  return (data ?? []) as Toque[];
}

// ── Template por NÚMERO (override toque × conta Meta) ───────────────────────
type TplResolvido = { template_name: string; template_lang: string; template_variaveis: string[] };

// Mapa `${toque_id}:${wa_account_id}` → template daquela conta.
async function carregarTemplatesPorConta(toqueIds: string[]): Promise<Map<string, TplResolvido>> {
  const mapa = new Map<string, TplResolvido>();
  if (!toqueIds.length) return mapa;
  const { data, error } = await supabase
    .from('crm_lembrete_toque_contas')
    .select('toque_id, wa_account_id, template_name, template_lang, template_variaveis')
    .in('toque_id', toqueIds);
  if (error) { console.error(`[lembretes] select toque_contas: ${error.message}`); return mapa; }
  for (const r of data ?? []) {
    mapa.set(`${r.toque_id}:${r.wa_account_id}`, {
      template_name: r.template_name,
      template_lang: r.template_lang || 'pt_BR',
      template_variaveis: (r.template_variaveis ?? []) as string[],
    });
  }
  return mapa;
}

// Conta padrão = a MESMA resolução do crm-whatsapp-send (get_crm_wa_account com NULL):
// primeira conta ativa por created_at. Necessária p/ aplicar override na rota "padrão".
async function contaPadraoId(): Promise<string | null> {
  const { data, error } = await supabase
    .from('crm_whatsapp_accounts')
    .select('id')
    .eq('ativo', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) { console.error(`[lembretes] conta padrão: ${error.message}`); return null; }
  return (data?.id as string | null) ?? null;
}

// Template do toque PARA a conta = a LINHA daquela conta (crm_lembrete_toque_contas).
// SEM fallback pro template principal do toque: número sem linha NÃO envia o toque
// (cada número tem seu conjunto de toques; o principal foi materializado como linha
// pela migration 20260711150000 e as colunas template_* viraram compat).
function tplParaConta(
  toque: Toque,
  accountId: string | null,
  overrides: Map<string, TplResolvido>,
): TplResolvido | null {
  return (accountId ? overrides.get(`${toque.id}:${accountId}`) : undefined) ?? null;
}

// ── Roteamento do número que envia ──────────────────────────────────────────
// PRIORIDADE: 1) conta que o SDR ESCOLHEU no agendamento
// (agendamentos.lembrete_wa_account_id); 2) NÚMERO DA CONVERSA (conta do último inbound
// do lead = "o número que foi agendado"); 3) config do responsável (crm_lembrete_numeros);
// 4) conta padrão (só reunião do agente 'API SDR'). O fallback em cadeia (tenta a
// próxima se o envio falhar) vale SÓ entre números com linha no toque — e o toque em
// si só se aplica quando o NÚMERO DO LEAD (1 ?? 2) tem linha nele (ver cabeçalho).
type Rota =
  | { via: 'meta'; wa_account_id: string | null } // null = conta padrão (comportamento original)
  | { via: 'web'; wa_conexao_id: string };

const rotaKey = (r: Rota) => (r.via === 'web' ? `web:${r.wa_conexao_id}` : `meta:${r.wa_account_id ?? 'DEFAULT'}`);

// Variantes do telefone com/sem 9º dígito (formato 55DDD + 8/9), p/ casar o inbound.
function variantesTelefone(raw: string | null | undefined): string[] {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length < 12) return d ? [d] : [];
  const set = new Set<string>([d]);
  const m = d.match(/^(\d{2})(\d{2})(\d+)$/);
  if (m) {
    const [, pais, ddd, resto] = m;
    if (resto.length === 9 && resto.startsWith('9')) set.add(`${pais}${ddd}${resto.slice(1)}`); // tira o 9
    if (resto.length === 8) set.add(`${pais}${ddd}9${resto}`); // põe o 9
  }
  return [...set];
}

// Conta Meta da CONVERSA = número do último inbound do lead (usa idx_crm_wa_msg_telefone).
async function contaDaConversa(telefone: string | null | undefined): Promise<string | null> {
  const vars = variantesTelefone(telefone);
  if (!vars.length) return null;
  const { data, error } = await supabase
    .from('crm_whatsapp_messages')
    .select('wa_account_id')
    .in('telefone', vars)
    .eq('direcao', 'inbound')
    .not('wa_account_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) { console.error(`[lembretes] conta conversa: ${error.message}`); return null; }
  return (data?.wa_account_id as string | null) ?? null;
}

async function configResponsavel(ag: { id: string; origem: string | null; sdr_id: string | null }): Promise<Rota | null> {
  const origem = String(ag.origem ?? '');
  let responsavelId: string | null = null;
  if (IA_ORIGENS.includes(origem)) {
    // Reunião da IA: o responsável é o SDR-espelho (quem herdou o lead no SAC).
    const { data, error } = await supabase.rpc('agendamento_responsavel_espelho', { p_ag_id: ag.id });
    if (error) console.error(`[lembretes] espelho ${ag.id}: ${error.message}`);
    responsavelId = (data as string | null) ?? ag.sdr_id ?? null;
  } else {
    responsavelId = ag.sdr_id ?? null;
  }
  if (!responsavelId) return null;
  const { data: cfg, error } = await supabase
    .from('crm_lembrete_numeros')
    .select('canal, wa_account_id, wa_conexao_id')
    .eq('responsavel_id', responsavelId)
    .eq('ativo', true)
    .maybeSingle();
  if (error) console.error(`[lembretes] config ${responsavelId}: ${error.message}`);
  if (cfg?.canal === 'web' && cfg.wa_conexao_id) return { via: 'web', wa_conexao_id: cfg.wa_conexao_id };
  if (cfg?.canal === 'meta' && cfg.wa_account_id) return { via: 'meta', wa_account_id: cfg.wa_account_id };
  return null;
}

async function resolverRotas(
  ag: { id: string; origem: string | null; sdr_id: string | null; lembrete_wa_account_id: string | null },
  contaConv: string | null,
): Promise<Rota[]> {
  const rotas: Rota[] = [];
  const push = (r: Rota | null) => { if (r && !rotas.some((x) => rotaKey(x) === rotaKey(r))) rotas.push(r); };

  // 1) Conta escolhida pelo SDR no agendamento.
  if (ag.lembrete_wa_account_id) push({ via: 'meta', wa_account_id: ag.lembrete_wa_account_id });
  // 2) Número da conversa (o número agendado) — resolvido pelo chamador.
  if (contaConv) push({ via: 'meta', wa_account_id: contaConv });
  // 3) Config do responsável.
  push(await configResponsavel(ag));
  // 4) Conta padrão — só p/ reunião do agente (mantém o opt-in de reunião humana).
  if (String(ag.origem ?? '') === 'API SDR') push({ via: 'meta', wa_account_id: null });

  return rotas;
}

// Claim atômico: 1 linha por reunião × toque. true = consegui o claim (envio meu).
async function claim(agId: string, toqueId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('crm_lembrete_envios')
    .upsert(
      { agendamento_id: agId, toque_id: toqueId },
      { onConflict: 'agendamento_id,toque_id', ignoreDuplicates: true },
    )
    .select('agendamento_id');
  if (error) { console.error(`[lembretes] claim ${agId}×${toqueId}: ${error.message}`); return false; }
  return (data?.length ?? 0) > 0;
}
async function soltarClaim(agId: string, toqueId: string): Promise<void> {
  await supabase.from('crm_lembrete_envios').delete().eq('agendamento_id', agId).eq('toque_id', toqueId);
}

async function enviarTemplate(telefone: string, tpl: TplResolvido, ctx: Ctx, waAccountId: string | null): Promise<boolean> {
  const valores = (tpl.template_variaveis ?? []).map((t) => resolverToken(t, ctx));
  const components = valores.length
    ? [{ type: 'body', parameters: valores.map((v) => ({ type: 'text', text: String(v) })) }]
    : [];
  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      telefone,
      tipo: 'template',
      template_name: tpl.template_name,
      template_lang: tpl.template_lang || 'pt_BR',
      template_components: components,
      wa_account_id: waAccountId,
      // Lembrete é UTILITY (reunião iminente) → fura a trava de 24h de marketing. Sem isso o
      // crm-whatsapp-send bloqueava silenciosamente (HTTP 200) quando a lead pegou template do
      // disparo no mesmo dia → o claim ficava setado e o lembrete nunca chegava.
      forcar_template: true,
    }),
  });
  if (!res.ok) {
    console.error(`[lembretes] send HTTP ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}

// Linha WhatsApp Web (Uazapi): texto livre — sem janela 24h/template. Linha
// desconectada → o send devolve 409, o claim é solto e retenta no próximo tick.
async function enviarTexto(telefone: string, texto: string, waConexaoId: string): Promise<boolean> {
  const res = await fetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      telefone,
      tipo: 'text',
      conteudo: texto,
      wa_conexao_id: waConexaoId,
    }),
  });
  if (!res.ok) {
    console.error(`[lembretes] send (web) HTTP ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}

async function rodar(): Promise<{ toques: number; candidatos: number; enviados: number }> {
  const toques = await carregarToques();
  if (!toques.length) return { toques: 0, candidatos: 0, enviados: 0 };

  // Template por número + conta padrão (p/ resolver a linha da rota "padrão").
  const overrides = await carregarTemplatesPorConta(toques.map((t) => t.id));
  const padraoId = await contaPadraoId();
  const temLinha = (toque: Toque, accountId: string | null) =>
    !!accountId && overrides.has(`${toque.id}:${accountId}`);

  // Busca reuniões até o MAIOR toque à frente (ex.: toque de 24h ⇒ janela de 24h).
  const tetoMin = Math.max(...toques.map((t) => t.minutos_antes)) + FOLGA_MIN + 5;

  // TODAS as reuniões na janela (não só as da IA — a config por responsável pode
  // habilitar lembrete p/ reunião marcada por humano), não canceladas/realizadas/
  // já convertidas, com WhatsApp do lead. Quem NÃO tem rota (sem config e fora da IA)
  // é pulado em resolverRota().
  const { data, error } = await supabase
    .from('agendamentos')
    .select('id, data_agendamento, status, origem, sdr_id, link_reuniao, lembrete_wa_account_id, lead:leads!agendamentos_lead_id_fkey(nome, whatsapp)')
    .gt('data_agendamento', new Date().toISOString())
    .lt('data_agendamento', new Date(Date.now() + tetoMin * 60_000).toISOString())
    .not('status', 'in', '(cancelado,realizado,finalizado_venda)');
  if (error) throw new Error(`select agendamentos: ${error.message}`);

  const candidatos = data ?? [];
  if (!candidatos.length) return { toques: toques.length, candidatos: 0, enviados: 0 };

  // Envios já feitos (dedup) das reuniões da janela, numa consulta só.
  const { data: envios, error: envErr } = await supabase
    .from('crm_lembrete_envios')
    .select('agendamento_id, toque_id')
    .in('agendamento_id', candidatos.map((a) => a.id));
  if (envErr) throw new Error(`select crm_lembrete_envios: ${envErr.message}`);
  const jaEnviado = new Set((envios ?? []).map((e) => `${e.agendamento_id}:${e.toque_id}`));

  let enviados = 0;
  const agora = Date.now();

  for (const ag of candidatos) {
    const restaMin = (new Date(ag.data_agendamento).getTime() - agora) / 60_000;
    const lead = (ag as any).lead ?? {};
    const telefone = String(lead.whatsapp ?? '').trim();
    if (!telefone) continue;
    const { dia, hora } = brData(ag.data_agendamento);
    const ctx: Ctx = {
      nome: primeiroNome(lead.nome) || 'doutor(a)', // param vazio = rejeição da Meta
      dia,
      hora,
      link: linkDaReuniao(ag.link_reuniao),
    };

    // Só resolve a rota (RPC do espelho + config) quando há toque DEVIDO nesta reunião.
    const devidos = toques.filter((t) => {
      if (jaEnviado.has(`${ag.id}:${t.id}`)) return false;
      const piso = Math.max(t.minutos_antes - BANDA_MIN, PISO_MIN);
      const teto = t.minutos_antes + FOLGA_MIN;
      return restaMin >= piso && restaMin <= teto;
    });
    if (!devidos.length) continue;

    // Número DO LEAD = conta escolhida no agendamento ?? conta da conversa. É ele
    // que decide QUAIS toques valem pra esta reunião (cada número tem seu conjunto).
    const contaConv = await contaDaConversa(telefone);
    const contaLead = ((ag as any).lembrete_wa_account_id as string | null) ?? contaConv;
    const rotas = await resolverRotas(ag as any, contaConv);
    if (!rotas.length) continue; // sem número configurado e fora do padrão da IA → não lembra

    for (const toque of devidos) {
      // Rotas viáveis p/ ESTE toque: canal Meta exige a LINHA da conta no toque E o
      // toque precisa valer pro NÚMERO DO LEAD (lead de número sem linha NÃO recebe
      // este toque — nem via fallback por outro número). Web usa texto livre.
      const viaveis = rotas.filter((r) => {
        if (r.via === 'web') return true;
        if (!temLinha(toque, r.wa_account_id ?? padraoId)) return false;
        if (contaLead && !temLinha(toque, contaLead)) return false;
        return true;
      });
      if (!viaveis.length) {
        // Toque não vale pro número do lead / nenhuma rota com conteúdo: pula SEM
        // claim (se configurarem o template com a janela aberta, ainda sai num tick).
        console.log(`[lembretes] toque ${toque.minutos_antes}min não vale pro número do lead — pulado p/ ${ag.id}`);
        continue;
      }
      if (!(await claim(ag.id, toque.id))) continue; // outro tick pegou

      // Tenta a cadeia até um envio dar certo (conta escolhida → conversa → responsável → padrão),
      // cada rota Meta com a LINHA da própria conta.
      let ok = false;
      for (const rota of viaveis) {
        if (rota.via === 'web') {
          ok = await enviarTexto(telefone, resolverTextoLivre(toque.texto_livre, ctx), rota.wa_conexao_id);
        } else {
          const tpl = tplParaConta(toque, rota.wa_account_id ?? padraoId, overrides)!;
          ok = await enviarTemplate(telefone, tpl, ctx, rota.wa_account_id);
        }
        if (ok) {
          enviados++;
          console.log(`[lembretes] toque ${toque.minutos_antes}min enviado p/ ${telefone} via ${rotaKey(rota)} (reunião ${dia} ${hora})`);
          break;
        }
        console.warn(`[lembretes] rota ${rotaKey(rota)} falhou p/ ${ag.id}×${toque.id} — tentando próxima`);
      }
      if (!ok) await soltarClaim(ag.id, toque.id); // todas falharam: retenta no próximo tick
    }
  }
  return { toques: toques.length, candidatos: candidatos.length, enviados };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok');
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // Auth: mesmo segredo compartilhado dos crons do agente (x-followup-key).
  const { data: cfg } = await supabase
    .from('crm_agente_sdr_config')
    .select('followup_secret')
    .eq('id', 1)
    .maybeSingle();
  const segredo = cfg?.followup_secret ?? '';
  if (!segredo || req.headers.get('x-followup-key') !== segredo) {
    return json({ error: 'unauthorized' }, 401);
  }

  try {
    const r = await rodar();
    return json({ ok: true, ...r });
  } catch (e) {
    console.error('[lembretes] fatal:', e);
    return json({ error: (e as Error).message }, 500);
  }
});
