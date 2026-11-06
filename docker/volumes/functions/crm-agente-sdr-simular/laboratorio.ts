import {
  executarSimulacao,
  type EntradaSimulacao,
  type DependenciasSimulacao,
} from "./simulacao.ts";
import type { Msg } from "../crm-agente-sdr/historico.ts";
// Ensaio de um pedido editável. Não recebe banco nem transporte de WhatsApp.
// Os efeitos comerciais passam exclusivamente pelo mock/allowlist do simulador existente.
export type PedidoLaboratorio = {
  system: { type: "text"; text: string }[];
  messages: Msg[];
  tools: {
    name: string;
    description: string;
    input_schema: { type: string; [campo: string]: unknown };
  }[];
};

export function validarPedidoLaboratorio(valor: unknown): PedidoLaboratorio {
  if (!valor || typeof valor !== "object" || Array.isArray(valor))
    throw new Error("Pedido inválido.");
  const p = valor as PedidoLaboratorio;
  if (JSON.stringify(p).length > 200_000)
    throw new Error("Pedido excede 200.000 caracteres.");
  if (
    !Array.isArray(p.system) ||
    p.system.some((b) => b?.type !== "text" || typeof b.text !== "string")
  )
    throw new Error("As instruções devem conter blocos de texto.");
  if (
    !Array.isArray(p.messages) ||
    !p.messages.length ||
    p.messages.length > 200
  )
    throw new Error("Informe de 1 a 200 mensagens.");
  for (const m of p.messages) {
    if (
      !["user", "assistant"].includes(m?.role) ||
      !(typeof m.content === "string" || Array.isArray(m.content))
    )
      throw new Error("Histórico inválido.");
    if (
      Array.isArray(m.content) &&
      m.content.some(
        (b) => !b || !["text", "tool_use", "tool_result"].includes(b.type),
      )
    )
      throw new Error("O pedido aceita somente texto e blocos de ferramentas.");
  }
  if (p.messages.at(-1)?.role !== "user")
    throw new Error(
      "O pedido precisa terminar em mensagem do lead ou retorno de ferramenta.",
    );
  if (
    !Array.isArray(p.tools) ||
    p.tools.length > 40 ||
    p.tools.some(
      (t) =>
        !/^[a-zA-Z0-9_-]{1,64}$/.test(t?.name) ||
        typeof t.description !== "string" ||
        t.input_schema?.type !== "object",
    )
  )
    throw new Error("Ferramentas inválidas.");
  if (new Set(p.tools.map((t) => t.name)).size !== p.tools.length)
    throw new Error("Há ferramentas repetidas.");
  if (!p.tools.some((t) => t.name === "responder_ao_cliente"))
    throw new Error(
      "Mantenha a ferramenta responder_ao_cliente para a saída do João.",
    );
  // Parâmetros de rede, orçamento e modelo nunca vêm do JSON editável.
  return structuredClone({
    system: p.system,
    messages: p.messages,
    tools: p.tools,
  });
}

export async function executarEnsaio(
  pedido: PedidoLaboratorio,
  entrada: EntradaSimulacao,
  deps: DependenciasSimulacao,
  chamar: (
    p: PedidoLaboratorio,
  ) => ReturnType<DependenciasSimulacao["chamarPrincipal"]>,
) {
  // Compartilha as guardas, confirmação, deduplicação e saída do harness existente.
  // Instruções/contexto da cópia ficam congelados para isolar a edição do usuário.
  const ultima = pedido.messages.at(-1) as Msg;
  const entradaTexto =
    typeof ultima.content === "string"
      ? ultima.content
      : (ultima.content.find((b) => b.type === "text")?.text ??
        "[retorno de ferramenta]");
  const resultado = await executarSimulacao(
    { ...entrada, mensagens: [entradaTexto], usar_router: false },
    {
      ...deps,
      historicoLaboratorio: pedido.messages.slice(0, -1) as Msg[],
      entradaLaboratorio: pedido.messages.at(-1) as Msg,
      prepararRodada: async (m, t) => ({
        ...(await deps.prepararRodada(m, t)),
        tools: pedido.tools,
      }),
      chamarPrincipal: (opts) =>
        chamar({
          ...pedido,
          messages: opts.messages,
          tools: opts.tools.length
            ? pedido.tools
            : pedido.tools.filter((t) => t.name === "responder_ao_cliente"),
        }),
      mockTool: (nome, input) => {
        if (!pedido.tools.some((t) => t.name === nome))
          throw new Error("Ferramenta não oferecida neste pedido.");
        return deps.mockTool(nome, input);
      },
    },
  );
  return {
    ...resultado,
    limite_atingido: resultado.limites_atingidos.length > 0,
  };
}
