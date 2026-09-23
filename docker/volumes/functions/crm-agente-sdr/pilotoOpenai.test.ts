import { describe, expect, it, vi } from 'vitest';
vi.mock('./agente.ts', () => ({ provedorOpenai: vi.fn(() => ({ nome: 'openai' })) }));
import { selecionarProvedorDoLead } from './pilotoOpenai';
import { provedorOpenai } from './agente';

const banco = (data: unknown, error: unknown = null) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }) });
describe('provedor do piloto, comum ao atendimento e follow-up', () => {
  it.each(['5546988166051', '554688166051', '46988166051'])('reconhece o mesmo telefone: %s', async (telefone) => {
    expect(await selecionarProvedorDoLead(banco({ luna_telefones: ['5546988166051'] }), telefone)).toMatchObject({ nome: 'openai' });
  });
  it.each(['5547988166051', '5546988166052', ''])('não libera outro lead: %s', async (telefone) => {
    expect(await selecionarProvedorDoLead(banco({ luna_telefones: ['5546988166051'] }), telefone)).toBeNull();
  });
  it('erro de leitura, lista vazia e chave ausente conservam Anthropic', async () => {
    expect(await selecionarProvedorDoLead(banco(null, {}), '5546988166051')).toBeNull();
    expect(await selecionarProvedorDoLead(banco({ luna_telefones: [] }), '5546988166051')).toBeNull();
    vi.mocked(provedorOpenai).mockReturnValueOnce(null);
    expect(await selecionarProvedorDoLead(banco({ luna_telefones: ['5546988166051'] }), '5546988166051')).toBeNull();
  });
});
