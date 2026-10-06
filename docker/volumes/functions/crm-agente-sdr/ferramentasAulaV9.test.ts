import { beforeAll, describe, expect, it, vi } from 'vitest';

let comDescricoesDaAulaV9: typeof import('./ferramentasAulaV9').comDescricoesDaAulaV9;
let DESCRICOES_AULA_V9: typeof import('./ferramentasAulaV9').DESCRICOES_AULA_V9;
let ferramentasDaAula: () => any[];
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  ({ comDescricoesDaAulaV9, DESCRICOES_AULA_V9 } = await import('./ferramentasAulaV9'));
  const { FERRAMENTAS, FERRAMENTAS_POR_AGENTE } = await import('./tools-luna');
  const { TOOL_RESPONDER_AO_CLIENTE } = await import('./canalResposta');
  // Como agente.ts carregarTools (formato openai) + o que a rota `tools` do v9 acrescenta.
  ferramentasDaAula = () => [
    ...FERRAMENTAS_POR_AGENTE.agente_aula.map((apelido) => structuredClone(FERRAMENTAS[apelido])).map((t: any) => ({
      name: t.name, description: t.description ?? '', input_schema: t.parameters, ...(t.strict === true ? { strict: true } : {}),
    })),
    structuredClone(TOOL_RESPONDER_AO_CLIENTE),
  ];
});

const tamanho = (t: any) => (t.description ?? '').length
  + Object.values(t.input_schema?.properties ?? {}).reduce((s: number, p: any) => s + String(p.description ?? '').length, 0);
const semDescricao = (t: any) => {
  const c = structuredClone(t);
  delete c.description;
  for (const p of Object.values(c.input_schema?.properties ?? {}) as any[]) delete p.description;
  return c;
};
const PROIBIDAS = ['falta um passo', 'falta só um passo', 'PRESENTE DA ESCOLA', 'escoladeespecializacao', 'FICHA DO ATENDIMENTO'];

describe('descrições enxutas da aula no v9', () => {
  it('cobre as 11 ferramentas da aula', () => {
    expect(ferramentasDaAula().map((t) => t.name).sort()).toEqual(Object.keys(DESCRICOES_AULA_V9).sort());
  });

  it('o contrato não muda: nomes, ordem, campos, tipos, enum, required, strict', () => {
    const antes = ferramentasDaAula();
    const depois = comDescricoesDaAulaV9(antes);
    expect(depois.map((t) => t.name)).toEqual(antes.map((t) => t.name));
    for (let i = 0; i < antes.length; i++) {
      expect(Object.keys(depois[i].input_schema.properties)).toEqual(Object.keys(antes[i].input_schema.properties));
      expect(depois[i].input_schema.required).toEqual(antes[i].input_schema.required);
      expect(semDescricao(depois[i])).toEqual(semDescricao(antes[i]));
    }
  });

  it('todo campo com texto proposto existe na ferramenta', () => {
    const porNome = new Map(ferramentasDaAula().map((t) => [t.name, t]));
    for (const [nome, d] of Object.entries(DESCRICOES_AULA_V9)) {
      for (const campo of Object.keys(d.campos ?? {})) expect(porNome.get(nome)!.input_schema.properties).toHaveProperty(campo);
    }
  });

  it('as descrições ficaram menores e sem as ordens que vazavam', () => {
    const antes = ferramentasDaAula();
    const depois = comDescricoesDaAulaV9(antes);
    for (let i = 0; i < antes.length; i++) {
      expect(depois[i].description.length).toBeLessThan(antes[i].description.length);
      expect(tamanho(depois[i])).toBeLessThan(tamanho(antes[i]));
      const textos = [depois[i].description, ...Object.values(depois[i].input_schema.properties).map((p: any) => p.description ?? '')].join('\n');
      for (const p of PROIBIDAS) expect(textos).not.toContain(p);
    }
  });

  it('o perfil da busca_carreira cita todos os perfis do enum', async () => {
    // Desde 06/10/2026 a busca_carreira é montada pela pós (carreiraPos.toolBuscaCarreira), fora desta lista.
    const { TOOL_BUSCA_CARREIRA } = await import('./rotasV9');
    const perfil = TOOL_BUSCA_CARREIRA.input_schema.properties.perfil;
    for (const p of perfil.enum) expect(perfil.description).toContain(`${p}:`);
  });

  it('não muta a entrada e deixa passar ferramenta fora da lista', () => {
    const antes = ferramentasDaAula();
    const copia = structuredClone(antes);
    const estranha = { name: 'confirmar_agendamento', description: 'original', input_schema: { type: 'object', properties: { x: { type: 'string', description: 'campo' } } } };
    const depois = comDescricoesDaAulaV9([...antes, estranha]);
    expect(antes).toEqual(copia);
    expect(depois.at(-1)).toEqual(estranha);
    expect(depois.at(-1)).not.toBe(estranha);
  });
});
