// Tick do alerta de IA sem crédito (cron `assistente-alerta-ia-tick`, a cada 2 min,
// `?cron=alerta_ia`). A régua mora em alertaIa.ts; aqui só banco e envio.
//
// Canal = a linha WhatsApp PRÓPRIA do assistente interno (Uazapi). É de propósito: ela não
// depende da Anthropic nem da API oficial da Meta, então continua de pé quando a IA cai.
// Quem recebe = ia_alerta_destinatarios (padrão: o setor de TI). O telefone vem da coluna
// `telefone` ou, vazia, do rh_dados_pessoais do user_id.
import { carregarLinha, enviarTexto } from "./wa.ts";
import {
  JANELA_MIN, REPETIR_MIN, classificarErroIa, decidirAcao, resumirFalhas, telefoneParaEnvio,
  textoAlerta, textoVoltou, type EstadoIa, type ProvedorIa,
} from "./alertaIa.ts";

async function destinatarios(admin: any): Promise<{ telefones: string[]; semTelefone: string[] }> {
  const { data, error } = await admin.from("ia_alerta_destinatarios")
    .select("nome, telefone, user_id").eq("ativo", true);
  if (error) throw new Error(`ia_alerta_destinatarios: ${error.message}`);
  const linhas = (data ?? []) as { nome: string | null; telefone: string | null; user_id: string | null }[];
  const ids = linhas.filter((l) => !l.telefone && l.user_id).map((l) => l.user_id!);
  const rh = new Map<string, string | null>();
  if (ids.length) {
    const { data: pes } = await admin.from("rh_dados_pessoais").select("user_id, telefone").in("user_id", ids);
    for (const p of (pes ?? []) as any[]) rh.set(p.user_id, p.telefone);
  }
  const telefones = new Set<string>();
  const semTelefone: string[] = [];
  for (const l of linhas) {
    const t = telefoneParaEnvio(l.telefone || (l.user_id ? rh.get(l.user_id) : null));
    if (t) telefones.add(t); else semTelefone.push(l.nome || l.user_id || "?");
  }
  return { telefones: [...telefones], semTelefone };
}

/** Manda para todos; conta quantos a Uazapi aceitou (ela devolve ok:false sem lançar). */
async function enviarATodos(admin: any, texto: string, erros: string[]): Promise<number> {
  const { telefones, semTelefone } = await destinatarios(admin);
  if (semTelefone.length) erros.push(`sem telefone válido: ${semTelefone.join(", ")}`);
  if (!telefones.length) { erros.push("nenhum destinatário com telefone"); return 0; }
  const linha = await carregarLinha(admin);
  if (!linha) { erros.push("sem linha WhatsApp ativa do assistente"); return 0; }
  let ok = 0;
  for (const t of telefones) {
    try {
      const r = await enviarTexto(linha, t, texto);
      if (r && (r as any).ok === false) erros.push(`envio ${t.slice(-4)}: recusado (ok:false)`); else ok++;
    } catch (e) {
      erros.push(`envio ${t.slice(-4)}: ${(e as Error).message}`);
    }
  }
  return ok;
}

/** Total e leads do apagão inteiro (só no "voltou", 1 consulta por recuperação). */
async function numerosDoApagao(admin: any, provedor: ProvedorIa, de: string, ate: string) {
  const prefixo = provedor === "anthropic" ? "Anthropic:%" : provedor === "openai" ? "OpenAI:%" : "deepseek:%";
  const jids = new Set<string>();
  let total = 0;
  // Paginado: o PostgREST corta em 1.000 linhas por pedido (o apagão de 22/09 teve 867).
  for (let de0 = 0; de0 < 20000; de0 += 1000) {
    const { data, error } = await admin.from("crm_agente_sdr_eventos")
      .select("erro, remotejid").gte("criado_em", de).lte("criado_em", ate)
      .ilike("erro", prefixo).order("id").range(de0, de0 + 999);
    if (error) return { total: null, leads: null };
    for (const ev of (data ?? []) as any[]) {
      if (classificarErroIa(ev.erro)?.provedor !== provedor) continue;
      total++;
      if (ev.remotejid) jids.add(ev.remotejid);
    }
    if ((data ?? []).length < 1000) break;
  }
  return { total, leads: jids.size };
}

