import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IG_PORTFOLIO_URL, IG_WA_ACCOUNT_ID } from '../_shared/igWhatsapp';
import { prepararPortfolioInstagram } from './portfolioInstagram';

// Banco simulado: só o que o módulo toca (a RPC, a memória do agente e a devolução).
function banco(pendencia: Record<string, unknown> | null, erroRpc: string | null = null) {
  const escritas: { tabela: string; op: string; payload: any; filtros: Record<string, unknown> }[] = [];
  const admin = {
    rpc: vi.fn(async () => ({ data: pendencia ? [pendencia] : [], error: erroRpc ? { message: erroRpc } : null })),
    from: (tabela: string) => {
      const q: any = { filtros: {} };
      q.insert = async (payload: any) => { escritas.push({ tabela, op: 'insert', payload, filtros: {} }); return { error: null }; };
      q.update = (payload: any) => { q.op = 'update'; q.payload = payload; return q; };
      q.eq = (k: string, v: unknown) => { q.filtros[k] = v; return q; };
      q.then = (ok: any) => { escritas.push({ tabela, op: q.op, payload: q.payload, filtros: q.filtros }); return Promise.resolve({ error: null }).then(ok); };
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
    expect(escritas[0].payload.conversation_history.content).toMatch(/^\[INSTAGRAM\].*concluiu a graduação/);
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
