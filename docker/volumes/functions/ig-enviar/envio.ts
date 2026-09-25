// Régua PURA do envio do SAC para o direct do Instagram (ig-enviar). Banco e rede entram
// por `DepsEnvioIg`, então o teste exercita a regra inteira sem mandar DM.
//
// O que o atendente pode fazer pelo direct, e por quê:
//   · só TEXTO — o Instagram não tem template; mídia pelo SAC ainda não existe;
//   · só DENTRO da janela de 24h desde a última mensagem da pessoa. Fora dela a Meta
//     recusa (a exceção, a tag HUMAN_AGENT de 7 dias, exige App Review — ver
//     docs/Instagram (IA + Chat).md). Reação não abre janela aqui: conservador.
//   · texto longo vira vários balões (limite de 1000 BYTES por mensagem).
// Cada balão é gravado em ig_mensagens com origem 'humano' + autor ANTES do eco do
// webhook, o que faz duas coisas: o espelho do SAC mostra o nome do atendente, e o
// ig-agente, ao ver o eco, pausa a IA naquela conversa (humano assumiu).
import { dividirPorBytes, ehTokenInvalido, type ResultadoEnvioIg } from "../_shared/igMensageria.ts";

export const JANELA_IG_MS = 24 * 60 * 60 * 1000;
/** Nenhum atendente precisa de mais que isso num envio; acima, é colagem por engano. */
export const TEXTO_MAX_CARACTERES = 4000;

export type CodigoErroEnvioIg =
  | "janela_fechada"
  | "token_invalido"
  | "sem_conta"
  | "conversa_invalida"
  | "texto_vazio"
  | "falha_envio"
  | "nao_autorizado";

export type RespostaEnvioIg =
  | { ok: true; enviadas: number }
  | { ok: false; codigo: CodigoErroEnvioIg; erro: string; enviadas?: number };

export type DestinoIg = { contaId: string; igUserId: string | null; igsid: string };
export type AutorEnvio = { id: string; nome: string | null };

export type DepsEnvioIg = {
  /** Conversa do SAC → para quem vai (null = não é conversa do Instagram). */
  destino(conversaId: string): Promise<DestinoIg | null>;
  /** ISO da última DM DA PESSOA (sem reação), ou null. */
  ultimoInbound(d: DestinoIg): Promise<string | null>;
  token(contaId: string): Promise<string | null>;
  enviar(token: string, igsid: string, texto: string): Promise<ResultadoEnvioIg>;
  /** Grava o balão em ig_mensagens (upsert por mid quando enviou). */
  gravar(linha: Record<string, unknown>, enviou: boolean): Promise<void>;
  agora(): number;
};

export function janelaAberta(ultimoInbound: string | null, agora: number): boolean {
  if (!ultimoInbound) return false;
  const t = Date.parse(ultimoInbound);
  return Number.isFinite(t) && agora - t < JANELA_IG_MS;
}

export async function enviarDoSac(
  deps: DepsEnvioIg,
  entrada: { conversaId: string; texto: string; autor: AutorEnvio },
): Promise<RespostaEnvioIg> {
  const texto = String(entrada.texto ?? "").trim();
  if (!texto) return { ok: false, codigo: "texto_vazio", erro: "Mensagem vazia." };
  if (texto.length > TEXTO_MAX_CARACTERES) {
    return { ok: false, codigo: "texto_vazio", erro: `Mensagem longa demais (máx. ${TEXTO_MAX_CARACTERES} caracteres).` };
  }

  const destino = await deps.destino(entrada.conversaId);
  if (!destino) return { ok: false, codigo: "conversa_invalida", erro: "Esta conversa não é do direct do Instagram." };

  const token = await deps.token(destino.contaId);
  if (!token) return { ok: false, codigo: "sem_conta", erro: "A conta do Instagram desta conversa não está conectada." };

  if (!janelaAberta(await deps.ultimoInbound(destino), deps.agora())) {
    return {
      ok: false,
      codigo: "janela_fechada",
      erro: "A janela de 24h do Instagram fechou. Só dá para responder quando a pessoa mandar mensagem de novo.",
    };
  }

  const base = {
    conta_id: destino.contaId,
    ig_user_id: destino.igUserId,
    contato_igsid: destino.igsid,
    direcao: "outbound",
    tipo: "text",
  };
  const metadata = {
    is_echo: false,
    origem: "humano",
    via: "sac",
    enviado_por_id: entrada.autor.id,
    enviado_por_nome: entrada.autor.nome,
  };

  const partes = dividirPorBytes(texto);
  for (let i = 0; i < partes.length; i++) {
    const r = await deps.enviar(token, destino.igsid, partes[i]);
    if (r.ok) {
      await deps.gravar({ ...base, conteudo: partes[i], mid: r.mid, status_entrega: "sent", metadata }, true);
      continue;
    }
    await deps.gravar({ ...base, conteudo: partes[i], mid: null, status_entrega: "failed", erro: r.erro, metadata }, false);
    if (ehTokenInvalido(r.erro)) {
      return {
        ok: false,
        codigo: "token_invalido",
        erro: "A conexão desta conta do Instagram expirou — é preciso reconectar a conta.",
        enviadas: i,
      };
    }
    return { ok: false, codigo: "falha_envio", erro: `O Instagram recusou: ${r.erro.message}`, enviadas: i };
  }
  return { ok: true, enviadas: partes.length };
}
