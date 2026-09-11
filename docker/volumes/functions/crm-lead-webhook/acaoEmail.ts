/**
 * E-mail opt-in do webhook. A reserva persiste antes de chamar o motor de envio:
 * uma resposta incerta não autoriza repetir uma mensagem na próxima captação.
 * Não guarda o payload nem a chave do provedor; o destino vem do contato salvo.
 */
import { renderizarEmailWebhook } from "../email-send/renderizacaoWebhook.ts";
export interface LeadEmail {
  id: string;
  nome: string | null;
  email: string | null;
  whatsapp: string | null;
  curso_interesse: string | null;
}
export interface TemplateEmail {
  id: string;
  ativo: boolean;
  assunto: string;
  corpo_html: string;
  corpo_texto: string | null;
  uso?: string;
}
export interface RemetenteEmail {
  id: string;
  ativo: boolean;
  provider: string;
  dominio_verificado: boolean;
}
export interface ResultadoAcaoEmail {
  acao_id: string | null;
  status: "enviado" | "suprimido" | "duplicado" | "erro" | "ignorado";
  motivo?: string;
  log_id?: string;
}
export interface ReservaEmail {
  chave: string;
  integration_id: string;
  acao_id: string;
  lead_id: string;
  template_id: string;
  remetente_id: string;
}
export interface PayloadEmailWebhook {
  template_id: string;
  remetente_id: string;
  destinatario_email: string;
  destinatario_nome: string;
  variaveis: Record<string, string>;
  contexto_tipo: "webhook";
  contexto_id: string;
  idempotencia_key: string;
}
export interface DependenciasAcaoEmail {
  carregarLead(id: string): Promise<LeadEmail | null>;
  carregarTemplate(id: string): Promise<TemplateEmail | null>;
  carregarRemetente(id: string): Promise<RemetenteEmail | null>;
  /** true exclusivamente para quem inseriu a chave única; conflitos retornam false. */
  reservar(reserva: ReservaEmail): Promise<boolean>;
  finalizar(chave: string, resultado: ResultadoAcaoEmail): Promise<void>;
  enviar(payload: PayloadEmailWebhook): Promise<{ ok: boolean; status: number; corpo: unknown }>;
  resolverVariavel(modelo: string, dados: unknown): string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VARIAVEL = /^[\w.]{1,100}$/;
const temControles = (valor: string) => [...valor].some((letra) => letra.charCodeAt(0) < 32 || letra.charCodeAt(0) === 127);
const objeto = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function normalizarDestinatarioEmail(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const email = valor.trim().toLowerCase();
  if (email.length > 254 || temControles(email)) return null;
  const [local, dominio, extra] = email.split("@");
  if (extra !== undefined || !local || local.length > 64 || !dominio || !dominio.includes(".")) return null;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (!dominio.split(".").every((parte) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(parte))) return null;
  return email;
}

function conteudoEmailLegivel(html: string): boolean {
  // Modelos antigos podem ser fragmentos HTML. Exigir html/body descartaria
  // e-mails já válidos; o necessário é uma mensagem legível, e não só CSS vazio.
  const corpo = html.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const texto = corpo
    .replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "")
    .replace(/&(?:nbsp|#160|#x0*a0);/gi, " ").trim();
  return !!texto || /<img\b[^>]*\balt\s*=\s*(?:"[^"\s][^"]*"|'[^'\s][^']*')[^>]*>/i.test(corpo);
}

function validarModelo(modelo: string, variaveis: Record<string, string>, permiteDescadastro: boolean): boolean {
  let valido = true;
  const restante = modelo.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_token, chave: string) => {
    if (chave === "descadastro_url") {
      if (!permiteDescadastro) valido = false;
    } else if (!Object.hasOwn(variaveis, chave) || !variaveis[chave].trim()) valido = false;
    return "";
  });
  return valido && !/\{\{|\}\}|\{webhook=/i.test(restante);
}

async function chaveReserva(integrationId: string, acaoId: string, email: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(["crm-webhook-email/v1", integrationId, acaoId, email]));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Falhas desta ação nunca derrubam o cadastro nem as outras ações da integração. */
export async function executarAcaoEmail(entrada: {
  integrationId: string;
  acao: { id?: unknown; params?: unknown };
  leadId: string | null;
  dados: unknown;
}, deps: DependenciasAcaoEmail): Promise<ResultadoAcaoEmail> {
  const acaoId = typeof entrada.acao.id === "string" ? entrada.acao.id.trim() : "";
  const resultado = (status: ResultadoAcaoEmail["status"], motivo?: string): ResultadoAcaoEmail => ({
    acao_id: acaoId || null, status, ...(motivo ? { motivo } : {}),
  });
  if (!acaoId || acaoId.length > 200 || temControles(acaoId)) return resultado("ignorado", "acao_invalida");
  if (!UUID.test(entrada.integrationId) || !entrada.leadId || !UUID.test(entrada.leadId)) return resultado("ignorado", "contato_indisponivel");
  const params = entrada.acao.params;
  if (!objeto(params) || typeof params.template_id !== "string" || !UUID.test(params.template_id)
    || typeof params.remetente_id !== "string" || !UUID.test(params.remetente_id)) return resultado("ignorado", "configuracao_incompleta");
  if (params.variaveis !== undefined && !objeto(params.variaveis)) return resultado("ignorado", "variaveis_invalidas");

  let chave: string;
  let payload: PayloadEmailWebhook;
  try {
    // A consulta é executada depois das ações de edição: e-mail recebido no payload
    // não pode substituir um endereço já salvo, nem escolher template/remetente.
    const lead = await deps.carregarLead(entrada.leadId);
    const email = normalizarDestinatarioEmail(lead?.email);
    if (!lead || !email) return resultado("ignorado", "contato_sem_email_valido");
    const [template, remetente] = await Promise.all([
      deps.carregarTemplate(params.template_id), deps.carregarRemetente(params.remetente_id),
    ]);
    if (!template?.ativo) return resultado("ignorado", "template_indisponivel");
    if (!remetente?.ativo || !["resend", "ses"].includes(remetente.provider) || !remetente.dominio_verificado) {
      return resultado("ignorado", "remetente_indisponivel");
    }
    if (!template.assunto?.trim() || typeof template.corpo_html !== "string" || !conteudoEmailLegivel(template.corpo_html)) {
      return resultado("ignorado", "template_incompleto");
    }
    const nome = String(lead.nome ?? "").trim();
    const variaveis: Record<string, string> = Object.assign(Object.create(null), {
      nome, primeiro_nome: nome.split(/\s+/)[0] ?? "", email,
      telefone: String(lead.whatsapp ?? ""), curso: String(lead.curso_interesse ?? ""),
    });
    const mapeadas = params.variaveis ?? {};
    if (Object.keys(mapeadas).length > 100) return resultado("ignorado", "variaveis_invalidas");
    for (const [chaveVariavel, modelo] of Object.entries(mapeadas)) {
      if (!VARIAVEL.test(chaveVariavel) || ["descadastro_url", "__proto__", "prototype", "constructor"].includes(chaveVariavel)
        || typeof modelo !== "string" || modelo.length > 10_000) return resultado("ignorado", "variaveis_invalidas");
      // Resolver o texto inteiro sem validar cada token mascararia "Olá {ausente}".
      for (const token of modelo.match(/\{webhook=[^}]+\}/g) ?? []) {
        if (!deps.resolverVariavel(token, entrada.dados).trim()) return resultado("ignorado", "variavel_ausente");
      }
      const valor = deps.resolverVariavel(modelo, entrada.dados);
      if (!valor.trim() || /\{webhook=|\{\{|\}\}/i.test(valor)) return resultado("ignorado", "variavel_ausente");
      if (valor.length > 10_000) return resultado("ignorado", "variaveis_invalidas");
      variaveis[chaveVariavel] = valor;
    }
    if (Object.values(variaveis).some((v) => /\{webhook=|\{\{|\}\}/i.test(v))) return resultado("ignorado", "variavel_ausente");
    if (!validarModelo(template.assunto, variaveis, false) || !validarModelo(template.corpo_html, variaveis, true)
      || !validarModelo(template.corpo_texto ?? "", variaveis, true)) return resultado("ignorado", "variavel_ausente");
    const assunto = template.assunto.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => variaveis[k] ?? "");
    if (temControles(assunto)) return resultado("ignorado", "assunto_invalido");
    try {
      // A mesma regra roda novamente no motor de envio, preservando template_id
      // no histórico. Aqui impede consumir uma reserva com HTML/links inválidos.
      renderizarEmailWebhook({ assunto: template.assunto, corpoHtml: template.corpo_html,
        corpoTexto: template.corpo_texto, variaveis });
    } catch {
      return resultado("ignorado", "template_invalido");
    }

    chave = await chaveReserva(entrada.integrationId, acaoId, email);
    payload = {
      template_id: params.template_id, remetente_id: params.remetente_id,
      destinatario_email: email, destinatario_nome: nome, variaveis,
      contexto_tipo: "webhook", contexto_id: entrada.integrationId,
      idempotencia_key: `crm-webhook-email/v1/${chave}`,
    };
    const inseriu = await deps.reservar({
      chave, integration_id: entrada.integrationId, acao_id: acaoId, lead_id: lead.id,
      template_id: params.template_id, remetente_id: params.remetente_id,
    });
    if (!inseriu) return resultado("duplicado", "acao_ja_reservada");
  } catch {
    return resultado("erro", "consulta_ou_reserva_falhou");
  }

  let final: ResultadoAcaoEmail;
  try {
    const resposta = await deps.enviar(payload);
    const corpo = objeto(resposta.corpo) ? resposta.corpo : {};
    // HTTP 200 pode significar supressão ou dedup; só aceitação expressa é envio.
    if (resposta.ok && corpo.suprimido === true) final = resultado("suprimido", "destinatario_suprimido");
    else if (corpo.duplicado === true) final = resultado("duplicado", "envio_ja_registrado");
    else if (resposta.ok && corpo.ok === true && typeof corpo.log_id === "string" && UUID.test(corpo.log_id)) {
      final = { ...resultado("enviado"), log_id: corpo.log_id };
    } else final = resultado("erro", resposta.ok ? "resposta_invalida" : "envio_recusado");
    const logId = corpo.log_id ?? corpo.id;
    if (!final.log_id && typeof logId === "string" && UUID.test(logId)) final.log_id = logId;
  } catch {
    final = resultado("erro", "resultado_desconhecido");
  }
  try {
    await deps.finalizar(chave, final);
  } catch {
    // A reserva continua bloqueando novo envio. O log da captação mostra o estado
    // conhecido, sem transformar aceitação do provedor em autorização de repetição.
    final = { ...final, motivo: "registro_resultado_pendente" };
  }
  return final;
}
