import { AcessoNegado } from "../_shared/acessoRegra.ts";

export interface ContextoIa {
  usuarioId: string;
  canalId: string;
  departamentoId: string | null;
  listas?: Promise<Map<string, string>>;
}

export async function contextoAutorizado(cliente: any, usuarioId: string, canalId: string): Promise<ContextoIa> {
  const [perfil, canal, escrita] = await Promise.all([
    cliente.from("profiles").select("ativo").eq("id", usuarioId).maybeSingle(),
    cliente.from("gt_chat_channels").select("id, department_id, archived_at").eq("id", canalId).maybeSingle(),
    // O helper antigo libera type=task sem conferir a tarefa; este também valida lista,
    // pasta e tarefa pessoal/da liderança, com auth.uid() decidido no banco.
    cliente.rpc("gt_ia_pode_usar_canal", { p_canal: canalId }),
  ]);
  if (perfil.error || canal.error || escrita.error) throw new AcessoNegado(503, "Não foi possível conferir o canal.");
  if (perfil.data?.ativo !== true || !canal.data || canal.data.archived_at || escrita.data !== true) {
    throw new AcessoNegado(403, "Você não pode usar a IA neste canal.");
  }
  // O setor vem do canal lido pela sessão. department_id/user_id do corpo são ignorados.
  return { usuarioId, canalId: canal.data.id, departamentoId: canal.data.department_id ?? null };
}

/** Só listas visíveis no setor do canal, com a mesma permissão efetiva usada pelo Gestor. */
export function listasAutorizadas(cliente: any, contexto: ContextoIa): Promise<Map<string, string>> {
  contexto.listas ??= (async () => {
    const permitidas = new Map<string, string>();
    if (!contexto.departamentoId) return permitidas;
    const tamanho = 100;
    for (let inicio = 0; ; inicio += tamanho) {
      const { data, error } = await cliente.from("gt_task_lists")
        .select("id, gt_projects!inner(department_id)")
        .eq("gt_projects.department_id", contexto.departamentoId)
        .order("id").range(inicio, inicio + tamanho - 1);
      if (error) throw new AcessoNegado(503, "Não foi possível conferir as listas.");
      // Limita a concorrência das RPCs; o helper em lote legado não respeita todas as listas ocultas.
      for (let i = 0; i < (data ?? []).length; i += 10) {
        await Promise.all(data.slice(i, i + 10).map(async (lista: { id: string }) => {
          const { data: permissao, error: erro } = await cliente.rpc("gt_get_effective_list_permission", {
            _user_id: contexto.usuarioId, _list_id: lista.id,
          });
          if (erro) throw new AcessoNegado(503, "Não foi possível conferir a permissão da lista.");
          if (["view", "comment", "edit", "full_edit"].includes(permissao)) permitidas.set(lista.id, permissao);
        }));
      }
      if ((data ?? []).length < tamanho) return permitidas;
    }
  })();
  return contexto.listas;
}

/** A view global soma tarefas de outras listas e tem department_id nulo; agregamos só o recorte autorizado. */
export async function metricasAutorizadas(cliente: any, listas: string[], nome?: string): Promise<unknown> {
  const agora = new Date();
  const hoje = agora.toISOString().slice(0, 10);
  const mes = `${hoje.slice(0, 7)}-01`;
  const ha30 = agora.getTime() - 30 * 86400000;
  const porPessoa = new Map<string, { abertas: number; atrasadas: number; concluidas_mes: number; prazo: number; noPrazo: number; somaDias: number; totalDias: number }>();
  for (let inicio = 0; ; inicio += 500) {
    const { data, error } = await cliente.from("gt_tasks")
      .select("id, assignee_id, due_date, completed_at, created_at, is_archived, gt_task_assignees(user_id)")
      .in("list_id", listas).order("id").range(inicio, inicio + 499);
    if (error) throw new Error("Não foi possível consultar as métricas autorizadas.");
    for (const tarefa of data ?? []) {
      const ids = new Set<string>([tarefa.assignee_id, ...(tarefa.gt_task_assignees ?? []).map((a: any) => a.user_id)].filter(Boolean));
      for (const id of ids) {
        const m = porPessoa.get(id) ?? { abertas: 0, atrasadas: 0, concluidas_mes: 0, prazo: 0, noPrazo: 0, somaDias: 0, totalDias: 0 };
        if (!tarefa.completed_at && !tarefa.is_archived) {
          m.abertas++;
          if (tarefa.due_date && tarefa.due_date < hoje) m.atrasadas++;
        }
        if (tarefa.completed_at && tarefa.completed_at >= mes) {
          m.concluidas_mes++;
          if (tarefa.due_date) {
            m.prazo++;
            if (tarefa.completed_at.slice(0, 10) <= tarefa.due_date) m.noPrazo++;
          }
        }
        if (tarefa.completed_at && Date.parse(tarefa.completed_at) >= ha30) {
          m.somaDias += (Date.parse(tarefa.completed_at) - Date.parse(tarefa.created_at)) / 86400000;
          m.totalDias++;
        }
        porPessoa.set(id, m);
      }
    }
    if ((data ?? []).length < 500) break;
  }
  const colaboradores = [];
  const ids = [...porPessoa.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await cliente.from("profiles").select("id, name").in("id", ids.slice(i, i + 200));
    if (error) throw new Error("Não foi possível consultar os responsáveis.");
    for (const perfil of data ?? []) {
      if (nome && !perfil.name?.toLowerCase().includes(nome.toLowerCase())) continue;
      const m = porPessoa.get(perfil.id)!;
      colaboradores.push({ nome: perfil.name, abertas: m.abertas, atrasadas: m.atrasadas,
        concluidas_mes: m.concluidas_mes, no_prazo: `${(m.prazo ? 100 * m.noPrazo / m.prazo : 0).toFixed(2)}%`,
        media_dias: (m.totalDias ? m.somaDias / m.totalDias : 0).toFixed(2) });
    }
  }
  return { escopo: "Somente as listas autorizadas neste canal", colaboradores };
}
