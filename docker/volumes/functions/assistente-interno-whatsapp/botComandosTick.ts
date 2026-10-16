// Fila do bot de comandos (`?cron=bot_comandos`). Chamado na hora pelo gatilho da fila
// (wa_bot_comandos_cutucar) e a cada 2 min pelo cron `assistente-bot-comandos-tick`. A régua e os
// textos moram em botComandos.ts.
//
// Quem grava na fila é o wa-uazapi-webhook, e só grava mensagem PRIVADA, de quem está no grupo
// autorizado da linha (wa_bot_comandos.grupo_autorizado_jid). Aqui não se confere permissão de
// novo: o que está na fila já passou pela porta.
//
// Trava: cada mensagem é reivindicada antes de responder (UPDATE condicional em tentativas +
// reivindicado_em), então a cutucada e o cron juntos não respondem duas vezes. Só mensagens da
// última hora: resposta muito atrasada a um comando confunde mais do que ajuda.
import { carregarLinhaWeb, enviarTexto } from "./wa.ts";
import { hojeSP } from "./datas.ts";
import { blocoComercial } from "./relatoriosGrupoTick.ts";
import {
  encontrarPessoa, interpretarComando, linhaDasFontes, textoComercialPeriodo, textoMenu, textoNaoAchei,
  textoPendentes, textoResumoPessoa, textoVarias, TEXTO_PERIODO_INVALIDO, TEXTO_RESUMO_SEM_NOME, TEXTO_SO_TEXTO,
  type PessoaComercial,
} from "./botComandos.ts";

const MAX_TENTATIVAS = 3;
const POR_RODADA = 10;
const JANELA_MS = 60 * 60 * 1000;
const REIVINDICACAO_VENCE_MS = 3 * 60 * 1000; // as fontes da planilha levam alguns segundos

/** Os cargos do comercial que a planilha de desempenho conhece (vendedores e SDRs). */
const TIPOS_COMERCIAL = ["vendedor", "vendedor_vendas_ativas", "coordenador", "sdr", "sdr_coordenador", "sdr_vendas_diretas"];

interface ItemFila {
  id: number;
  wa_conexao_id: string;
  de_telefone: string;
  texto: string | null;
  tipo: string | null;
  tentativas: number;
}
interface ConfigBot { wa_conexao_id: string; como_usuario_id: string; ativo: boolean }

async function reivindicar(admin: any, item: ItemFila): Promise<boolean> {
  const vence = new Date(Date.now() - REIVINDICACAO_VENCE_MS).toISOString();
  const { data, error } = await admin.from("wa_bot_comandos_fila")
    .update({ reivindicado_em: new Date().toISOString(), tentativas: item.tentativas + 1 })
    .eq("id", item.id)
    .eq("tentativas", item.tentativas)
    .is("respondido_em", null)
    .or(`reivindicado_em.is.null,reivindicado_em.lt.${vence}`)
    .select("id");
  if (error) throw new Error(`wa_bot_comandos_fila: ${error.message}`);
  return (data ?? []).length > 0;
}

async function pessoasComerciais(admin: any): Promise<PessoaComercial[]> {
  const { data, error } = await admin.from("profiles")
    .select("id, name, user_type, ativo")
    .in("user_type", TIPOS_COMERCIAL);
  if (error) throw new Error(`profiles: ${error.message}`);
  return ((data ?? []) as any[])
    .filter((p) => p.ativo !== false && p.name)
    .map((p) => ({ id: p.id, nome: p.name, user_type: p.user_type }));
}

