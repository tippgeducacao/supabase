import { beforeAll, describe, expect, it, vi } from 'vitest';

// Caso Eliel (12/10/2026): engenheiro de alimentos formado. Inscreveu-se em Sanidade Avícola (só para
// veterinário), recebeu a alternativa fixa Gestão e Produção Avícola, teve reunião marcada para ela e,
// quatro meses depois, ao escolher o horário das 11h, foi reprovado e dispensado: a tabela não listava
// Engenharia de Alimentos nessa pós. A lacuna foi fechada na tabela no mesmo dia (migration
// 20261012120000); a rede abaixo cobre as lacunas que sobrarem: reprovado numa pós, aceito em outra.
let T: typeof import('./tools');
beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: () => '' } });
  T = await import('./tools');
});

// Recorte fiel da tabela cursos_pos_graduacao de produção.
const TABELA = [
  { pos_graduacao: 'Gestão e Produção Avícola', pode_fazer: 'Medicina Veterinária; Zootecnia; Engenharia Agronômica; Biologia; Engenharia de Alimentos', parcialmente_aceitas: 'Tecnólogos em Agropecuária ou Produção Animal; Engenharia Ambiental ou Produção Animal' },
  { pos_graduacao: 'Qualidade e Segurança de Alimentos de Origem Animal', pode_fazer: 'Medicina Veterinária; Zootecnia; Engenharia Agronômica; Biologia; Engenharia de Alimentos; Tecnólogos em Alimentos ou Laticínios', parcialmente_aceitas: 'Nutricionistas (com atuação em POA); Biomédicos (com atuação laboratorial)' },
  { pos_graduacao: 'Sanidade Avícola', pode_fazer: 'Medicina Veterinária', parcialmente_aceitas: '—' },
  { pos_graduacao: 'Produção de Suínos', pode_fazer: 'Medicina Veterinária; Zootecnia; Engenharia Agronômica; Biologia', parcialmente_aceitas: 'Engenharia Ambiental' },
  { pos_graduacao: 'Saúde Única e Zoonoses', pode_fazer: 'Medicina Veterinária; Biomedicina; Enfermagem', parcialmente_aceitas: 'Farmácia' },
  { pos_graduacao: 'MBA Postura Comercial', pode_fazer: 'Qualquer formação de NÍVEL SUPERIOR completa pode fazer: bacharelado, licenciatura ou tecnólogo', parcialmente_aceitas: '—' },
];
const reprovado = (formacao: string, curso: string, extra: Record<string, unknown> = {}) => ({
  formacao_identificada: formacao, e_medico_veterinario: false, curso_solicitado: curso, curso_exclusivo_veterinario: false,
  pode_cursar: false, compativel: false, curso_alternativo: null, curso_alternativo_recomendado: false,
  mensagem_para_lead: 'Infelizmente sua formação não está entre as aceitas para este curso.',
  output: 'Infelizmente sua formação não está entre as aceitas para este curso.', ...extra,
});

