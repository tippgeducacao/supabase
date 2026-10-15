// Avisos de tarefa no WhatsApp (pedido do usuário, 15/10/2026): a tarefa CRIADA numa etapa
// vigiada, ou ARRASTADA para ela, vira um aviso na comunidade "Demandas do TI" — nome da tarefa,
// quem criou ou arrastou e o link. Régua pura, testada no vitest; fila e envio em
// avisosTarefasTick.ts. Quem enfileira é o gatilho gt_avisos_whatsapp_enfileirar (banco).

/** O front do sistema (docs/Infraestrutura e Deploy.md). */
export const URL_APP = "https://sistemappgvet.ppgeducacao.site";

export type EventoTarefa = "criada" | "movida";

export interface AvisoTarefa {
  evento: EventoTarefa;
  taskId: string;
  titulo: string | null;
  etapa: string | null; // a etapa vigiada (gt_list_statuses.name)
  autor: string | null; // profiles.name; null = automação ou sistema
}

export function linkTarefa(taskId: string): string {
  return `${URL_APP}/gestao-de-tarefas/tarefa/${taskId}`;
}

/** Só o primeiro nome e o sobrenome: o grupo lê melhor "Carlos Badia" que o nome de cartório. */
function nomeCurto(nome: string | null): string | null {
  const partes = String(nome ?? "").trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return null;
  return partes.length > 2 ? `${partes[0]} ${partes[partes.length - 1]}` : partes.join(" ");
}

export function textoAvisoTarefa(a: AvisoTarefa): string {
  const titulo = String(a.titulo ?? "").trim() || "(sem título)";
  const quem = nomeCurto(a.autor) ?? "uma automação";
  const etapa = String(a.etapa ?? "").trim() || "nova demanda";
  const linha = a.evento === "criada"
    ? `👤 Criada por *${quem}*`
    : `👤 *${quem}* arrastou para *${etapa}*`;
  return [
    a.evento === "criada" ? "🆕 *Nova demanda no TI*" : "➡️ *Demanda movida para a fila do TI*",
    "",
    `📌 *${titulo}*`,
    linha,
    `🔗 ${linkTarefa(a.taskId)}`,
  ].join("\n");
}