/** O texto da resposta e o nome do comando (gravado na fila, para auditoria). */
async function responder(admin: any, cfg: ConfigBot, item: ItemFila): Promise<{ texto: string; comando: string }> {
  if (item.tipo && item.tipo !== "text") return { texto: TEXTO_SO_TEXTO, comando: "nao_texto" };
  const hoje = hojeSP();
  const cmd = interpretarComando(item.texto ?? "", hoje);
  switch (cmd.tipo) {
    case "menu":
      return { texto: textoMenu(), comando: "menu" };
    case "desconhecido":
      return { texto: `Não entendi. 🙂\n\n${textoMenu()}`, comando: "desconhecido" };
    case "resumo_sem_nome":
      return { texto: TEXTO_RESUMO_SEM_NOME, comando: "resumo" };
    case "periodo_invalido":
      return { texto: TEXTO_PERIODO_INVALIDO, comando: "periodo_invalido" };
    case "pendentes": {
      const { data, error } = await admin.rpc("assist_vendas_pendentes", { p_de: "2000-01-01", p_ate: hoje });
      if (error) throw new Error(`assist_vendas_pendentes: ${error.message}`);
      return { texto: textoPendentes(data), comando: "pendentes" };
    }
    case "comercial": {
      const bloco = await blocoComercial(admin, cmd.periodo.de, cmd.periodo.ate);
      return { texto: textoComercialPeriodo(cmd.periodo, bloco), comando: `comercial ${cmd.periodo.de}..${cmd.periodo.ate}` };
    }
    case "resumo": {
      const busca = encontrarPessoa(await pessoasComerciais(admin), cmd.nome);
      if (busca.tipo === "nenhuma") return { texto: textoNaoAchei(cmd.nome), comando: "resumo" };
      if (busca.tipo === "varias") return { texto: textoVarias(busca.opcoes), comando: "resumo" };
      const { data: fontes, error } = await admin.rpc("bot_comercial_fontes_pessoa", {
        p_como: cfg.como_usuario_id, p_pessoa: busca.pessoa.id, p_de: cmd.periodo.de, p_ate: cmd.periodo.ate,
      });
      if (error) throw new Error(`bot_comercial_fontes_pessoa: ${error.message}`);
      if (fontes?.erro) return { texto: `Não consegui montar o resumo de ${busca.pessoa.nome}: ${fontes.erro}.`, comando: "resumo" };
      return {
        texto: textoResumoPessoa(linhaDasFontes(fontes, busca.pessoa.id), cmd.periodo),
        comando: `resumo ${busca.pessoa.nome} ${cmd.periodo.de}..${cmd.periodo.ate}`,
      };
    }
  }
}

export async function processarBotComandos(admin: any): Promise<Record<string, unknown>> {
  const { data, error } = await admin.from("wa_bot_comandos_fila")
    .select("id, wa_conexao_id, de_telefone, texto, tipo, tentativas")
    .is("respondido_em", null)
    .lt("tentativas", MAX_TENTATIVAS)
    .gte("criado_em", new Date(Date.now() - JANELA_MS).toISOString())
    .order("id")
    .limit(POR_RODADA);
  if (error) throw new Error(`wa_bot_comandos_fila: ${error.message}`);

  let respondidos = 0;
  const erros: string[] = [];
  for (const item of (data ?? []) as ItemFila[]) {
    if (!(await reivindicar(admin, item))) continue; // outro edge pegou
    try {
      const { data: cfg } = await admin.from("wa_bot_comandos")
        .select("wa_conexao_id, como_usuario_id, ativo").eq("wa_conexao_id", item.wa_conexao_id).maybeSingle();
      if (!cfg?.ativo) throw new Error("bot desligado");
      const linha = await carregarLinhaWeb(admin, item.wa_conexao_id);
      if (!linha) throw new Error("linha inativa ou sem token");

      let resposta: { texto: string; comando: string };
      try {
        resposta = await responder(admin, cfg as ConfigBot, item);
      } catch (e) {
        // Falha ao montar a resposta: a pessoa recebe um aviso em vez de silêncio, e o erro fica na fila.
        console.error("[bot-comandos] resposta falhou:", e);
        resposta = { texto: "Deu erro ao buscar esses números. Tente de novo em instantes. 🙏", comando: `erro: ${(e as Error).message}`.slice(0, 300) };
      }
      const r = await enviarTexto(linha, item.de_telefone, resposta.texto);
      // A Uazapi devolve { ok:false } SEM lançar em não-2xx.
      if (r && (r as any).ok === false) throw new Error("envio recusado pelo provider (ok:false)");
      await admin.from("wa_bot_comandos_fila")
        .update({ respondido_em: new Date().toISOString(), comando: resposta.comando, erro: null })
        .eq("id", item.id);
      respondidos++;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      const definitivo = msg === "bot desligado";
      await admin.from("wa_bot_comandos_fila")
        .update({ erro: msg, reivindicado_em: null, ...(definitivo ? { tentativas: MAX_TENTATIVAS } : {}) })
        .eq("id", item.id);
      erros.push(`${item.id}: ${msg}`);
    }
  }
  return { respondidos, ...(erros.length ? { erros } : {}) };
}
