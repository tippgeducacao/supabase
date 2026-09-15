import { buscarSupressoes, normalizarEmail } from "../_shared/supressao.ts";
import { normalizarContatosSegmentoEmail, resolverSegmentoEmail, type SegmentoEmail } from "../_shared/emailSegmentos.ts";

// O builder estrutural permite testar o worker sem Deno/provedores. As fontes e
// campos variáveis usam a whitelist do helper compartilhado emailSegmentos.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ClienteCampanhas = { from: (tabela: string) => any; rpc: (nome: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }> };
interface Contato { email: string; nome: string | null; metadata: Record<string, unknown> | null }
export interface Campanha { id: string; segmento_id: string; template_id: string; template_b_id?: string | null; remetente_id: string; fila_preparada_em?: string | null; throttle_ms?: number | null }
export interface EnvioCampanha { id: string; contato_email: string; contato_nome: string | null; contato_metadata: Record<string, unknown> | null; template_id?: string | null; variante?: "A" | "B" | null }
interface Dependencias { url: string; chave: string; enviar?: typeof fetch; esperar?: (ms: number) => Promise<void> }

export function normalizarContatos(contatos: unknown[]): Contato[] {
  const normalizados = normalizarContatosSegmentoEmail(contatos);
  if (normalizados.length > 100000) throw new Error("O segmento excede 100 mil destinatários. Divida o público antes de enviar.");
  if (normalizados.some(contato => contato.email.length > 320)) throw new Error("O segmento contém um endereço de e-mail longo demais.");
  return normalizados.map(contato => ({ ...contato,
    metadata: contato.metadata && typeof contato.metadata === "object" && !Array.isArray(contato.metadata) ? contato.metadata as Record<string, unknown> : null,
  }));
}

export async function resolverSegmento(cliente: ClienteCampanhas, segmento: SegmentoEmail): Promise<Contato[]> {
  // Prévia e envio compartilham fontes, filtros, paginação e remoção de inválidos.
  // O teto adicional é operacional e falha explicitamente, sem cortar o público.
  return normalizarContatos(await resolverSegmentoEmail(cliente, segmento));
}

export function montarPedidoCampanha(campanha: Campanha, envio: EnvioCampanha) {
  if (campanha.template_b_id && (!envio.template_id || !envio.variante)) throw new Error("Envio A/B sem variante registrada. A campanha foi interrompida.");
  return {
    template_id: envio.template_id ?? campanha.template_id, campanha_envio_id: envio.id,
    remetente_id: campanha.remetente_id, destinatario_email: envio.contato_email, destinatario_nome: envio.contato_nome,
    variaveis: { ...(envio.contato_metadata ?? {}), nome: envio.contato_nome ?? "", email: envio.contato_email },
    contexto_tipo: "campanha", contexto_id: campanha.id, idempotencia_key: `campanha:${envio.id}`,
  };
}

async function rpc(cliente: ClienteCampanhas, nome: string, args: Record<string, unknown>) {
  const { data, error } = await cliente.rpc(nome, args);
  if (error) throw new Error(error.message ?? "Falha ao atualizar a campanha.");
  return data;
}

