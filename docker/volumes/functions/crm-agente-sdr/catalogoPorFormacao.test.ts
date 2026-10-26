import { describe, expect, it } from 'vitest';
import { evidenciasDaFormacao, filtrarCatalogoPelaFormacao, lerLeituraDaFormacao, type LeituraDaFormacao } from './catalogoPorFormacao.ts';
import { linhaDoCurso } from './linhaDaMatriz.ts';

const MBA = 'Qualquer formação de NÍVEL SUPERIOR completa pode fazer: bacharelado, licenciatura ou tecnólogo';
const tabela = [
  { pos_graduacao: 'Cannabis Medicinal', pode_fazer: 'Medicina Veterinária', parcialmente_aceitas: '—' },
  { pos_graduacao: 'Qualidade e Segurança de Alimentos de Origem Animal', pode_fazer: 'Medicina Veterinária; Zootecnia; Biologia',
    parcialmente_aceitas: 'Nutricionistas (com atuação em POA); Biomédicos (com atuação laboratorial)' },
  { pos_graduacao: 'Saúde Única e Zoonoses', pode_fazer: 'Biologia; Enfermagem; Medicina Veterinária', parcialmente_aceitas: 'Biomedicina; Farmácia' },
  { pos_graduacao: 'MBA Postura Comercial', pode_fazer: MBA, parcialmente_aceitas: null },
  { pos_graduacao: 'Nutrição e Gestão de Bovinos', pode_fazer: 'Medicina Veterinária; Zootecnia', parcialmente_aceitas: 'Engenharia de Alimentos' },
  { pos_graduacao: 'Reprodução, Nutrição e Gestão de Bovinos (3 em 1)', pode_fazer: 'Medicina Veterinária', parcialmente_aceitas: '—' },
];
const curso = (nome_oficial: string) => ({ id: nome_oficial, nome_oficial, nome: nome_oficial.replace(/^(PÓS|MBA) \| /, ''), modalidades: ['online'] });
const catalogo = [
  curso('PÓS | CANNABIS MEDICINAL VETERINÁRIA'),
  curso('PÓS | FITOTERAPIA VETERINÁRIA COM ÊNFASE EM PLANTAS MEDICINAIS'),
  curso('PÓS | QUALIDADE E SEGURANÇA DE ALIMENTOS DE ORIGEM ANIMAL'),
  curso('PÓS | SAÚDE ÚNICA E ZOONOSES'),
  curso('MBA | POSTURA COMERCIAL'),
  curso('PÓS | NUTRIÇÃO E GESTÃO DE BOVINOS'),
  curso('PÓS | REPRODUÇÃO, NUTRIÇÃO E GESTÃO DE BOVINOS (3EM1)'),
];
const leitura = (extra: Partial<LeituraDaFormacao>): LeituraDaFormacao => ({ formacao_identificada: 'Farmácia', e_medico_veterinario: false, cursos: [], ...extra });
const nomes = (r: Array<{ nome_oficial: string }>) => r.map((c) => c.nome_oficial);

