import { ErroEnvio } from "../_shared/emailProviders/types.ts";
import { listarDominiosResend, type OpcoesResend } from "../_shared/emailProviders/resend.ts";

export interface StatusDisparo {
  /** Configuração verificada; aceitação/entrega real depende do envio e dos eventos. */
  ok: boolean;
  provider: string | null;
  credencialConfigurada: boolean;
  apiRespondeu: boolean;
  dominiosVerificados: number;
  dominiosPendentes: number;
  modoSeco: boolean;
  webhookConfigurado?: boolean;
  mensagem: string;
  detalhe?: string;
  comoResolver?: string;
}

export interface RemetenteDisparo {
  provider: string;
  ativo: boolean;
  email_completo: string;
}

export function baseStatusDisparo(provider: string | null): StatusDisparo {
  return { ok: false, provider, credencialConfigurada: false, apiRespondeu: false,
    dominiosVerificados: 0, dominiosPendentes: 0, modoSeco: false, mensagem: "" };
}

export async function verificarStatusResend(opcoes: OpcoesResend & {
  remetentes: RemetenteDisparo[];
  webhookSecret?: string;
  modoSeco?: boolean;
}): Promise<StatusDisparo> {
  const base = { ...baseStatusDisparo("resend"),
    credencialConfigurada: !!opcoes.apiKey?.trim(),
    webhookConfigurado: !!opcoes.webhookSecret?.trim(), modoSeco: !!opcoes.modoSeco };
  if (!base.credencialConfigurada) return {
    ...base, mensagem: "A chave de API do Resend ainda não está configurada.",
    comoResolver: "Configure a chave do Resend no servidor e valide o domínio do remetente no painel do Resend.",
  };

  let dominios;
  try {
    dominios = await listarDominiosResend(opcoes);
  } catch (erro) {
    const seguro = erro instanceof ErroEnvio ? erro : null;
    return { ...base,
      mensagem: "Não foi possível validar os domínios da conta Resend.",
      detalhe: seguro?.message ?? "Falha ao consultar o Resend.",
      comoResolver: seguro?.codigo === "restricted_api_key" || seguro?.codigo === "invalid_permission"
        ? "Confira se a chave está ativa e possui Full access: uma chave restrita a envio não permite consultar domínios."
        : "Confira a chave e a disponibilidade do Resend; depois teste a conexão novamente.",
    };
  }
  base.apiRespondeu = true;

  const cadastrados = opcoes.remetentes.filter((r) => r.provider === "resend");
  const ativos = cadastrados.filter((r) => r.ativo);
  // Um remetente desativado pode ajudar a configurar o domínio, porém nunca torna
  // o disparo pronto. Também não deve bloquear outro remetente ativo e válido.
  const considerados = ativos.length ? ativos : cadastrados;
  const enderecos = considerados.map((r) => r.email_completo?.trim().toLowerCase() ?? "");
  const invalidos = enderecos.some((email) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email));
  const esperados = [...new Set(enderecos.map((email) => email.split("@")[1]).filter(Boolean))];
  const verificados = esperados.filter((nome) => dominios.some((d) =>
    d.name.toLowerCase() === nome && d.status === "verified" && d.capabilities?.sending === "enabled"));
  const pendentes = esperados.filter((nome) => !verificados.includes(nome));
  base.dominiosVerificados = verificados.length;
  base.dominiosPendentes = pendentes.length;

  const pendencias: string[] = [];
  if (!cadastrados.length) pendencias.push("Cadastre um remetente Resend para conferir o domínio que será usado nos envios.");
  else if (!ativos.length) pendencias.push("Ative um remetente Resend para habilitar os disparos.");
  if (invalidos) pendencias.push("Corrija o endereço de e-mail do remetente.");
  if (pendentes.length) pendencias.push(`Verifique no Resend os domínios usados pelos remetentes e habilite o envio: ${pendentes.join(", ")}.`);
  if (!base.webhookConfigurado) pendencias.push("Configure o webhook de eventos e seu segredo de assinatura no servidor para registrar entregas, falhas e denúncias de spam.");
  if (base.modoSeco) pendencias.push("Desative o modo de simulação no servidor para enviar e-mails reais.");

  const ok = pendencias.length === 0 && verificados.length > 0;
  return { ...base, ok,
    mensagem: ok
      ? `Resend configurado para os remetentes ativos. Domínios verificados: ${verificados.join(", ")}.`
      : "A API do Resend respondeu, mas ainda há configurações pendentes para os disparos.",
    detalhe: ok
      ? "A assinatura do webhook está configurada. Confirme o circuito completo com um envio de teste e seus eventos."
      : pendencias.join(" "),
    comoResolver: ok ? undefined : "Conclua as pendências e clique em Testar conexão novamente.",
  };
}