export async function processarCampanha(cliente: ClienteCampanhas, campanha: Campanha, deps: Dependencias) {
  const token = crypto.randomUUID();
  const reserva = { p_campanha: campanha.id, p_token: token };
  if (!await rpc(cliente, "email_campanha_reservar", reserva)) return { reservada: false };
  const enviar = deps.enviar ?? fetch;
  const esperar = deps.esperar ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  try {
    // Preparação atômica: a primeira página nunca parece um segmento completo;
    // retentativas reaproveitam as linhas e suas chaves idempotentes.
    const { data: atual, error: erroAtual } = await cliente.from("email_campanhas").select("*").eq("id", campanha.id).single();
    if (erroAtual || !atual) throw new Error("Não foi possível consultar a campanha.");
    campanha = { ...campanha, ...atual };
    if (!atual.fila_preparada_em) {
      const { data: segmento, error } = await cliente.from("email_segmentos").select("*").eq("id", campanha.segmento_id).single();
      if (error || !segmento) throw new Error("Segmento não encontrado.");
      await rpc(cliente, "email_campanha_preparar", { ...reserva, p_contatos: await resolverSegmento(cliente, segmento) });
    } else {
      const { error } = await cliente.from("email_campanhas").update({ status: "enviando", iniciada_em: atual.iniciada_em ?? new Date().toISOString() })
        .eq("id", campanha.id).eq("processamento_token", token).eq("status", "agendada");
      if (error) throw new Error("Não foi possível iniciar a campanha preparada.");
    }
    const { data: lote, error: erroLote } = await cliente.from("email_campanhas_envios").select("*").eq("campanha_id", campanha.id).eq("status", "pendente").order("id").limit(50);
    if (erroLote) throw new Error("Não foi possível consultar os envios pendentes.");
    const pendentes = (lote ?? []) as EnvioCampanha[];
    const bloqueados = await buscarSupressoes(cliente, pendentes.map(envio => envio.contato_email));
    const { data: remetente, error: erroRemetente } = await cliente.from("email_remetentes").select("provider,ativo").eq("id", campanha.remetente_id).single();
    if (erroRemetente || !remetente?.ativo || !["resend", "ses"].includes(remetente.provider)) throw new Error("Escolha um remetente de disparo ativo para a campanha.");
    const throttle = Math.max(campanha.throttle_ms ?? 150, remetente.provider === "resend" ? 120 : 0);
    for (const envio of pendentes) {
      if (!await rpc(cliente, "email_campanha_reservar", reserva)) break;
      const atualizar = async (patch: Record<string, unknown>) => {
        const { error } = await cliente.from("email_campanhas_envios").update(patch).eq("id", envio.id).eq("status", "pendente");
        if (error) throw new Error("A resposta do envio não pôde ser registrada. A chave idempotente foi preservada.");
      };
      if (bloqueados.has(normalizarEmail(envio.contato_email))) {
        await atualizar({ status: "pulado", erro: "suprimido (bounce/spam/descadastro)" });
        continue;
      }
      // Falha de comunicação não autoriza trocar provedor nem criar outra chave.
      let resposta: Response;
      let resultado: Record<string, unknown>;
      try {
        resposta = await enviar(`${deps.url}/functions/v1/email-send`, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${deps.chave}` },
          body: JSON.stringify(montarPedidoCampanha(campanha, envio)), signal: AbortSignal.timeout(60000),
        });
        resultado = await resposta.json();
      } catch {
        await atualizar({ status: "falhou", erro: "Sem confirmação do envio. Confira o log antes de qualquer reenvio." });
        continue;
      }
      const logId = resultado.log_id ?? resultado.id;
      if (resposta.ok && resultado.suprimido) {
        await atualizar({ status: "pulado", erro: "suprimido na conferência final do envio" });
      } else if (resposta.ok && resultado.ok !== false && typeof logId === "string") {
        await atualizar({ status: "enviado", enviado_em: new Date().toISOString(), email_enviado_id: logId });
      } else {
        await atualizar({ status: "falhou", erro: String(resultado.error ?? "Envio não confirmado pelo provedor.").slice(0, 500), ...(typeof logId === "string" ? { email_enviado_id: logId } : {}) });
        if (resposta.status === 429) {
          const { error } = await cliente.from("email_campanhas").update({ status: "pausada", ultimo_erro: `Limite de envios ${remetente.provider}. Confira as falhas antes de retomar.` }).eq("id", campanha.id).eq("processamento_token", token).in("status", ["agendada", "enviando"]);
          if (error) throw new Error("Não foi possível pausar a campanha após o limite do provedor.");
          break;
        }
      }
      await esperar(throttle);
    }
    await rpc(cliente, "email_campanha_recontar", reserva);
    return { reservada: true };
  } finally {
    await rpc(cliente, "email_campanha_liberar", reserva);
  }
}