describe('reprovado numa pós, aceito em outra: a ferramenta oferece em vez de encerrar', () => {
  it('caso Eliel: engenheiro de alimentos em Sanidade Avícola fica com Gestão e Produção Avícola, que o aceita', () => {
    const daMatriz = reprovado('Engenharia de Alimentos', 'Sanidade Avícola', {
      curso_exclusivo_veterinario: true, curso_alternativo: 'Gestão e Produção Avicola', curso_alternativo_recomendado: true,
    });
    expect(T.alternativasPelaTabela(daMatriz, TABELA)).toBe(daMatriz);
  });

  it('reprovado numa pós aberta, aceito em uma outra: vira alternativa, com a ordem de não encerrar', () => {
    const r = T.alternativasPelaTabela(reprovado('Biomedicina', 'Gestão e Produção Avícola'), TABELA);
    expect(r.pode_cursar).toBe(false);
    expect(r.curso_alternativo).toBe('Saúde Única e Zoonoses');
    expect(r.curso_alternativo_recomendado).toBe(true);
    expect(r.alternativa_por_formacao).toBe(true);
    expect(r.mensagem_para_lead).toBe('A pós em Gestão e Produção Avícola não aceita a formação em Biomedicina, mas a pós em Saúde Única e Zoonoses aceita. Quer conhecer?');
    expect(r.instrucao).toContain('NÃO encerre nem pause');
    expect(r.instrucao).toContain('guarde essa preferência');
    expect(r.instrucao).toContain('não diga que cobre os mesmos assuntos');
  });

  it('a alternativa do mapa fixo nunca é trocada: grafia diferente na tabela não a derruba', () => {
    // A tabela escreve "Engenharia Ambiental ou Produção Animal"; a matriz devolve "Engenharia Ambiental".
    // Conferir por nome idêntico trocava a avícola por Produção de Suínos (revisão de 12/10/2026).
    for (const formacao of ['Engenharia Ambiental', 'Zootecnia', 'Biomedicina', 'Direito']) {
      const daMatriz = reprovado(formacao, 'Sanidade Avícola', {
        curso_exclusivo_veterinario: true, curso_alternativo: 'Gestão e Produção Avicola', curso_alternativo_recomendado: true,
      });
      expect(T.alternativasPelaTabela(daMatriz, TABELA)).toBe(daMatriz);
    }
  });

  it('a tabela lista a formação na própria pós pedida: a matriz errou, a ferramenta não afirma "não aceita"', () => {
    const vet = reprovado('Medicina Veterinária', 'Produção de Suínos');
    expect(T.alternativasPelaTabela(vet, TABELA)).toBe(vet);
    const semCurso = reprovado('Zootecnia', null as unknown as string);
    expect(T.alternativasPelaTabela(semCurso, TABELA)).toBe(semCurso);
  });

  it('no máximo quatro pós na lista', () => {
    const muitas = [...TABELA, ...['A', 'B', 'C'].map((n) => ({ pos_graduacao: `Pós ${n}`, pode_fazer: 'Zootecnia', parcialmente_aceitas: '—' }))];
    expect(T.alternativasPelaTabela(reprovado('Zootecnia', 'Saúde Única e Zoonoses'), muitas).outras_pos_compativeis).toHaveLength(4);
  });

  it('várias pós aceitam: devolve a lista para o lead escolher, sem eleger uma', () => {
    const r = T.alternativasPelaTabela(reprovado('Zootecnia', 'Saúde Única e Zoonoses'), TABELA);
    expect(r.curso_alternativo).toBeNull();
    expect(r.curso_alternativo_recomendado).toBe(false);
    expect(r.outras_pos_compativeis).toEqual(['Gestão e Produção Avícola', 'Qualidade e Segurança de Alimentos de Origem Animal', 'Produção de Suínos']);
    expect(r.instrucao).toContain('pergunte qual destas faz mais sentido');
    expect(r.output).toContain('Pós que aceitam essa formação: Gestão e Produção Avícola; Qualidade e Segurança de Alimentos de Origem Animal; Produção de Suínos.');
  });

  it('parcialmente aceita só entra quando nenhuma pós aceita por inteiro', () => {
    const r = T.alternativasPelaTabela(reprovado('Farmácia', 'Gestão e Produção Avícola'), TABELA);
    expect(r.curso_alternativo).toBe('Saúde Única e Zoonoses');
    const inteira = T.alternativasPelaTabela(reprovado('Enfermagem', 'Gestão e Produção Avícola'), TABELA);
    expect(inteira.curso_alternativo).toBe('Saúde Única e Zoonoses');
  });

  it('formação que nenhuma pós de área lista continua sem alternativa (MBA não entra)', () => {
    const direito = reprovado('Direito', 'Gestão e Produção Avícola');
    const r = T.alternativasPelaTabela(direito, TABELA);
    expect(r).toBe(direito);
    expect(r.curso_alternativo).toBeNull();
  });

  it('só casa nome idêntico: "Nutrição" não vira "Nutricionistas (com atuação em POA)"', () => {
    const nutri = reprovado('Nutrição', 'Gestão e Produção Avícola');
    expect(T.alternativasPelaTabela(nutri, TABELA)).toBe(nutri);
  });

  it('acento e caixa não atrapalham; aprovado e resultado sem formação passam direto', () => {
    expect(T.alternativasPelaTabela(reprovado('BIOMEDICINA', 'gestao e producao avicola'), TABELA).curso_alternativo)
      .toBe('Saúde Única e Zoonoses');
    const aprovado = { ...reprovado('Zootecnia', 'Produção de Suínos'), pode_cursar: true, compativel: true, output: 'APROVADO' };
    expect(T.alternativasPelaTabela(aprovado, TABELA)).toBe(aprovado);
    const semFormacao = reprovado('', 'Gestão e Produção Avícola');
    expect(T.alternativasPelaTabela(semFormacao, TABELA)).toBe(semFormacao);
    expect(T.alternativasPelaTabela(reprovado('Zootecnia', 'Saúde Única e Zoonoses'), null)).toMatchObject({ curso_alternativo: null });
  });

  it('IA de aula (só fatos): traz a alternativa, sem ordem de condução', () => {
    const r = T.alternativasPelaTabela(reprovado('Biomedicina', 'Gestão e Produção Avícola'), TABELA, true);
    expect(r.curso_alternativo).toBe('Saúde Única e Zoonoses');
    expect(r.instrucao).toBeUndefined();
    expect(r.mensagem_para_lead).not.toContain('Quer conhecer');
    const varias = T.alternativasPelaTabela(reprovado('Zootecnia', 'Saúde Única e Zoonoses'), TABELA, true);
    expect(varias.outras_pos_compativeis).toHaveLength(3);
    expect(varias.instrucao).toBeUndefined();
  });
});
