import { describe, expect, it, vi } from 'vitest';
vi.mock('./agente.ts', () => ({ provedorOpenai: vi.fn(() => ({ nome: 'openai', formato: 'openai', modelo: 'gpt-5.6-luna', esforco: 'high' })) }));
import { selecionarProvedorDoLead } from './pilotoOpenai';
import { provedorOpenai } from './agente';

const banco = (data: unknown, error: unknown = null) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }) });
describe('provedor do piloto, comum ao atendimento e follow-up', () => {
  it.each([false, undefined, null, 'true'])('só true explícito habilita raciocínio: %s', async (opcao) => {
    const p = await selecionarProvedorDoLead(banco({ luna_telefones: ['5546988166051'], openai_raciocinio_encadeado: opcao }), '46988166051');
    expect(p).not.toHaveProperty('raciocinio');
    expect(p).not.toHaveProperty('memoriaRaciocinio');
  });
  it('cria memória exclusiva por rodada, sem mudar modelo/esforço nem liberar outro telefone', async () => {
    const config = banco({ luna_telefones: ['5546988166051'], openai_raciocinio_encadeado: true });
    const [p1, p2] = await Promise.all([selecionarProvedorDoLead(config, '46988166051'), selecionarProvedorDoLead(config, '46988166051')]);
    expect(p1).toMatchObject({ modelo: 'gpt-5.6-luna', esforco: 'high', raciocinio: true });
    if (p1?.formato !== 'openai' || p2?.formato !== 'openai') throw new Error('Provedores não selecionados');
    expect(p1.memoriaRaciocinio).toBeInstanceOf(Map);
    expect(p1.memoriaRaciocinio).not.toBe(p2.memoriaRaciocinio);
    p1.memoriaRaciocinio!.set('call_1', { openaiId: 'fc_1' });
    expect(p2.memoriaRaciocinio!.size).toBe(0);
    expect(await selecionarProvedorDoLead(config, '47988166051')).toBeNull();
  });
  it('troca o modelo só para o telefone autorizado e preserva o esforço', async () => {
    const config = { luna_telefones: ['5546988166051'], openai_modelo_piloto: 'gpt-6-luna' };
    expect(await selecionarProvedorDoLead(banco(config), '46988166051')).toMatchObject({ modelo: 'gpt-6-luna', esforco: 'high' });
    expect(await selecionarProvedorDoLead(banco(config), '47988166051')).toBeNull();
  });
  it.each([null, undefined, 'modelo-nao-aprovado'])('sem substituição válida preserva o modelo do ambiente: %s', async (modelo) => {
    expect(await selecionarProvedorDoLead(banco({ luna_telefones: ['5546988166051'], openai_modelo_piloto: modelo }), '46988166051'))
      .toMatchObject({ modelo: 'gpt-5.6-luna' });
  });
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
