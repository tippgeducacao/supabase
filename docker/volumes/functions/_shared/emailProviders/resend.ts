/** Resend via REST, com fetch injetável e sem reenvio automático após resposta incerta. */
import { comoLista, ErroEnvio, type EmailProvider, type OutboundEmail, type ResultadoEnvio } from "./types.ts";

export interface OpcoesResend {
  apiKey?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

function lerEnv(chave: string): string | undefined {
  const g = globalThis as { Deno?: { env: { get(k: string): string | undefined } } };
  return g.Deno?.env.get(chave)?.trim();
}

export function temCredencialResend(): boolean {
  return !!lerEnv("RESEND_API_KEY");
}

// Mensagens do provedor podem repetir destinatário, corpo ou credencial. Somente
// códigos conhecidos viram erro público/log; nunca propagamos o texto recebido.
const ERROS: Record<string, string> = {
  missing_api_key: "A chave de API do Resend não foi aceita.",
  restricted_api_key: "A chave do Resend está inativa ou não permite esta operação.",
  invalid_permission: "A chave do Resend não tem permissão para esta operação.",
  suspended_api_key: "A chave do Resend está suspensa. Confira a conta no Resend.",
  validation_error: "O Resend recusou os dados do envio. Confira o remetente, a verificação do domínio e o conteúdo.",
  invalid_attachment: "O Resend recusou um anexo do e-mail.",
  invalid_parameter: "O Resend recusou um parâmetro do envio.",
  missing_required_field: "Um campo obrigatório do envio não foi preenchido.",
  missing_required_parameter: "Um parâmetro obrigatório do envio não foi preenchido.",
  invalid_idempotency_key: "A chave de idempotência do envio é inválida.",
  invalid_idempotent_request: "A chave deste envio já foi usada com outro conteúdo. O envio não foi repetido.",
  concurrent_idempotent_requests: "Este envio já está sendo processado pelo Resend. Aguarde a confirmação antes de reenviar.",
  daily_quota_exceeded: "A cota diária de e-mails do Resend foi atingida.",
  monthly_quota_exceeded: "A cota mensal de e-mails do Resend foi atingida.",
  rate_limit_exceeded: "O limite de requisições do Resend foi atingido. Aguarde antes de retomar a campanha.",
  application_error: "O Resend apresentou uma falha. Confira o resultado no provedor antes de reenviar.",
  service_unavailable: "O Resend está indisponível. Confira o resultado no provedor antes de reenviar.",
};

function traduzirErro(status: number, corpo: unknown): ErroEnvio {
  const nome = corpo && typeof corpo === "object" && "name" in corpo ? corpo.name : undefined;
  const codigo = typeof nome === "string" && Object.hasOwn(ERROS, nome) ? nome : `resend_http_${status}`;
  return new ErroEnvio(ERROS[codigo] ?? `O Resend recusou a operação (HTTP ${status}).`, {
    status, codigo, rateLimited: status === 429,
    // Nem timeout nem 5xx autorizam uma segunda entrega: quem chama deve primeiro
    // conferir o log original. O cliente não repete nenhuma requisição sozinho.
    repetivel: status === 429,
  });
}

async function requisitarResend(caminho: string, init: RequestInit, opcoes: OpcoesResend): Promise<unknown> {
  const apiKey = (opcoes.apiKey ?? lerEnv("RESEND_API_KEY"))?.trim();
  if (!apiKey) throw new ErroEnvio("Configure a chave de API do Resend no servidor.", {
    codigo: "resend_sem_credencial", repetivel: false,
  });
  try {
    const resposta = await (opcoes.fetcher ?? fetch)(`https://api.resend.com${caminho}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(opcoes.timeoutMs ?? 20_000),
      redirect: "error",
    });
    const corpo: unknown = await resposta.json().catch(() => null);
    if (!resposta.ok) throw traduzirErro(resposta.status, corpo);
    return corpo;
  } catch (erro) {
    if (erro instanceof ErroEnvio) throw erro;
    throw new ErroEnvio("Não foi possível confirmar a resposta do Resend. Confira o resultado no provedor antes de reenviar.", {
      codigo: "resend_resultado_incerto", repetivel: false,
    });
  }
}

export class ResendProvider implements EmailProvider {
  readonly nome = "resend" as const;
  constructor(private readonly opcoes: OpcoesResend = {}) {}

  async send(msg: OutboundEmail): Promise<ResultadoEnvio> {
    if (comoLista(msg.to).length === 0) throw new ErroEnvio("Sem destinatário.", { repetivel: false });
    if (!msg.idempotencyKey || msg.idempotencyKey.length > 256) {
      throw new ErroEnvio("O envio pelo Resend exige uma chave de idempotência estável de até 256 caracteres.", {
        codigo: "invalid_idempotency_key", repetivel: false,
      });
    }
    const corpo = await requisitarResend("/emails", {
      method: "POST",
      headers: { "Idempotency-Key": msg.idempotencyKey },
      body: JSON.stringify({
        from: msg.from, to: comoLista(msg.to), subject: msg.subject, html: msg.html,
        ...(msg.text != null ? { text: msg.text } : {}),
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
        ...(comoLista(msg.bcc).length ? { bcc: comoLista(msg.bcc) } : {}),
        ...(msg.headers ? { headers: msg.headers } : {}),
        ...(msg.tags?.length ? { tags: msg.tags } : {}),
        ...(msg.attachments?.length ? { attachments: msg.attachments.map((a) => ({
          filename: a.filename, content: a.content,
          ...(a.contentType ? { content_type: a.contentType } : {}),
        })) } : {}),
      }),
    }, this.opcoes);
    const id = corpo && typeof corpo === "object" && "id" in corpo ? corpo.id : undefined;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(id)) {
      throw new ErroEnvio("O Resend respondeu sem identificar o envio. Confira o resultado antes de reenviar.", {
        codigo: "resend_resposta_invalida", repetivel: false,
      });
    }
    return { providerMessageId: id };
  }
}

export interface DominioResend {
  id: string;
  name: string;
  status: string;
  capabilities?: { sending?: string };
}

/** Consulta todas as páginas: o domínio usado pode não estar nos primeiros 20. */
export async function listarDominiosResend(opcoes: OpcoesResend = {}): Promise<DominioResend[]> {
  const dominios: DominioResend[] = [];
  const cursores = new Set<string>();
  let depois = "";
  for (let pagina = 0; pagina < 100; pagina++) {
    const query = new URLSearchParams({ limit: "100", ...(depois ? { after: depois } : {}) });
    const corpo = await requisitarResend(`/domains?${query}`, { method: "GET" }, opcoes);
    if (!corpo || typeof corpo !== "object" || !("data" in corpo) || !Array.isArray(corpo.data)) {
      throw new ErroEnvio("O Resend devolveu uma lista de domínios inválida.", { codigo: "resend_resposta_invalida", repetivel: false });
    }
    const lista: DominioResend[] = corpo.data.filter((d): d is DominioResend =>
      !!d && typeof d === "object" && typeof d.id === "string" && typeof d.name === "string" && typeof d.status === "string");
    if (lista.length !== corpo.data.length) {
      throw new ErroEnvio("O Resend devolveu dados de domínio incompletos.", { codigo: "resend_resposta_invalida", repetivel: false });
    }
    dominios.push(...lista);
    if (!("has_more" in corpo) || corpo.has_more === false) return dominios;
    depois = lista.at(-1)?.id ?? "";
    if (!depois || cursores.has(depois)) break;
    cursores.add(depois);
  }
  throw new ErroEnvio("Não foi possível conferir todas as páginas de domínios do Resend.", {
    codigo: "resend_paginacao_incompleta", repetivel: false,
  });
}
