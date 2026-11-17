import { beforeEach, describe, expect, it } from "vitest";
import {
  comBotaoDaAgenda,
  esquecerModelosDaAgenda,
  linkDaAgendaNoEnvio,
  linkDeAgendamentoComNumero,
  modeloLevaLinkDaAgenda,
  modelosComLinkDaAgenda,
} from "./agendaLeadLink";

/**
 * O LINK DA AGENDA NASCE NO ENVIO (16/11/2026). Pedido do Gustavo: "criar um token com o link no
 * momento do envio para add no template, assim vamos poder criar um por lead ... já fica setado
 * pelo número que será feito o envio".
 *
 * Isto roda dentro da `crm-whatsapp-send`, por onde passa TODO envio de WhatsApp. O que está
 * aqui é o que não pode acontecer: modelo comum pagar pedágio ou parar de sair, e modelo da
 * agenda sair sem o link.
 */

type Chamada = { fn: string; args?: Record<string, unknown> };

function banco(respostas: Record<string, { data?: unknown; error?: { message: string } | null }>) {
  const chamadas: Chamada[] = [];
  return {
    chamadas,
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      chamadas.push({ fn, args });
      const r = respostas[fn] ?? { data: null, error: { message: "sem resposta" } };
      return { data: r.data ?? null, error: r.error ?? null };
    },
  };
}

const LEAD = "6798afcf-da25-4f07-8bdf-0460b7b8d1a2";
const CONTA = "4968e8d3-effc-42d0-a5b8-64e248cc3735";
const TOKEN = "a".repeat(88);

beforeEach(() => esquecerModelosDaAgenda());

describe("quais modelos levam o link da agenda", () => {
  it("acha o botão de URL dinâmico que aponta para /agendar-reuniao/ e guarda a posição dele", () => {
    const lista = [
      {
        name: "convite_agenda",
        status: "APPROVED",
        components: [
          { type: "BODY", text: "Olá, {{1}}!" },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Agora não" },
              { type: "URL", text: "Agendar", url: "https://sistema.invalid/agendar-reuniao/{{1}}" },
            ],
          },
        ],
      },
      // link fixo (sem variável): não há o que preencher
      { name: "fixo", status: "APPROVED", components: [{ type: "BUTTONS", buttons: [{ type: "URL", url: "https://sistema.invalid/agendar-reuniao/abc" }] }] },
      // botão dinâmico de OUTRA agenda (a do RH)
      { name: "rh", status: "APPROVED", components: [{ type: "BUTTONS", buttons: [{ type: "URL", url: "https://sistema.invalid/processo-seletivo/agendar/{{1}}" }] }] },
      { name: "sem_botao", status: "APPROVED", components: [{ type: "BODY", text: "oi" }] },
    ];
    expect(modelosComLinkDaAgenda(lista)).toEqual([{ nome: "convite_agenda", indice: 1, status: "APPROVED" }]);
    expect(modelosComLinkDaAgenda([])).toEqual([]);
  });
});

describe("modelo comum não paga nada", () => {
  it("lê a lista uma vez e responde os envios seguintes de memória", async () => {
    const b = banco({ agenda_lead_modelos_chaves: { data: ["waba1|convite_agenda"] } });
    expect(await modeloLevaLinkDaAgenda(b, "waba1", "oi_tudo_bem")).toBe(false);
    expect(await modeloLevaLinkDaAgenda(b, "waba1", "prova_01")).toBe(false);
    expect(await modeloLevaLinkDaAgenda(b, "waba1", "convite_agenda")).toBe(true);
    // o mesmo nome em OUTRA conta da Meta não é o modelo da agenda
    expect(await modeloLevaLinkDaAgenda(b, "waba2", "convite_agenda")).toBe(false);
    expect(b.chamadas.length).toBe(1);
  });

  it("não consulta o lead nem mexe nos componentes de um modelo comum", async () => {
    const b = banco({ agenda_lead_modelos_chaves: { data: ["waba1|convite_agenda"] } });
    const comps = [{ type: "body", parameters: [{ type: "text", text: "Ana" }] }];
    const r = await linkDaAgendaNoEnvio(b, { wabaId: "waba1", template: "oi_tudo_bem", contaId: CONTA, leadId: LEAD, comps });
    expect(r).toEqual({ aplica: false });
    expect(b.chamadas.map((c) => c.fn)).toEqual(["agenda_lead_modelos_chaves"]);
  });

  it("lista fora do ar = nenhum modelo: o envio segue como sempre foi", async () => {
    const b = banco({ agenda_lead_modelos_chaves: { error: { message: "banco fora" } } });
    const r = await linkDaAgendaNoEnvio(b, { wabaId: "waba1", template: "convite_agenda", contaId: CONTA, leadId: LEAD, comps: [] });
    expect(r).toEqual({ aplica: false });
  });
});

