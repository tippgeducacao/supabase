// 06/11/2026: o laboratório começa no HTTP, antes de o João receber a mensagem.
// Observação opt-in: falhar aqui nunca modifica o atendimento nem sua resposta HTTP.
import { semDadosPrivados, observarSemInterromper, observadorDaRodada } from '../crm-agente-sdr/capturaModelo.ts';

type Objeto = Record<string, any>;
type Banco = { from: (tabela: string) => any };
type Registro = { remotejid: string; mensagemId: string; pedido: Objeto; enviado: Objeto; criado_em: string };

// O opt-in continua pertencendo ao telefone EXATO escolhido no painel. Só a procura
// considera as duas grafias que a Meta usa para celulares BR (com/sem o nono dígito).
export function jidsDeEntrada(valor: unknown): string[] {
  const d = String(valor ?? '').split('@')[0].replace(/\D/g, '');
  if (!d) return [];
  const candidatos = new Set([d]);
  if (d.startsWith('55') && d.length === 12 && /[6-9]/.test(d[4])) candidatos.add(d.slice(0, 4) + '9' + d.slice(4));
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') candidatos.add(d.slice(0, 4) + d.slice(5));
  return [...candidatos].map(n => `${n}@s.whatsapp.net`);
}

export function entradasMeta(payload: Objeto): Omit<Registro, 'remotejid' | 'criado_em'>[] {
  const entradas: Omit<Registro, 'remotejid' | 'criado_em'>[] = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== 'messages') continue;
      const value = change?.value ?? {};
      for (const msg of Array.isArray(value.messages) ? value.messages : []) {
        if (!msg?.from || !msg?.id) continue;
        // Um POST pode trazer vários leads. A captura do lead A jamais guarda o B.
        const { messages: _msgs, statuses: _statuses, contacts: _contacts, ...resto } = value;
        entradas.push({
          mensagemId: String(msg.id),
          pedido: {
            metodo: 'POST', caminho: '/functions/v1/crm-whatsapp-webhook',
            recorte: 'Uma mensagem e o contato remetente deste POST; os demais leads foram omitidos.',
            body: { object: payload.object, entry: [{ id: entry.id, changes: [{ field: change.field, value: {
              ...resto, messages: [msg], contacts: (Array.isArray(value.contacts) ? value.contacts : []).filter((c: Objeto) => c?.wa_id === msg.from),
            } }] }] },
          },
          enviado: { etapa: 'webhook_meta', mensagem_id: String(msg.id), telefone: String(msg.from), decisao: 'recebida', payload: null },
        });
      }
    }
  }
  return entradas;
}

export type CapturaWebhook = {
  anotar: (mensagemId: unknown, dados: Objeto) => void;
  finalizar: (resposta: Response) => Promise<void>;
};
const inativa: CapturaWebhook = { anotar: () => {}, finalizar: async () => {} };

export async function iniciarCapturaWebhook(banco: Banco, payload: Objeto, assinatura: string, contentType: string | null): Promise<CapturaWebhook> {
  try {
    const entradas = entradasMeta(payload);
    const candidatos = [...new Set(entradas.flatMap(e => jidsDeEntrada(e.enviado.telefone)))];
    if (!candidatos.length) return inativa;
    const recebidoEm = new Date().toISOString();
    const { data, error } = await banco.from('crm_sdr_laboratorio_config').select('remotejid,capturar_ate')
      .in('remotejid', candidatos).gt('capturar_ate', recebidoEm);
    if (error || !data?.length) return inativa;
    const registros: Registro[] = entradas.flatMap(e => data
      .filter((c: Objeto) => jidsDeEntrada(e.enviado.telefone).includes(c.remotejid) && Date.parse(c.capturar_ate) > Date.now())
      .map((c: Objeto) => ({ ...e, remotejid: c.remotejid, criado_em: recebidoEm,
        pedido: { ...e.pedido, assinatura, headers: { 'content-type': contentType } }, enviado: { ...e.enviado },
      })));
    let finalizada = false;
    return {
      anotar(id, dados) {
        registros.filter(r => r.mensagemId === id).forEach(r => { r.enviado = { ...r.enviado, ...dados }; });
      },
      async finalizar(resposta) {
        if (finalizada || !registros.length) return;
        finalizada = true;
        try {
          const body = await resposta.clone().json().catch(() => null);
          const { error: erro } = await banco.from('crm_sdr_laboratorio_capturas').insert(registros.map(r => semDadosPrivados({
            remotejid: r.remotejid, rodada_id: crypto.randomUUID(), criado_em: r.criado_em,
            agente: 'Webhook do WhatsApp', tipo: 'entrada', provedor: 'meta',
            pedido: r.pedido, enviado: r.enviado,
            resposta: { status_http: resposta.status, body },
            origens: { mensagens_entrada: [r.mensagemId] },
            erro: resposta.status >= 400 ? `HTTP ${resposta.status} no recebimento` : null,
          })));
          if (erro) console.log('[sdr] captura do webhook indisponível');
        } catch { console.log('[sdr] captura do webhook indisponível'); }
      },
    };
  } catch { return inativa; }
}

export async function capturarEntradaAgente(banco: Banco, payload: Objeto, resposta: Response, enviado?: Objeto) {
  try {
    const remotejid = typeof payload?.remotejid === 'string' ? payload.remotejid : '';
    if (!remotejid) return;
    const observar = await observadorDaRodada(banco, remotejid, crypto.randomUUID(), 'Entrada do João', [payload.id].filter(Boolean));
    if (!observar) return;
    const body = await resposta.clone().json().catch(() => null);
    await observarSemInterromper(observar, {
      tipo: 'entrada', provedor: 'interno',
      pedido: { metodo: 'POST', caminho: '/functions/v1/crm-agente-sdr', body: payload },
      enviado: { etapa: 'entrada_agente', mensagem_id: payload.id, decisao: body?.skip ?? (resposta.ok && enviado ? 'aceita_para_processamento' : 'encerrada_na_entrada'), payload: enviado ?? null },
      resposta: { status_http: resposta.status, body },
      ...(resposta.ok ? {} : { erro: `HTTP ${resposta.status} na entrada do João` }),
    });
  } catch { /* A captura não participa da decisão de atender. */ }
}
