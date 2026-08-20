import { describe, expect, it } from 'vitest';
import { buscarLead, jidsDoTelefone } from './historico';

// Supabase de mentira: guarda o filtro que recebeu e devolve as linhas combinadas.
function supabaseFake(linhas: Array<Record<string, unknown>>) {
  const visto: { coluna?: string; valores?: string[] } = {};
  const client = {
    from() { return client; },
    select() { return client; },
    in(coluna: string, valores: string[]) {
      visto.coluna = coluna;
      visto.valores = valores;
      return client;
    },
    limit() {
      const alvo = new Set(visto.valores ?? []);
      return Promise.resolve({
        data: linhas.filter((l) => alvo.has(String(l.remotejid))),
        error: null,
      });
    },
  };
  return { client, visto };
}

describe('jidsDoTelefone', () => {
  it('gera as duas variantes do 9º dígito a partir do telefone cru', () => {
    expect(jidsDoTelefone('46988166051')).toEqual([
      '5546988166051@s.whatsapp.net',
      '554688166051@s.whatsapp.net',
    ]);
  });

  it('aceita um jid completo como entrada', () => {
    expect(jidsDoTelefone('5546988166051@s.whatsapp.net')).toEqual([
      '5546988166051@s.whatsapp.net',
      '554688166051@s.whatsapp.net',
    ]);
  });
});

describe('buscarLead', () => {
  // O bug: o WEBCHAT monta o contexto com `remotejid = telefone` (cru). Com .eq() a
  // busca voltava null mesmo com o lead existindo, e os gates que dependem dele
  // (formação em confirmar_agendamento, aviso na consulta_disponibilidade) ficavam
  // fail-open no chat do site.
  it('acha o lead pelo telefone cru que o webchat usa como chave', async () => {
    const { client } = supabaseFake([
      { remotejid: '5546988166051@s.whatsapp.net', formacao_academica: 'Medicina Veterinária' },
    ]);
    const lead = await buscarLead(client, '46988166051');
    expect(lead?.formacao_academica).toBe('Medicina Veterinária');
  });

  it('acha o lead pela variante sem o 9º dígito', async () => {
    const { client } = supabaseFake([{ remotejid: '554688166051@s.whatsapp.net', nome: 'gustavo' }]);
    const lead = await buscarLead(client, '5546988166051@s.whatsapp.net');
    expect(lead?.nome).toBe('gustavo');
  });

  // 55 telefones da base têm as DUAS variantes como linhas separadas: maybeSingle()
  // estouraria, e pegar a primeira mudaria o lead do WhatsApp sem motivo.
  it('prefere o match exato quando as duas variantes existem', async () => {
    const { client } = supabaseFake([
      { remotejid: '554688166051@s.whatsapp.net', nome: 'linha antiga' },
      { remotejid: '5546988166051@s.whatsapp.net', nome: 'linha certa' },
    ]);
    const lead = await buscarLead(client, '5546988166051@s.whatsapp.net');
    expect(lead?.nome).toBe('linha certa');
  });

  it('devolve null quando não existe lead nenhum', async () => {
    const { client } = supabaseFake([]);
    expect(await buscarLead(client, '46988166051')).toBeNull();
  });
});
