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
import {
  bytesUtf8, dividirPorBytes, ehTokenInvalido, IG_TEXTO_MAX_BYTES, type ResultadoEnvioIg,
} from "../_shared/igMensageria.ts";
import type { ResultadoEnvioDireto } from "../_shared/igManychat.ts";

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
  | "conversa_de_outro_app"
  | "comentario_ja_respondido"
  | "comentario_longo"
  | "comentario_recusado"
  | "nao_autorizado";

export type RespostaEnvioIg =
  | { ok: true; enviadas: number }
  | { ok: false; codigo: CodigoErroEnvioIg; erro: string; enviadas?: number };

export type DestinoIg = {
  contaId: string;
  igUserId: string | null;
  igsid: string;
  /** Para achar a pessoa no ManyChat quando a conversa é dele. */
  nome?: string | null;
  username?: string | null;
};
export type AutorEnvio = { id: string; nome: string | null };
/** Comentário de LIVE da pessoa: dá direito a UMA resposta privada, com a live no ar. */
export type ComentarioDeLive = { commentId: string; criadoEm: string };

export type DepsEnvioIg = {
  /** Conversa do SAC → para quem vai (null = não é conversa do Instagram). */
  destino(conversaId: string): Promise<DestinoIg | null>;
  /** ISO da última DM DA PESSOA (sem reação nem comentário de live), ou null. */
  ultimoInbound(d: DestinoIg): Promise<string | null>;
  /** O último comentário de live da pessoa, ou null. */
  comentarioDeLive(d: DestinoIg): Promise<ComentarioDeLive | null>;
  /** Já saiu mensagem nossa (que não falhou) depois deste instante? */
  saidaDepois(d: DestinoIg, iso: string): Promise<boolean>;
  /** Resposta privada ao comentário (`recipient.comment_id`). */
  responderComentario(destino: DestinoIg, token: string, commentId: string, texto: string): Promise<ResultadoEnvioIg>;
  token(contaId: string): Promise<string | null>;
  /** Instagram; se a conversa é do ManyChat, pelo ManyChat (`_shared/igManychat.ts`). */
  enviar(destino: DestinoIg, token: string, texto: string, autor: AutorEnvio): Promise<ResultadoEnvioDireto>;
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
    // Sem DM da pessoa nas últimas 24h, mas ela comentou numa LIVE: a única mensagem que a
    // Meta deixa mandar é a resposta privada àquele comentário (12/11/2026).
    const comentario = await deps.comentarioDeLive(destino);
    if (comentario && janelaAberta(comentario.criadoEm, deps.agora())) {
      return await responderComentarioDeLive(deps, destino, token, comentario, texto, entrada.autor);
    }
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
    const r = await deps.enviar(destino, token, partes[i], entrada.autor);
    if (r.ok) {
      // Pelo ManyChat não há mid: a linha nasce do eco, com o autor (ig_envios_manychat).
      if (r.via !== "manychat") {
        await deps.gravar({ ...base, conteudo: partes[i], mid: r.mid, status_entrega: "sent", metadata }, true);
      }
      continue;
    }
    await deps.gravar({ ...base, conteudo: partes[i], mid: null, status_entrega: "failed", erro: r.erro, metadata }, false);
    // 26/09/2026: (#100) subcode 2534037 = "não é o dono da conversa". Outro app (o
    // ManyChat, que manda o "Oii, tudo bem?") está com o controle da conversa pelo
    // roteamento de conversas da Meta. Desde 28/09 o envio vai pelo ManyChat quando a
    // conta tem a chave dele; este erro só volta se não tem (ou o ManyChat também falhou,
    // e aí a mensagem dele vem em `falha_envio`).
    if (r.via === "instagram" && r.erro.subcode === 2534037) {
      return {
        ok: false,
        codigo: "conversa_de_outro_app",
        erro: "Esta conversa está sob controle do ManyChat no Instagram — por enquanto, responda pelo app do Instagram.",
        enviadas: i,
      };
    }
    if (ehTokenInvalido(r.erro)) {
      return {
        ok: false,
        codigo: "token_invalido",
        erro: "A conexão desta conta do Instagram expirou — é preciso reconectar a conta.",
        enviadas: i,
      };
    }
    return {
      ok: false,
      codigo: "falha_envio",
      erro: r.via === "manychat" ? `Não saiu pelo ManyChat: ${r.erro.message}` : `O Instagram recusou: ${r.erro.message}`,
      enviadas: i,
    };
  }
  return { ok: true, enviadas: partes.length };
}

/**
 * A pessoa só COMENTOU numa live (não mandou DM). Regras da Meta (Private Replies):
 *   · UMA mensagem por comentário — por isso não quebra em vários balões;
 *   · só com a live NO AR — depois que a transmissão acaba a Meta recusa;
 *   · não abre a janela de 24h: a conversa continua quando a pessoa responder no direct.
 * O balão gravado como humano + autor é o que faz o `ig-agente` deixar a conversa com o
 * time quando a pessoa responder (conversa começada pelo time).
 */
async function responderComentarioDeLive(
  deps: DepsEnvioIg,
  destino: DestinoIg,
  token: string,
  comentario: ComentarioDeLive,
  texto: string,
  autor: AutorEnvio,
): Promise<RespostaEnvioIg> {
  if (await deps.saidaDepois(destino, comentario.criadoEm)) {
    return {
      ok: false,
      codigo: "comentario_ja_respondido",
      erro: "O Instagram só deixa mandar UMA mensagem em resposta a um comentário de live, e ela já foi enviada. Dá para continuar quando a pessoa responder no direct.",
    };
  }
  if (bytesUtf8(texto) > IG_TEXTO_MAX_BYTES) {
    return {
      ok: false,
      codigo: "comentario_longo",
      erro: "A resposta a um comentário de live é uma mensagem só e curta (até cerca de 900 caracteres). Encurte o texto.",
    };
  }

  const linha = {
    conta_id: destino.contaId,
    ig_user_id: destino.igUserId,
    contato_igsid: destino.igsid,
    direcao: "outbound",
    tipo: "text",
    conteudo: texto,
    metadata: {
      is_echo: false,
      origem: "humano",
      via: "sac",
      enviado_por_id: autor.id,
      enviado_por_nome: autor.nome,
      resposta_privada: true,
      comment_id: comentario.commentId,
    },
  };
  const r = await deps.responderComentario(destino, token, comentario.commentId, texto);
  if (r.ok) {
    await deps.gravar({ ...linha, mid: r.mid, status_entrega: "sent" }, true);
    return { ok: true, enviadas: 1 };
  }
  await deps.gravar({ ...linha, mid: null, status_entrega: "failed", erro: r.erro }, false);
  if (ehTokenInvalido(r.erro)) {
    return {
      ok: false,
      codigo: "token_invalido",
      erro: "A conexão desta conta do Instagram expirou — é preciso reconectar a conta.",
      enviadas: 0,
    };
  }
  return {
    ok: false,
    codigo: "comentario_recusado",
    erro: `O Instagram recusou a resposta a este comentário: ${r.erro.message} — comentário de live só pode ser respondido enquanto a live está no ar.`,
    enviadas: 0,
  };
}