export async function processarAlertaIa(admin: any): Promise<Record<string, unknown>> {
  const agora = Date.now();
  const agoraIso = new Date(agora).toISOString();
  const desde = new Date(agora - JANELA_MIN * 60000).toISOString();

  const { data: eventos, error } = await admin.from("crm_agente_sdr_eventos")
    .select("erro, remotejid, criado_em").gte("criado_em", desde).not("erro", "is", null)
    .order("criado_em", { ascending: false }).limit(5000);
  if (error) throw new Error(`crm_agente_sdr_eventos: ${error.message}`);
  const resumo = resumirFalhas((eventos ?? []) as any[]);

  const { data: est, error: e2 } = await admin.from("ia_alerta_estado").select("*");
  if (e2) throw new Error(`ia_alerta_estado: ${e2.message}`);
  const estados = new Map<string, EstadoIa>(((est ?? []) as EstadoIa[]).map((e) => [e.provedor, e]));

  const provedores = new Set<ProvedorIa>([...resumo.keys()]);
  for (const e of estados.values()) if (e.falhando_desde) provedores.add(e.provedor as ProvedorIa);

  const acoes: Record<string, string> = {};
  const erros: string[] = [];
  for (const p of provedores) {
    const falhas = resumo.get(p);
    let estado = estados.get(p);

    // Registra a falha mais recente (o "voltou" precisa dela, e o tick só enxerga 10 min).
    if (falhas && (!estado?.ultima_falha_em || falhas.ultima > estado.ultima_falha_em)) {
      await admin.from("ia_alerta_estado").upsert(
        { provedor: p, ultima_falha_em: falhas.ultima, motivo: falhas.motivo, atualizado_em: agoraIso },
        { onConflict: "provedor" },
      );
      estado = { provedor: p, falhando_desde: estado?.falhando_desde ?? null, ultimo_alerta_em: estado?.ultimo_alerta_em ?? null, ultima_falha_em: falhas.ultima };
    }

    let ultimoSucesso: string | null = null;
    if (!falhas && estado?.falhando_desde) {
      const { data: ok } = await admin.from("crm_agente_sdr_eventos").select("criado_em")
        .eq("tipo", "llm_chamada").eq("dados->>provedor", p)
        .gt("criado_em", estado.ultima_falha_em ?? estado.falhando_desde)
        .order("criado_em", { ascending: false }).limit(1).maybeSingle();
      ultimoSucesso = ok?.criado_em ?? null;
    }

    const acao = decidirAcao({ falhas, estado, ultimoSucesso, agora });
    acoes[p] = acao;

    if (acao === "alertar" || acao === "lembrar") {
      // Trava: só quem vira o ultimo_alerta_em manda (dois ticks juntos não duplicam).
      const limite = new Date(agora - REPETIR_MIN * 60000).toISOString();
      const falhandoDesde = estado?.falhando_desde ?? falhas!.primeira;
      const { data: pego } = await admin.from("ia_alerta_estado")
        .update({ ultimo_alerta_em: agoraIso, falhando_desde: falhandoDesde, atualizado_em: agoraIso })
        .eq("provedor", p)
        .or(`ultimo_alerta_em.is.null,ultimo_alerta_em.lt."${limite}"`)
        .select("provedor");
      if (!pego?.length) { acoes[p] = "travado"; continue; }
      const enviados = await enviarATodos(admin, textoAlerta(falhas!, falhandoDesde, acao === "lembrar"), erros);
      if (!enviados) {
        // Ninguém recebeu: devolve a trava para o próximo tick tentar de novo.
        await admin.from("ia_alerta_estado")
          .update({ ultimo_alerta_em: estado?.ultimo_alerta_em ?? null, falhando_desde: estado?.falhando_desde ?? null })
          .eq("provedor", p);
        acoes[p] = `${acao}_falhou`;
      } else {
        acoes[p] = `${acao}:${enviados}`;
      }
    } else if (acao === "voltou" || acao === "esquecer") {
      const { data: pego } = await admin.from("ia_alerta_estado")
        .update({ falhando_desde: null, ultimo_alerta_em: null, atualizado_em: agoraIso })
        .eq("provedor", p).not("falhando_desde", "is", null)
        .select("provedor");
      if (!pego?.length || acao === "esquecer") continue;
      const ultimaFalha = estado!.ultima_falha_em ?? estado!.falhando_desde!;
      const { total, leads } = await numerosDoApagao(admin, p, estado!.falhando_desde!, ultimaFalha);
      // "Voltou" é cortesia: se falhar o envio, não se repete (a IA já está de pé).
      const enviados = await enviarATodos(admin, textoVoltou(p, estado!.falhando_desde!, ultimaFalha, total, leads), erros);
      acoes[p] = `voltou:${enviados}`;
    }
  }

  return { acoes, ...(erros.length ? { erros } : {}) };
}
