// Agenda de entrevistas do RH no WhatsApp do dono (pedido do Rafael, 11/09/2026):
//   · às 8h, o resumo do dia: horário, candidato, área, formato e WhatsApp;
//   · 30 min antes de cada entrevista, o aviso "daqui a 30 minutos você tem entrevista com…".
// Fonte = rh_entrevistas_agenda(), a MESMA do botão "Agenda Entrevistas" do funil de RH.
// Quem recebe = assistente_donos.recebe_agenda_entrevistas; como é chamado = .apelido
// (os dois por UPDATE, sem deploy). Chamado 1x/min pelo cron `assistente-entrevistas-tick`.
import { carregarLinha, enviarTexto, type LinhaWa } from "./wa.ts";
import { logMensagem } from "./db.ts";
import { hojeSP, janela, fmtData } from "./datas.ts";

const HORA_RESUMO = 8;
// Tick perdido às 8h (edge fora do ar) ainda manda o resumo até 11h59. Depois disso a manhã
// passou e o resumo chegaria listando entrevista que já aconteceu.
const HORA_LIMITE_RESUMO = 12;
const MIN_AVISO = 30;
const DIAS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

interface DonoAgenda { canon: string; nome: string | null; apelido: string | null }
interface Entrevista {
  id: string;
  candidato: string;
  area: string;
  whatsapp: string | null;
  inicio: string;
  modalidade?: string | null;
  link_online?: string | null;
}

const spShift = (t: number) => new Date(t - 3 * 3600 * 1000); // Brasília = UTC-3, sem DST desde 2019
const horaSP = (iso: string) => spShift(new Date(iso).getTime()).toISOString().slice(11, 16);
const chamar = (d: DonoAgenda) => (d.apelido || (d.nome || "").split(" ")[0] || "").trim();

function diaPorExtenso(ymd: string): string {
  return `${DIAS[new Date(`${ymd}T12:00:00Z`).getUTCDay()]}, ${fmtData(ymd)}`;
}

function formato(e: Entrevista): string {
  if (e.modalidade === "online") return e.link_online ? `online: ${e.link_online}` : "online (sala ainda sem link)";
  return "presencial";
}

/** Entrevistas MARCADAS com início em [de, ate), com formato e sala. */
async function entrevistas(admin: any, de: string, ate: string): Promise<Entrevista[]> {
  const { data, error } = await admin.rpc("rh_entrevistas_agenda", { p_de: de, p_ate: ate });
  if (error) throw new Error(`rh_entrevistas_agenda: ${error.message}`);
  // A função devolve também realizada/faltou (a tela mostra); aviso é só do que vai acontecer.
  const marcadas = ((data ?? []) as any[]).filter((e) => e.status === "marcada");
  if (!marcadas.length) return [];
  // Formato e sala não saem da função da agenda: vêm da própria tabela.
  const { data: extra, error: e2 } = await admin.from("rh_entrevistas")
    .select("id, modalidade, link_online").in("id", marcadas.map((e) => e.id));
  if (e2) throw new Error(`rh_entrevistas: ${e2.message}`);
  const porId = new Map(((extra ?? []) as any[]).map((x) => [x.id, x]));
  return marcadas.map((e) => ({ ...e, ...porId.get(e.id) }));
}

function textoResumo(dono: DonoAgenda, hoje: string, lista: Entrevista[]): string {
  const nome = chamar(dono);
  const saudacao = `☀️ Bom dia${nome ? `, ${nome}` : ""}!`;
  if (!lista.length) return `${saudacao} Hoje, ${diaPorExtenso(hoje)}, não tem entrevista marcada no RH.`;

  const itens = lista.map((e) => {
    const detalhe = [e.area, formato(e), e.whatsapp ? `WhatsApp ${e.whatsapp}` : null].filter(Boolean).join(" · ");
    return `*${horaSP(e.inicio)}* ${e.candidato}\n${detalhe}`;
  });
  const total = lista.length === 1
    ? "É 1 entrevista. Te aviso 30 minutos antes."
    : `São ${lista.length} entrevistas. Te aviso 30 minutos antes de cada uma.`;
  return `${saudacao} Suas entrevistas de hoje, ${diaPorExtenso(hoje)}:\n\n${itens.join("\n\n")}\n\n${total}`;
}

