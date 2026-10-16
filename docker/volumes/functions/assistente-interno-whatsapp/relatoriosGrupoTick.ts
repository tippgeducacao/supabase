// Tick dos relatórios no GRUPO (cron `assistente-relatorios-grupo-tick`, a cada 5 min,
// `?cron=relatorios_grupo`). A régua e o texto moram em relatoriosGrupo.ts; aqui só banco e envio.
//
// Para onde e por qual linha = assistente_relatorios_grupo (grupo_jid, wa_conexao_id, ativo);
// trocar de grupo, de linha ou desligar é UPDATE. Linha = uma linha do WhatsApp Web (wa_conexoes),
// enviada DIRETO pelo provider — nunca crm-whatsapp-send, que grava a conversa no CRM. Sem
// wa_conexao_id, sai pela linha própria do assistente interno.
//
// Comercial: segunda a sábado, janela 08:00–11:59 (domingo não sai; segunda = fim de semana).
// TI: assim que o time inteiro enviou, ou a partir do meio-dia de um dia de trabalho do TI, com
// quem enviou e quem faltou. Uma mensagem por dia cobrado, nos dois casos.
//
// `?previa=1` monta os dois textos (comercial de ontem e o TI do dia de referência) e devolve no
// JSON, sem enviar e sem travar. `&hoje=AAAA-MM-DD` finge que hoje é outro dia.
// `?teste=1` manda os dois textos JÁ para o grupo configurado (ligado ou não), marcados como teste
// e sem gravar a trava — o envio de verdade do dia continua acontecendo.
// `?grupos=1` lista os grupos da linha do relatório comercial (ou `&conexao=<id>` de outra) — é de
// lá que sai o grupo_jid.
import { getWaProvider } from "../_shared/waProviders.ts";
import { carregarLinhaDe, enviarTexto, type LinhaWa } from "./wa.ts";
import { hojeSP } from "./datas.ts";
import {
  deveEnviarTi, HORA_FECHA_TI, lerBloco, naJanelaComercial, periodoComercial, textoComercial,
  textoFeedbackTi, timeTiCompleto, type BlocoComercial, type RelatoTi,
} from "./relatoriosGrupo.ts";

type Relatorio = "comercial_diario" | "feedback_ti";
interface Destino { relatorio: Relatorio; grupo_jid: string | null; wa_conexao_id: string | null; ativo: boolean }

const spShift = (t: number) => new Date(t - 3 * 3600 * 1000); // Brasília = UTC-3, sem DST desde 2019

async function destinos(admin: any): Promise<Map<Relatorio, Destino>> {
  const { data, error } = await admin.from("assistente_relatorios_grupo")
    .select("relatorio, grupo_jid, wa_conexao_id, ativo");
  if (error) throw new Error(`assistente_relatorios_grupo: ${error.message}`);
  return new Map(((data ?? []) as Destino[]).map((d) => [d.relatorio, d]));
}

async function rpc(admin: any, nome: string, args: Record<string, unknown>): Promise<any> {
  const { data, error } = await admin.rpc(nome, args);
  if (error) throw new Error(`${nome}: ${error.message}`);
  return data;
}

/**
 * Um período do comercial, nas MESMAS funções da Torre/Placar (B2B e contas de teste fora) + as
 * vendas enviadas no período que ainda estão pendentes. Também usado pelo bot de comandos.
 */
export async function blocoComercial(admin: any, de: string, ate: string): Promise<BlocoComercial> {
  const args = { p_inicio: de, p_fim: ate, p_dept_b2b: null };
  const [placar, pendencias, vendasPendentes] = await Promise.all([
    rpc(admin, "placar_comercial_bloco", args),
    rpc(admin, "torre_sistema_pendencias", args),
    rpc(admin, "assist_vendas_pendentes", { p_de: de, p_ate: ate }),
  ]);
  return lerBloco(placar, pendencias, vendasPendentes);
}

/** O relatório comercial que sai `hoje` — null no domingo (não sai). */
async function montarComercial(admin: any, hoje: string): Promise<string | null> {
  const periodo = periodoComercial(hoje);
  if (!periodo) return null;
  const semanaIni: string = await rpc(admin, "torre_semana_inicio", { p_dia: periodo.fim });
  const [dia, semana] = await Promise.all([
    blocoComercial(admin, periodo.ini, periodo.fim),
    blocoComercial(admin, semanaIni, periodo.fim),
  ]);
  return textoComercial(periodo, semanaIni, dia, semana);
}

/** O dia que a trava do TI está cobrando hoje: o dia útil anterior. */
async function diaDoTi(admin: any, hoje: string): Promise<string> {
  return await rpc(admin, "feedback_ti_dia_util_anterior", { p_ref: hoje });
}

async function relatosTi(admin: any, dia: string): Promise<RelatoTi[]> {
  return ((await rpc(admin, "feedback_ti_consolidado_dia", { p_data: dia })) ?? []) as RelatoTi[];
}

async function enviarAoGrupo(linha: LinhaWa, grupoJid: string, texto: string): Promise<void> {
  const r = await enviarTexto(linha, grupoJid, texto);
  // A Uazapi devolve { ok:false } SEM lançar em não-2xx.
  if (r && (r as any).ok === false) throw new Error("envio recusado pelo provider (ok:false)");
}

