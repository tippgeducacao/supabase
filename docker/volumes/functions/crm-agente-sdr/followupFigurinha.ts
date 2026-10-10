// Toque da FIGURINHA no follow-up de janela aberta (pedido do Gustavo, 10/10/2026).
//
// 37 min depois da última mensagem do lead sai UMA figurinha, sozinha, sem texto e sem
// chamada de modelo. É um toque à parte: não entra em CADENCIA_MIN, não muda a coluna
// follow_up e não grava marcador no histórico, então os 7 toques de texto e a contagem
// de tentativas seguem exatamente como eram.
//
// Só vai para quem RECEBEU o toque de 15 min: se o modelo ficou em silêncio lá (recusa,
// despedida, retenção pendente), a figurinha também não sai. Mandar um cachorrinho
// dançando para quem acabou de dizer que não quer é pior que não mandar nada.

// deno-lint-ignore-file no-explicit-any

// Favorita da conta do Gustavo Sutil (wa_figurinhas), animada, 158 KB. Se o arquivo sair
// do Storage o envio falha e fica registrado em `followup_figurinha_falhou`.
export const FIGURINHA_FOLLOWUP_URL = 'https://api.ppgeducacao.site/storage/v1/object/public/whatsapp-anexos/stickers/fe26d250-9481-4e7b-9036-ca429e0e9ac9/836bf8358c73151ffc67b3eedc289ed907c5c68bc88023caf47519895de4e8b4.webp';

export const FIGURINHA_APOS_MIN = 37;
// Daqui em diante é o toque de texto de 1h. Figurinha atrasada não é recuperada.
export const FIGURINHA_ATE_MIN = 60;
// A mesma figurinha toda vez que o lead some vira piada repetida.
export const FIGURINHA_REPETIR_APOS_DIAS = 7;

/** Filtro do produtor: dentro da janela e com o toque de 15 min já consumido (follow_01). */
export function figurinhaNaJanela(elapsedMin: number, toquesFeitos: number): boolean {
  return elapsedMin >= FIGURINHA_APOS_MIN && elapsedMin < FIGURINHA_ATE_MIN && toquesFeitos === 1;
}

/** Decisão do consumidor, com o lead relido sob lock. `null` = pode enviar. */
export function motivoSemFigurinha(e: {
  lead: any;
  elapsedMin: number;
  toquesFeitos: number;
  /** Follow-ups realmente ENVIADOS depois da última fala do lead (marcadores no histórico). */
  enviadosNoCiclo: number;
  agora?: number;
}): string | null {
  const { lead } = e;
  if (lead.followup_ativado !== true || lead.iniciar_atendimento !== true || lead.modo_recontato === true
    || lead.pausa_ia === true || lead.atendimento_finalizado === true || lead.agendado === true) return 'lead_fora_da_esteira';
  if (!figurinhaNaJanela(e.elapsedMin, e.toquesFeitos)) return 'fora_da_janela';
  // Persona aula segue só com texto (decisão de 30/09/2026, a mesma que tirou a voz).
  if (lead.contexto_campanha?.persona === 'aula') return 'persona_aula';
  if (e.enviadosNoCiclo < 1) return 'toque_de_15min_sem_envio';
  const ultima = Date.parse(lead.jornada?.figurinha_followup?.enviado_em ?? '');
  if (Number.isFinite(ultima) && (e.agora ?? Date.now()) - ultima < FIGURINHA_REPETIR_APOS_DIAS * 86_400_000) return 'ja_recebeu_recentemente';
  return null;
}