function textoAviso(dono: DonoAgenda, e: Entrevista, agora: number): string {
  const nome = chamar(dono);
  // Normalmente 30 (o tick roda no minuto cheio); menos quando a entrevista foi marcada em cima da hora.
  const min = Math.max(1, Math.ceil((new Date(e.inicio).getTime() - agora) / 60000));
  const quando = `daqui a ${min} minuto${min === 1 ? "" : "s"}`;
  const linhas = [
    `⏰ ${nome ? `${nome}, lembrando` : "Lembrando"} que ${quando}, às ${horaSP(e.inicio)}, você tem uma entrevista com *${e.candidato}* (${e.area}).`,
    `Formato: ${formato(e)}`,
  ];
  if (e.whatsapp) linhas.push(`WhatsApp: ${e.whatsapp}`);
  return linhas.join("\n");
}

/**
 * Envia 1 vez por chave. A trava é a PK de assistente_avisos (grava ANTES de enviar), não uma
 * consulta "já mandei?". Envio falhou → apaga a chave e o próximo minuto tenta de novo.
 */
async function avisarUmaVez(
  admin: any, linha: LinhaWa, dono: DonoAgenda, chave: string, tipo: string, texto: string,
): Promise<boolean> {
  const { error } = await admin.from("assistente_avisos").insert({ chave, canon: dono.canon, tipo });
  if (error) {
    if (error.code === "23505") return false; // já avisado
    throw new Error(`assistente_avisos: ${error.message}`);
  }
  try {
    // canon = DDD + 8 dígitos = o id do WhatsApp dos donos (DDD 46 não leva o 9º dígito no id).
    const r = await enviarTexto(linha, `55${dono.canon}`, texto);
    // A Uazapi devolve { ok:false } SEM lançar em não-2xx.
    if (r && (r as any).ok === false) throw new Error("envio recusado pelo provider (ok:false)");
  } catch (e) {
    await admin.from("assistente_avisos").delete().eq("chave", chave);
    throw e;
  }
  // Mandado fora do webhook → precisa entrar no histórico, senão o bot não sabe do que o dono fala
  // quando ele responde ao aviso.
  await logMensagem(admin, dono.canon, "outbound", texto, "texto").catch(() => {});
  return true;
}

export async function processarAgendaEntrevistas(
  admin: any,
): Promise<{ resumos: number; avisos: number; erros?: string[] }> {
  const { data: donos, error } = await admin.from("assistente_donos")
    .select("canon, nome, apelido").eq("ativo", true).eq("recebe_agenda_entrevistas", true);
  if (error) throw new Error(`assistente_donos: ${error.message}`);
  if (!donos?.length) return { resumos: 0, avisos: 0 };
  const linha = await carregarLinha(admin);
  if (!linha) return { resumos: 0, avisos: 0, erros: ["sem linha WhatsApp ativa"] };

  const agora = Date.now();
  const hoje = hojeSP();
  const hora = spShift(agora).getUTCHours();
  let resumos = 0, avisos = 0;
  const erros: string[] = [];

  // 1) Resumo do dia, às 8h. Só consulta a agenda enquanto falta resumo para alguém.
  if (hora >= HORA_RESUMO && hora < HORA_LIMITE_RESUMO) {
    const chaves = (donos as DonoAgenda[]).map((d) => `resumo:${d.canon}:${hoje}`);
    const { data: feitos } = await admin.from("assistente_avisos").select("chave").in("chave", chaves);
    const jaFeito = new Set(((feitos ?? []) as any[]).map((f) => f.chave));
    const faltam = (donos as DonoAgenda[]).filter((d) => !jaFeito.has(`resumo:${d.canon}:${hoje}`));
    if (faltam.length) {
      const { de, ate } = janela({ periodo: "hoje" });
      const lista = await entrevistas(admin, de, ate);
      for (const dono of faltam) {
        try {
          if (await avisarUmaVez(admin, linha, dono, `resumo:${dono.canon}:${hoje}`, "resumo_entrevistas", textoResumo(dono, hoje, lista))) resumos++;
        } catch (e) {
          erros.push(`resumo ${dono.canon}: ${(e as Error).message}`);
        }
      }
    }
  }

  // 2) Aviso 30 min antes: toda entrevista marcada que começa nos próximos 30 min. A chave leva
  //    o início, então remarcar gera aviso novo para o horário novo.
  const proximas = await entrevistas(admin, new Date(agora).toISOString(), new Date(agora + MIN_AVISO * 60000).toISOString());
  for (const e of proximas) {
    for (const dono of donos as DonoAgenda[]) {
      try {
        if (await avisarUmaVez(admin, linha, dono, `aviso30:${dono.canon}:${e.id}:${e.inicio}`, "aviso_entrevista", textoAviso(dono, e, agora))) avisos++;
      } catch (err) {
        erros.push(`aviso ${e.id}: ${(err as Error).message}`);
      }
    }
  }

  return { resumos, avisos, ...(erros.length ? { erros } : {}) };
}