async function jaEnviado(admin: any, chave: string): Promise<boolean> {
  const { data, error } = await admin.from("assistente_avisos").select("chave").eq("chave", chave).maybeSingle();
  if (error) throw new Error(`assistente_avisos: ${error.message}`);
  return !!data;
}

/**
 * Envia 1 vez por chave. A trava é a PK de assistente_avisos, gravada ANTES de enviar (dois ticks
 * juntos não duplicam); envio falhou → apaga a chave e o próximo tick tenta de novo.
 */
async function enviarUmaVez(
  admin: any, linha: LinhaWa, grupoJid: string, chave: string, tipo: string, texto: string,
): Promise<boolean> {
  const { error } = await admin.from("assistente_avisos").insert({ chave, canon: "grupo", tipo });
  if (error) {
    if (error.code === "23505") return false;
    throw new Error(`assistente_avisos: ${error.message}`);
  }
  try {
    await enviarAoGrupo(linha, grupoJid, texto);
  } catch (e) {
    await admin.from("assistente_avisos").delete().eq("chave", chave);
    throw e;
  }
  return true;
}

const MARCA_TESTE = "🧪 *TESTE* — mensagem de teste do sistema; o envio de verdade segue o horário normal.\n\n";

export async function processarRelatoriosGrupo(
  admin: any,
  opts: { previa?: string | null; teste?: string | null; grupos?: string | null; conexao?: string | null; hoje?: string | null } = {},
): Promise<Record<string, unknown>> {
  const cfg = await destinos(admin);
  const com = cfg.get("comercial_diario");
  const ti = cfg.get("feedback_ti");

  if (opts.grupos) {
    const linha = await carregarLinhaDe(admin, opts.conexao || com?.wa_conexao_id);
    return { grupos: await getWaProvider(linha.provider || "uazapi").listGroups(linha.server_url, linha.token) };
  }

  const hoje = opts.hoje && /^\d{4}-\d{2}-\d{2}$/.test(opts.hoje) ? opts.hoje : hojeSP();

  if (opts.previa || opts.teste) {
    const dia = await diaDoTi(admin, hoje);
    const [comercial, linhas] = await Promise.all([montarComercial(admin, hoje), relatosTi(admin, dia)]);
    const textoTi = textoFeedbackTi(dia, linhas);
    if (opts.previa) {
      return { previa: true, comercial, feedback_ti: { dia, completo: timeTiCompleto(linhas), texto: textoTi } };
    }
    const enviados: string[] = [];
    const erros: string[] = [];
    for (const [d, texto] of [[com, comercial], [ti, textoTi]] as [Destino | undefined, string | null][]) {
      if (!texto) { erros.push(`${d?.relatorio ?? "?"}: não sai hoje (domingo)`); continue; }
      if (!d?.grupo_jid) { erros.push(`${d?.relatorio ?? "?"}: sem grupo_jid`); continue; }
      try {
        await enviarAoGrupo(await carregarLinhaDe(admin, d.wa_conexao_id), d.grupo_jid, MARCA_TESTE + texto);
        enviados.push(d.relatorio);
      } catch (e) {
        erros.push(`${d.relatorio}: ${(e as Error).message}`);
      }
    }
    return { teste: true, enviados, ...(erros.length ? { erros } : {}) };
  }

  const ligado = (d?: Destino) => !!(d?.ativo && d.grupo_jid);
  if (!ligado(com) && !ligado(ti)) return { desligado: true };

  const enviados: string[] = [];
  const erros: string[] = [];
  const hora = spShift(Date.now()).getUTCHours();

  if (ligado(com) && naJanelaComercial(hora) && periodoComercial(hoje)) {
    const chave = `grupo:comercial:${hoje}`;
    try {
      if (!(await jaEnviado(admin, chave))) {
        const texto = await montarComercial(admin, hoje);
        const linha = await carregarLinhaDe(admin, com!.wa_conexao_id);
        if (texto && await enviarUmaVez(admin, linha, com!.grupo_jid!, chave, "grupo_comercial", texto)) enviados.push("comercial");
      }
    } catch (e) {
      erros.push(`comercial: ${(e as Error).message}`);
    }
  }

  if (ligado(ti)) {
    try {
      const dia = await diaDoTi(admin, hoje);
      const chave = `grupo:feedback_ti:${dia}`;
      if (!(await jaEnviado(admin, chave))) {
        const linhas = await relatosTi(admin, dia);
        // Só pergunta ao banco se hoje é dia de trabalho do TI quando o meio-dia está em jogo.
        const diaDeTrabalho = !timeTiCompleto(linhas) && hora >= HORA_FECHA_TI
          ? !!(await rpc(admin, "feedback_ti_dia_util", { p_data: hoje }))
          : false;
        if (deveEnviarTi(linhas, hora, diaDeTrabalho)) {
          const linha = await carregarLinhaDe(admin, ti!.wa_conexao_id);
          if (await enviarUmaVez(admin, linha, ti!.grupo_jid!, chave, "grupo_feedback_ti", textoFeedbackTi(dia, linhas))) {
            enviados.push(`feedback_ti ${dia}`);
          }
        }
      }
    } catch (e) {
      erros.push(`feedback_ti: ${(e as Error).message}`);
    }
  }

  return { enviados, ...(erros.length ? { erros } : {}) };
}