describe('catálogo filtrado pela formação (caso Jemima, farmacêutica)', () => {
  it('só sobra o que a IA aceitou e o código confere: Saúde Única (parcial) e o MBA', () => {
    const r = filtrarCatalogoPelaFormacao(catalogo, tabela, leitura({ cursos: [
      { curso: 'PÓS | SAÚDE ÚNICA E ZOONOSES', linha_da_tabela: 'Saúde Única e Zoonoses', aceite: 'parcial', condicao: null },
      { curso: 'MBA | POSTURA COMERCIAL', linha_da_tabela: 'MBA Postura Comercial', aceite: 'inteira', condicao: null },
    ] }));
    expect(nomes(r)).toEqual(['PÓS | SAÚDE ÚNICA E ZOONOSES', 'MBA | POSTURA COMERCIAL']);
    expect(r[0].aceite).toBe('parcial');
  });

  it('pós só de veterinário não passa para quem não é veterinário, mesmo se a IA incluir', () => {
    const r = filtrarCatalogoPelaFormacao(catalogo, tabela, leitura({ cursos: [
      { curso: 'PÓS | CANNABIS MEDICINAL VETERINÁRIA', linha_da_tabela: 'Cannabis Medicinal', aceite: 'inteira', condicao: null },
      { curso: 'PÓS | REPRODUÇÃO, NUTRIÇÃO E GESTÃO DE BOVINOS (3EM1)', linha_da_tabela: 'Nutrição e Gestão de Bovinos', aceite: 'inteira', condicao: null },
    ] }));
    expect(r).toEqual([]);
  });

  it('veterinário recebe as pós só de veterinário', () => {
    const r = filtrarCatalogoPelaFormacao(catalogo, tabela, leitura({ formacao_identificada: 'Medicina Veterinária', e_medico_veterinario: true,
      cursos: [{ curso: 'PÓS | CANNABIS MEDICINAL VETERINÁRIA', linha_da_tabela: 'Cannabis Medicinal', aceite: 'inteira', condicao: null }] }));
    expect(nomes(r)).toEqual(['PÓS | CANNABIS MEDICINAL VETERINÁRIA']);
  });

  it('curso fora do catálogo ou linha fora da tabela não entra (a IA não inventa)', () => {
    const r = filtrarCatalogoPelaFormacao(catalogo, tabela, leitura({ cursos: [
      { curso: 'PÓS | FARMÁCIA CLÍNICA VETERINÁRIA', linha_da_tabela: 'Saúde Única e Zoonoses', aceite: 'inteira', condicao: null },
      { curso: 'PÓS | FITOTERAPIA VETERINÁRIA COM ÊNFASE EM PLANTAS MEDICINAIS', linha_da_tabela: 'Fitoterapia', aceite: 'inteira', condicao: null },
    ] }));
    expect(r).toEqual([]);
  });

  it('linha de "qualquer formação superior" vira aceite inteira e a ressalva da parcial vai junto', () => {
    const r = filtrarCatalogoPelaFormacao(catalogo, tabela, leitura({ formacao_identificada: 'Nutrição', cursos: [
      { curso: 'MBA | POSTURA COMERCIAL', linha_da_tabela: 'MBA Postura Comercial', aceite: 'parcial', condicao: null },
      { curso: 'PÓS | QUALIDADE E SEGURANÇA DE ALIMENTOS DE ORIGEM ANIMAL', linha_da_tabela: 'Qualidade e Segurança de Alimentos de Origem Animal',
        aceite: 'parcial', condicao: 'com atuação em POA' },
    ] }));
    expect(r.map((c) => [c.aceite, c.condicao])).toEqual([['parcial', 'com atuação em POA'], ['inteira', undefined]]);
  });

  it('formação desconhecida não filtra nada para dentro', () => {
    expect(filtrarCatalogoPelaFormacao(catalogo, tabela, leitura({ formacao_identificada: null }))).toEqual([]);
  });
});

describe('leitura da IA', () => {
  it('aceita o JSON combinado, mesmo dentro de bloco markdown, e descarta item malformado', () => {
    const r = lerLeituraDaFormacao('```json\n{"formacao_identificada":"Farmácia","e_medico_veterinario":false,"cursos":['
      + '{"curso":"PÓS | SAÚDE ÚNICA E ZOONOSES","linha_da_tabela":"Saúde Única e Zoonoses","aceite":"parcial","condicao":null},'
      + '{"curso":"X","linha_da_tabela":"Y","aceite":"talvez"}]}\n```');
    expect(r).toEqual({ formacao_identificada: 'Farmácia', e_medico_veterinario: false,
      cursos: [{ curso: 'PÓS | SAÚDE ÚNICA E ZOONOSES', linha_da_tabela: 'Saúde Única e Zoonoses', aceite: 'parcial', condicao: null }] });
  });

  it('formato errado é falha (quem chama segue sem filtro)', () => {
    expect(() => lerLeituraDaFormacao('{"formacao_identificada":"Farmácia","cursos":[]}')).toThrow();
    expect(() => lerLeituraDaFormacao('não sei')).toThrow();
  });
});

describe('o que a IA lê', () => {
  it('junta o cadastro e as falas do lead, sem as do agente nem resultado de ferramenta', () => {
    const texto = evidenciasDaFormacao([
      { role: 'assistant', content: 'qual área vc procura?' },
      { role: 'user', content: 'Eu sou farmacêutica' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '{"cursos":[]}' }] },
      { role: 'user', content: 'Qual pos vcs tem ?' },
    ] as any, { formacao_academica: 'Sou formado em outra área' });
    expect(texto).toContain('CADASTRO: Sou formado em outra área');
    expect(texto).toContain('- Eu sou farmacêutica\n- Qual pos vcs tem ?');
    expect(texto).not.toContain('qual área vc procura');
    expect(texto).not.toContain('cursos');
  });

  it('sem cadastro e sem fala do lead não há o que ler', () => {
    expect(evidenciasDaFormacao([], null)).toBe('');
  });
});

describe('linha da tabela pelo nome do catálogo', () => {
  it('nome igual ganha da linha mais longa que o contém (Nutrição e Gestão ≠ 3em1)', () => {
    expect(linhaDoCurso(tabela, 'PÓS | NUTRIÇÃO E GESTÃO DE BOVINOS')?.pos_graduacao).toBe('Nutrição e Gestão de Bovinos');
    expect(linhaDoCurso(tabela, 'PÓS | REPRODUÇÃO, NUTRIÇÃO E GESTÃO DE BOVINOS (3EM1)')?.pos_graduacao)
      .toBe('Reprodução, Nutrição e Gestão de Bovinos (3 em 1)');
    expect(linhaDoCurso(tabela, 'PÓS | CANNABIS MEDICINAL VETERINÁRIA')?.pos_graduacao).toBe('Cannabis Medicinal');
  });
});
