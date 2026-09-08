import { gravarMensagem, type Msg } from './historico.ts';

export type EntradaBuffer = {
  msg_id?: string | null;
  mensagem?: string | null;
  arquivo?: string | null;
  [campo: string]: unknown;
};
type EstadoEntrada = 'pausa' | 'ativa' | 'legado' | 'sem_origem' | 'contato_invalido';
export type RegistroEntrada = {
  estado: EstadoEntrada;
  mensagem_id?: string | null;
  historico_id?: number | null;
  remotejid?: string | null;
  gravada: boolean;
};
type BancoEntrada = {
  rpc(nome: string, parametros: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};
const ESTADOS = new Set<EstadoEntrada>(['pausa', 'ativa', 'legado', 'sem_origem', 'contato_invalido']);

export function mensagemPreparada(item: EntradaBuffer): Msg | null {
  const partes = [item.arquivo, item.mensagem]
    .filter((texto): texto is string => typeof texto === 'string' && Boolean(texto.trim()));
  if (!partes.length) return null;
  return { role: 'user', content: partes.length === 1 ? partes[0] : partes.map((text) => ({ type: 'text', text })) };
}

// A origem é o wamid real, não o id de um clone SAC. A RPC reconhece uma fala
// recebida em pausa mesmo depois de despausar, impedindo o reconciliador de respondê-la.
export async function registrarEntrada(
  banco: BancoEntrada,
  remotejid: string,
  item: EntradaBuffer,
  opcoes: { preparada?: boolean; pausaObservada?: boolean } = {},
): Promise<RegistroEntrada> {
  if (!item.msg_id) return { estado: 'sem_origem', gravada: false };
  const { data, error } = await banco.rpc('crm_sdr_registrar_entrada', {
    p_wa_message_id: item.msg_id,
    p_remotejid: remotejid,
    p_mensagem: opcoes.preparada ? mensagemPreparada(item) : null,
    p_pausa_observada: opcoes.pausaObservada === true,
  });
  if (error || !data || typeof data !== 'object') throw new Error('histórico de entrada indisponível');
  const registro = data as RegistroEntrada;
  if (!ESTADOS.has(registro.estado) || typeof registro.gravada !== 'boolean') {
    throw new Error('resposta inválida do histórico de entrada');
  }
  return registro;
}

// Chamadas sequenciais preservam a ordem dos turnos. Entradas novas ficam
// idempotentes por origem; o caminho legado continua aceitando buffers sem wamid.
export async function persistirEntradasDoLote<T extends EntradaBuffer>(
  banco: BancoEntrada,
  remotejid: string,
  itens: T[],
  pausaObservada = false,
  salvarLegado: (mensagem: Msg) => Promise<void> = (mensagem) => gravarMensagem(banco, remotejid, mensagem),
): Promise<T[]> {
  const ativas: T[] = [];
  const legado: T[] = [];
  for (const item of itens) {
    if (!mensagemPreparada(item)) continue; // drenar_orfao não é uma fala do lead.
    const registro = await registrarEntrada(banco, remotejid, item, { preparada: true, pausaObservada });
    if (registro.estado === 'contato_invalido') continue;
    if (registro.estado === 'pausa') continue;
    if (registro.estado === 'legado' || registro.estado === 'sem_origem') legado.push(item);
    if (!pausaObservada) ativas.push(item);
  }
  // Sem identidade não há chave segura para deduplicar. Mantém o formato legado
  // (arquivos separados + texto agregado); nunca tenta casar apenas pelo texto.
  for (const item of legado) {
    if (item.arquivo?.trim()) await salvarLegado({ role: 'user', content: item.arquivo });
  }
  const texto = legado.map((item) => item.mensagem).filter(Boolean).join('\n');
  if (texto.trim()) await salvarLegado({ role: 'user', content: texto });
  return ativas;
}
