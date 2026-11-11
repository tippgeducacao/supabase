import { semDadosPrivados } from '../crm-agente-sdr/capturaModelo.ts';
import type { PedidoLaboratorio } from './laboratorio.ts';

// A dependência só chama o modelo. Não recebe banco, mock de ferramenta ou WhatsApp.
export async function avaliarChamadaCongelada(
  pedido: PedidoLaboratorio,
  chamar: (pedido: PedidoLaboratorio) => Promise<Record<string, unknown>>,
) {
  const inicio = Date.now();
  const resposta = await chamar(structuredClone(pedido));
  return {
    ok: true, modo: 'chamada_congelada', ferramentas_executadas: false,
    duracao_ms: Date.now() - inicio, resposta: semDadosPrivados(resposta),
  };
}
