// Fila dos avisos de tarefa (`?cron=avisos_tarefas`). Chamado na hora pelo gatilho
// gt_avisos_whatsapp_enfileirar (a cutucada) e a cada 5 min pelo cron
// `assistente-avisos-tarefas-tick` (o que a cutucada perdeu). O texto mora em avisosTarefas.ts.
//
// Trava: cada linha da fila é REIVINDICADA antes do envio (UPDATE condicional em tentativas +
// reivindicado_em), então a cutucada e o cron juntos não mandam o mesmo aviso duas vezes.
// Envio falhou → solta a linha com o erro; até 5 tentativas, só avisos das últimas 24 h.
import { carregarLinhaDe, enviarTexto } from "./wa.ts";
import { textoAvisoTarefa, type EventoTarefa } from "./avisosTarefas.ts";

const MAX_TENTATIVAS = 5;
const POR_RODADA = 20;
const JANELA_MS = 24 * 3600 * 1000;
const REIVINDICACAO_VENCE_MS = 2 * 60 * 1000; // edge que morreu no meio solta a linha depois disso
const PAUSA_ENTRE_ENVIOS_MS = 800; // rajada (10 tarefas de uma vez) não sai cuspida no mesmo segundo

interface ItemFila {
  id: number;
  aviso_id: string;
  task_id: string;
  evento: EventoTarefa;
  autor_id: string | null;
  tentativas: number;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reivindicar(admin: any, item: ItemFila): Promise<boolean> {
  const vence = new Date(Date.now() - REIVINDICACAO_VENCE_MS).toISOString();
  const { data, error } = await admin.from("gt_avisos_whatsapp_fila")
    .update({ reivindicado_em: new Date().toISOString(), tentativas: item.tentativas + 1 })
    .eq("id", item.id)
    .eq("tentativas", item.tentativas)
    .is("enviado_em", null)
    .or(`reivindicado_em.is.null,reivindicado_em.lt.${vence}`)
    .select("id");
  if (error) throw new Error(`gt_avisos_whatsapp_fila: ${error.message}`);
  return (data ?? []).length > 0;
}

async function enviarItem(admin: any, item: ItemFila): Promise<void> {
  const { data: aviso, error: e1 } = await admin.from("gt_avisos_whatsapp")
    .select("status_id, grupo_jid, wa_conexao_id, ativo").eq("id", item.aviso_id).maybeSingle();
  if (e1) throw new Error(`gt_avisos_whatsapp: ${e1.message}`);
  if (!aviso?.ativo) throw new Error("aviso desligado");

  const [{ data: tarefa }, { data: etapa }, autor] = await Promise.all([
    admin.from("gt_tasks").select("title").eq("id", item.task_id).maybeSingle(),
    admin.from("gt_list_statuses").select("name").eq("id", aviso.status_id).maybeSingle(),
    item.autor_id
      ? admin.from("profiles").select("name").eq("id", item.autor_id).maybeSingle().then((r: any) => r.data)
      : Promise.resolve(null),
  ]);
  if (!tarefa) throw new Error("tarefa apagada");

  const texto = textoAvisoTarefa({
    evento: item.evento,
    taskId: item.task_id,
    titulo: tarefa.title,
    etapa: etapa?.name ?? null,
    autor: autor?.name ?? null,
  });
  const linha = await carregarLinhaDe(admin, aviso.wa_conexao_id);
  const r = await enviarTexto(linha, aviso.grupo_jid, texto);
  // A Uazapi devolve { ok:false } SEM lançar em não-2xx.
  if (r && (r as any).ok === false) throw new Error("envio recusado pelo provider (ok:false)");
}

export async function processarAvisosTarefas(admin: any): Promise<Record<string, unknown>> {
  const { data, error } = await admin.from("gt_avisos_whatsapp_fila")
    .select("id, aviso_id, task_id, evento, autor_id, tentativas")
    .is("enviado_em", null)
    .lt("tentativas", MAX_TENTATIVAS)
    .gte("criado_em", new Date(Date.now() - JANELA_MS).toISOString())
    .order("id")
    .limit(POR_RODADA);
  if (error) throw new Error(`gt_avisos_whatsapp_fila: ${error.message}`);

  let enviados = 0;
  const erros: string[] = [];
  for (const item of (data ?? []) as ItemFila[]) {
    if (!(await reivindicar(admin, item))) continue; // outro edge pegou
    if (enviados > 0) await dormir(PAUSA_ENTRE_ENVIOS_MS);
    try {
      await enviarItem(admin, item);
      await admin.from("gt_avisos_whatsapp_fila")
        .update({ enviado_em: new Date().toISOString(), erro: null }).eq("id", item.id);
      enviados++;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      // Aviso desligado ou tarefa apagada não se resolvem tentando de novo.
      const definitivo = msg === "aviso desligado" || msg === "tarefa apagada";
      await admin.from("gt_avisos_whatsapp_fila")
        .update({ erro: msg, reivindicado_em: null, ...(definitivo ? { tentativas: MAX_TENTATIVAS } : {}) })
        .eq("id", item.id);
      erros.push(`${item.id}: ${msg}`);
    }
  }
  return { enviados, ...(erros.length ? { erros } : {}) };
}