describe("modelo da agenda sai com o link do lead", () => {
  const lista = { agenda_lead_modelos_chaves: { data: ["waba1|convite_agenda"] } };

  it("põe o link no botão certo, com o lead e o número do envio", async () => {
    const b = banco({
      ...lista,
      agenda_lead_link_para_envio: { data: { aplica: true, ok: true, indice: 1, valor: TOKEN, tipo: "pessoal" } },
    });
    const comps = [{ type: "body", parameters: [{ type: "text", text: "Ana" }] }];
    const r = await linkDaAgendaNoEnvio(b, { wabaId: "waba1", template: "convite_agenda", contaId: CONTA, leadId: LEAD, comps });
    expect(r).toEqual({
      aplica: true,
      ok: true,
      tipo: "pessoal",
      comps: [
        { type: "body", parameters: [{ type: "text", text: "Ana" }] },
        { type: "button", sub_type: "url", index: 1, parameters: [{ type: "text", text: TOKEN }] },
      ],
    });
    expect(b.chamadas[1]).toEqual({
      fn: "agenda_lead_link_para_envio",
      args: { p_waba_id: "waba1", p_template: "convite_agenda", p_conta: CONTA, p_lead: LEAD },
    });
  });

  it("troca o link que o editor do CRM v2 já tinha posto (sem o número) pelo que leva o número", () => {
    const antigo = { type: "button", sub_type: "url", index: 0, parameters: [{ type: "text", text: "b".repeat(56) }] };
    const outroBotao = { type: "button", sub_type: "url", index: 1, parameters: [{ type: "text", text: "cupom" }] };
    const corpo = { type: "body", parameters: [] };
    expect(comBotaoDaAgenda([corpo, antigo, outroBotao], 0, TOKEN)).toEqual([
      corpo,
      outroBotao,
      { type: "button", sub_type: "url", index: 0, parameters: [{ type: "text", text: TOKEN }] },
    ]);
  });

  it("lead que já tem reunião: não envia, e diz por quê", async () => {
    const b = banco({ ...lista, agenda_lead_link_para_envio: { data: { aplica: true, ok: false, motivo: "ja_tem_reuniao" } } });
    const r = await linkDaAgendaNoEnvio(b, { wabaId: "waba1", template: "convite_agenda", contaId: CONTA, leadId: LEAD, comps: [] });
    expect(r).toEqual({
      aplica: true,
      ok: false,
      erro: "O lead já tem reunião marcada: o convite da agenda não foi enviado de novo.",
    });
  });

  it("falha ao montar o link: não envia o modelo com o botão quebrado", async () => {
    const b = banco({ ...lista, agenda_lead_link_para_envio: { error: { message: "timeout" } } });
    const r = await linkDaAgendaNoEnvio(b, { wabaId: "waba1", template: "convite_agenda", contaId: CONTA, leadId: LEAD, comps: [] });
    expect(r.aplica).toBe(true);
    expect(r).toMatchObject({ ok: false });
  });

  it("id de lead que não é uuid vai como 'sem lead', em vez de derrubar a consulta", async () => {
    const b = banco({ ...lista, agenda_lead_link_para_envio: { data: { aplica: true, ok: true, indice: 0, valor: "c".repeat(20), tipo: "geral" } } });
    await linkDaAgendaNoEnvio(b, { wabaId: "waba1", template: "convite_agenda", contaId: CONTA, leadId: "não-é-uuid", comps: [] });
    expect(b.chamadas[1].args?.p_lead).toBeNull();
  });
});

