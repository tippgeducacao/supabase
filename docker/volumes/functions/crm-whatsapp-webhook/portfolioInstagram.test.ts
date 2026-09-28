import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IG_AVISO_FORA_DO_PRAZO, IG_PORTFOLIO_URL, IG_WA_ACCOUNT_ID } from '../_shared/igWhatsapp';
import { jidsDoLead, prepararPortfolioInstagram } from './portfolioInstagram';

// Banco simulado: só o que o módulo toca (a RPC, a memória do agente e a devolução).
function banco(pendencia: Record<string, unknown> | null, erroRpc: string | null = null, jaNoAgente = false) {
  const escritas: { tabela: string; op: string; payload: any; filtros: Record<string, unknown> }[] = [];
  const admin = {
    rpc: vi.fn(async () => ({ data: pendencia ? [pendencia] : [], error: erroRpc ? { message: erroRpc } : null })),
    from: (tabela: string) => {
      const q: any = { filtros: {} };
      q.insert = async (payload: any) => { escritas.push({ tabela, op: 'insert', payload, filtros: {} }); return { error: null }; };
      q.update = (payload: any) => { q.op = 'update'; q.payload = payload; return q; };
      q.eq = (k: string, v: unknown) => { q.filtros[k] = v; return q; };
      q.in = (k: string, v: unknown) => { q.filtros[k] = v; return q; };
      q.select = () => { q.op = 'select'; return q; };
      q.limit = () => q;
      q.maybeSingle = async () => ({
        data: tabela === 'leads' ? { nome: 'Jucileia Sousa' } : tabela === 'ig_conversa_ia' ? { area: 'agronomia' } : null,
        error: null,
      });
      q.upsert = async (payload: any, opcoes: any) => { escritas.push({ tabela, op: 'upsert', payload, filtros: opcoes }); return { error: null }; };
      q.then = (ok: any) => {
        if (q.op === 'select') return Promise.resolve({ data: jaNoAgente ? [{ id: 'sdr-1' }] : [], error: null }).then(ok);
        escritas.push({ tabela, op: q.op, payload: q.payload, filtros: q.filtros });
        return Promise.resolve({ error: null }).then(ok);
      };
      return q;
    },
  };
  return { admin, escritas };
}

const PEND = { conta_id: 'ig-conta', igsid: '1392817699234137', lead_id: 'lead-1', oportunidade_id: 'op-1', situacao: 'formado', data_formacao: null };
const entrada = (enviar: any, extra = {}) => ({
  accountId: IG_WA_ACCOUNT_ID, telefone: '5546999882268', remotejid: '5546999882268@s.whatsapp.net',
  timestampSeg: 1790370000, leadId: 'lead-webhook', oportunidadeId: null, enviar, ...extra,
});

let enviar: ReturnType<typeof vi.fn>;
beforeEach(() => { enviar = vi.fn(async () => ({ ok: true })); });

describe('cadastro do agente para quem veio do Instagram (caso Jucileia, 28/09/2026)', () => {
  it('sem cadastro: cria, com o nome do lead e a fonte — senão o João sai calado', async () => {
    const { admin, escritas } = banco(PEND);
    await prepararPortfolioInstagram(admin, entrada(enviar));
    const cadastro = escritas.find((w) => w.tabela === 'cliente_ppg_leads_sdr');
    expect(cadastro).toMatchObject({
      op: 'upsert',
      payload: { remotejid: '5546999882268@s.whatsapp.net', nome: 'Jucileia Sousa', fonte: 'Instagram' },
      filtros: { onConflict: 'remotejid', ignoreDuplicates: true },
    });
  });

  it('já tem cadastro (com ou sem o 9): não mexe', async () => {
    const { admin, escritas } = banco(PEND, null, true);
    await prepararPortfolioInstagram(admin, entrada(enviar));
    expect(escritas.filter((w) => w.tabela === 'cliente_ppg_leads_sdr')).toEqual([]);
  });

  it('as duas grafias do número', () => {
    expect(jidsDoLead('5594991964725@s.whatsapp.net')).toEqual(['5594991964725@s.whatsapp.net', '559491964725@s.whatsapp.net']);
    expect(jidsDoLead('559491964725@s.whatsapp.net')).toEqual(['5594991964725@s.whatsapp.net', '559491964725@s.whatsapp.net']);
  });
});

