// 24/09/2026 — aviso uma vez POR TROCA, não uma vez por lead ou por conta.
// A→B→A cria duas ocorrências. Retentativa da mesma ocorrência mantém a frase.
// Os chamadores já seguram o lock por lead usado pelo inbound e pelo follow-up.
import { registrarNaJornada, type Jornada } from './fichaAtendimento.ts';
import type { SinalTrocaDeNumero } from './trocaDeNumero.ts';
import type { ResultadoEnvioResposta } from './saida.ts';

export const ABERTURAS_TROCA_NUMERO = [
  'vi que você já estava conversando com a equipe da PPG por outro número, vou continuar seu atendimento por aqui',
  'você já tinha falado com a equipe da PPG por outro número, vamos seguir a conversa por aqui',
  'vou continuar por aqui o atendimento que você estava tendo em outro número da PPG',
] as const;

export const NOTA_ABERTURA_CONTROLADA = 'O aviso de troca de número é acrescentado pelo sistema, uma única vez por abertura. Não escreva nem repita esse aviso no corpo da resposta; responda normalmente ao assunto do lead. Se ele perguntar sobre os números, explique normalmente.';

type RegistroAbertura = {
  chave: string;
  variacao: number;
  estado: 'pendente' | 'reservada' | 'enviada' | 'incerta';
  interacao_id: string;
  origem_em: string;
  atualizado_em: string;
};
export type MemoriaAberturasNumero = { sequencia: number; eventos: RegistroAbertura[] };

export function chaveDaAbertura(sinal: SinalTrocaDeNumero): string | null {
  if (!sinal.trocou || !sinal.contaAnterior || !sinal.contaAtual || !sinal.ultimaFalaAnteriorEm) return null;
  return JSON.stringify([sinal.contaAnterior, sinal.contaAtual, sinal.ultimaFalaAnteriorId ?? sinal.ultimaFalaAnteriorEm]);
}

/** Reserva antes do transporte. Se o processo cair durante o envio, não repete
 * automaticamente um aviso que pode ter chegado. Falha comprovada libera retry. */
export function reservarAbertura(jornada: Jornada, sinal: SinalTrocaDeNumero, interacaoId: string, agora: string): {
  jornada: Jornada; registro: RegistroAbertura | null;
} {
  const chave = chaveDaAbertura(sinal);
  if (!chave) return { jornada, registro: null };
  const memoria = jornada.aberturas_numero ?? { sequencia: 0, eventos: [] };
  const anterior = memoria.eventos.find(e => e.chave === chave);
  if (anterior && anterior.estado !== 'pendente') return { jornada, registro: null };
  // A memória retém as últimas 50 trocas. Um worker com sinal antigo não pode
  // reabrir ocorrência já descartada dessa janela depois de uma troca mais nova.
  if (!anterior && memoria.eventos.some(e => Date.parse(e.origem_em) > Date.parse(sinal.ultimaFalaAnteriorEm!))) {
    return { jornada, registro: null };
  }
  const registro: RegistroAbertura = {
    chave, variacao: anterior?.variacao ?? memoria.sequencia % ABERTURAS_TROCA_NUMERO.length,
    estado: 'reservada', interacao_id: interacaoId, origem_em: sinal.ultimaFalaAnteriorEm!, atualizado_em: agora,
  };
  return { registro, jornada: { ...jornada, aberturas_numero: {
    sequencia: memoria.sequencia + (anterior ? 0 : 1),
    eventos: [...memoria.eventos.filter(e => e.chave !== chave), registro].slice(-50),
  } } };
}

export function concluirAbertura(jornada: Jornada, registro: RegistroAbertura, estado: RegistroAbertura['estado'], agora: string): Jornada {
  const memoria = jornada.aberturas_numero;
  if (!memoria) return jornada;
  return { ...jornada, aberturas_numero: { ...memoria, eventos: memoria.eventos.map(e =>
    e.chave === registro.chave && e.interacao_id === registro.interacao_id && e.estado !== 'enviada'
      ? { ...e, estado, atualizado_em: agora } : e,
  ) } };
}

export type ControleAceiteAbertura = { primeiroAceite: () => Promise<void> };

export const comAberturaNumero = (texto: string, variacao: number): string =>
  texto.trim() ? `${ABERTURAS_TROCA_NUMERO[variacao]}\n\n${texto}` : texto;

export async function enviarComAberturaNumero(args: {
  banco: Parameters<typeof registrarNaJornada>[0]; telefone: string; interacaoId: string;
  sinal: SinalTrocaDeNumero | null; texto: string;
  enviar: (texto: string, controle?: ControleAceiteAbertura) => Promise<ResultadoEnvioResposta>;
  registrar: (tipo: string, dados?: Record<string, unknown>) => void;
}): Promise<{ texto: string; envio: ResultadoEnvioResposta }> {
  if (!args.sinal?.trocou || !args.texto.trim()) return { texto: args.texto, envio: await args.enviar(args.texto) };
  let reserva: ReturnType<typeof reservarAbertura> | null = null;
  try {
    const gravada = await registrarNaJornada(args.banco, args.telefone, j => {
      reserva = reservarAbertura(j, args.sinal!, args.interacaoId, new Date().toISOString());
      return reserva.jornada;
    });
    if (!gravada) throw new Error('jornada_ausente');
  } catch {
    // Sem memória confiável, responde à dúvida sem multiplicar apresentações.
    args.registrar('abertura_numero_memoria_falhou');
    return { texto: args.texto, envio: await args.enviar(args.texto) };
  }
  const registro = (reserva as ReturnType<typeof reservarAbertura> | null)?.registro;
  if (!registro) return { texto: args.texto, envio: await args.enviar(args.texto) };
  const texto = comAberturaNumero(args.texto, registro.variacao);
  let aceito = false;
  const marcar = async (estado: RegistroAbertura['estado']) => {
    try {
      if (!await registrarNaJornada(args.banco, args.telefone, j => concluirAbertura(j, registro, estado, new Date().toISOString()))) throw new Error('jornada_ausente');
      args.registrar('abertura_numero', { estado, variacao: registro.variacao + 1 });
    } catch { args.registrar('abertura_numero_memoria_falhou', { estado }); }
  };
  try {
    const envio = await args.enviar(texto, { primeiroAceite: async () => { aceito = true; await marcar('enviada'); } });
    if (!aceito) await marcar(envio.aceitos ? 'enviada' : envio.estado === 'desconhecido' ? 'incerta' : 'pendente');
    return { texto, envio };
  } catch (erro) {
    if (!aceito) await marcar('incerta');
    throw erro;
  }
}