/**
 * "LINK DE AGENDAMENTO" NO TEXTO (17/11/2026). A variável sai do banco com o link do lead sem o
 * número; a edge põe o número que está enviando. O que não pode acontecer: modelo comum pagar
 * consulta, e uma falha na troca derrubar o envio ou estragar o link.
 */
describe("o link de agendamento no texto ganha o número que envia", () => {
  const T56 = "b".repeat(56);
  const T88 = "c".repeat(88);
  const SITE = "https://sistema.invalid/agendar-reuniao/";
  const corpo = (texto: string) => [
    { type: "body", parameters: [{ type: "text", text: "Ana" }, { type: "text", text: texto }] },
  ];

  it("troca o link de 56 hex pelo de 88, e deixa o resto do texto como está", async () => {
    const b = banco({ agenda_lead_link_com_numero: { data: T88 } });
    const r = await linkDeAgendamentoComNumero(b, corpo(`Escolha aqui: ${SITE}${T56} até sexta`), CONTA);
    expect(r).toEqual(corpo(`Escolha aqui: ${SITE}${T88} até sexta`));
    expect(b.chamadas).toEqual([{ fn: "agenda_lead_link_com_numero", args: { p_token: T56, p_conta: CONTA } }]);
  });

  it("modelo sem o link no texto não consulta nada e volta igual", async () => {
    const b = banco({});
    const comps = corpo("hoje às 19h30");
    expect(await linkDeAgendamentoComNumero(b, comps, CONTA)).toBe(comps);
    expect(b.chamadas).toEqual([]);
  });

  it("o link que já tem o número (88 hex) e o link geral (20 hex) não são mexidos", async () => {
    const b = banco({ agenda_lead_link_com_numero: { data: T88 } });
    const comps = corpo(`${SITE}${T88} ou ${SITE}${"d".repeat(20)}`);
    expect(await linkDeAgendamentoComNumero(b, comps, CONTA)).toBe(comps);
    expect(b.chamadas).toEqual([]);
  });

  it("falha na troca: o link de 56 hex segue como veio, e o envio não para", async () => {
    const b = banco({ agenda_lead_link_com_numero: { error: { message: "timeout" } } });
    const comps = corpo(`${SITE}${T56}`);
    expect(await linkDeAgendamentoComNumero(b, comps, CONTA)).toBe(comps);
  });

  it("o banco recusou o link (assinatura que não confere): nada é trocado", async () => {
    const b = banco({ agenda_lead_link_com_numero: { data: null } });
    const comps = corpo(`${SITE}${T56}`);
    expect(await linkDeAgendamentoComNumero(b, comps, CONTA)).toBe(comps);
  });

  it("sem conta válida não há número para pôr no link", async () => {
    const b = banco({ agenda_lead_link_com_numero: { data: T88 } });
    const comps = corpo(`${SITE}${T56}`);
    expect(await linkDeAgendamentoComNumero(b, comps, "conexao-web")).toBe(comps);
    expect(b.chamadas).toEqual([]);
  });

  it("o mesmo link em duas variáveis é consultado uma vez só", async () => {
    const b = banco({ agenda_lead_link_com_numero: { data: T88 } });
    const comps = [
      { type: "header", parameters: [{ type: "text", text: `${SITE}${T56}` }] },
      { type: "body", parameters: [{ type: "text", text: `${SITE}${T56}` }] },
      // o botão do modelo leva só o token, sem o endereço: não é assunto desta função
      { type: "button", sub_type: "url", index: 0, parameters: [{ type: "text", text: T56 }] },
    ];
    const r = (await linkDeAgendamentoComNumero(b, comps, CONTA)) as typeof comps;
    expect(b.chamadas).toHaveLength(1);
    expect(r[0].parameters[0].text).toBe(`${SITE}${T88}`);
    expect(r[1].parameters[0].text).toBe(`${SITE}${T88}`);
    expect(r[2]).toEqual(comps[2]);
  });
});