describe('forma DEPOIS do prazo: portfólio, aviso e pausa — o João nem começa (28/09/2026)', () => {
  const ESTUDANTE_LONGE = { ...PEND, situacao: 'estudante', data_formacao: '2030-06-30' };

  it('pausa o agente ANTES do repasse, agenda o retorno e manda o PDF e depois o aviso com a Escola', async () => {
    const { admin, escritas } = banco(ESTUDANTE_LONGE);
    const envio = await prepararPortfolioInstagram(admin, entrada(enviar));
    const cadastro = escritas.find((w) => w.tabela === 'cliente_ppg_leads_sdr');
    expect(cadastro?.payload).toMatchObject({ fonte: 'Instagram', pausa_ia: true });
    expect(Date.parse(cadastro!.payload.pausa_ia_ate)).toBeGreaterThan(Date.now() + 300 * 86_400_000);
    expect(admin.rpc).toHaveBeenCalledWith('crm_agente_timer_retorno', expect.objectContaining({
      p_telefone: '5546999882268', p_tipo: 'formatura', p_meses: 12,
    }));
    expect(escritas[0].payload.conversation_history.content).toContain('PAUSOU a IA');
    await envio;
    expect(enviar.mock.calls.map(([c]: any) => c.tipo)).toEqual(['document', 'text']);
    expect(enviar.mock.calls[1][0].conteudo).toBe(IG_AVISO_FORA_DO_PRAZO);
    expect(IG_AVISO_FORA_DO_PRAZO).toContain('https://escoladeespecializacao.ppgvet.com.br');
  });

  it('já tinha cadastro no SDR: só liga a pausa nele', async () => {
    const { admin, escritas } = banco(ESTUDANTE_LONGE, null, true);
    await prepararPortfolioInstagram(admin, entrada(enviar));
    expect(escritas.find((w) => w.tabela === 'cliente_ppg_leads_sdr')).toMatchObject({
      op: 'update', payload: { pausa_ia: true },
    });
  });

  it('formado ou dentro do prazo: sem pausa, sem aviso — o João atende', async () => {
    const { admin, escritas } = banco(PEND);
    const envio = await prepararPortfolioInstagram(admin, entrada(enviar));
    await envio;
    expect(escritas.find((w) => w.tabela === 'cliente_ppg_leads_sdr')?.payload.pausa_ia).toBeUndefined();
    expect(admin.rpc).not.toHaveBeenCalledWith('crm_agente_timer_retorno', expect.anything());
    expect(enviar).toHaveBeenCalledTimes(1);
  });
});

describe('portfólio do Instagram: a 1ª resposta no WhatsApp leva o PDF', () => {
  it('outro número da empresa: nem consulta o banco', async () => {
    const { admin } = banco(PEND);
    expect(await prepararPortfolioInstagram(admin, entrada(enviar, { accountId: 'outra-conta' }))).toBeNull();
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('sem pendência (já mandou, ou nunca pediu): não faz nada', async () => {
    const { admin, escritas } = banco(null);
    expect(await prepararPortfolioInstagram(admin, entrada(enviar))).toBeNull();
    expect(escritas).toEqual([]);
    expect(enviar).not.toHaveBeenCalled();
  });

  it('com pendência: nota na memória do agente 1 s ANTES da mensagem e o PDF por documento', async () => {
    const { admin, escritas } = banco(PEND);
    const envio = await prepararPortfolioInstagram(admin, entrada(enviar));
    expect(admin.rpc).toHaveBeenCalledWith('ig_portfolio_reivindicar', { p_wa_account_id: IG_WA_ACCOUNT_ID, p_telefone: '5546999882268' });
    expect(escritas[0]).toMatchObject({
      tabela: 'cliente_ppg_mensagens_sdr', op: 'insert',
      payload: { remotejid: '5546999882268@s.whatsapp.net', timestamp: new Date((1790370000 - 1) * 1000).toISOString() },
    });
    expect(escritas[0].payload.conversation_history).toMatchObject({ role: 'assistant' });
    expect(escritas[0].payload.conversation_history.content).toMatch(/^\[INSTAGRAM\].*concluiu a graduação em agronomia\./);
    // O "Veterinária e Agro" do recibo não é curso escolhido (caso Jucileia, 28/09/2026).
    expect(escritas[0].payload.conversation_history.content).toContain('não procure curso por ele');
    await envio;
    expect(enviar).toHaveBeenCalledWith(expect.objectContaining({
      wa_account_id: IG_WA_ACCOUNT_ID, telefone: '5546999882268', tipo: 'document',
      anexo_url: IG_PORTFOLIO_URL, mime_type: 'application/pdf', lead_id: 'lead-1', oportunidade_id: 'op-1',
    }));
    expect(escritas.filter((w) => w.tabela === 'ig_conversa_ia')).toEqual([]);
  });

  it('o PDF não saiu: devolve a pendência para a próxima mensagem tentar de novo', async () => {
    const { admin, escritas } = banco(PEND);
    enviar.mockResolvedValue({ ok: false, erro: 'Meta 131047' });
    await (await prepararPortfolioInstagram(admin, entrada(enviar)));
    expect(escritas.find((w) => w.tabela === 'ig_conversa_ia')).toMatchObject({
      op: 'update', payload: { portfolio_enviado_em: null }, filtros: { conta_id: 'ig-conta', igsid: '1392817699234137' },
    });
  });

  it('envio que LANÇA também devolve a pendência (nunca derruba o webhook)', async () => {
    const { admin, escritas } = banco(PEND);
    enviar.mockRejectedValue(new Error('rede'));
    await (await prepararPortfolioInstagram(admin, entrada(enviar)));
    expect(escritas.some((w) => w.tabela === 'ig_conversa_ia' && w.payload.portfolio_enviado_em === null)).toBe(true);
  });

  it('erro na RPC: segue o webhook sem PDF', async () => {
    const { admin } = banco(PEND, 'banco fora');
    expect(await prepararPortfolioInstagram(admin, entrada(enviar))).toBeNull();
    expect(enviar).not.toHaveBeenCalled();
  });
});
