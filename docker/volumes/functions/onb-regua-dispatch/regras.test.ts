import { describe, expect, it } from 'vitest';
import {
  componentsDoCorpo,
  ehFrequenciaDaMeta,
  estaNaListaDeTeste,
  formatoDoCabecalho,
  iguaisTempoConstante,
  limiteDaRodada,
  limparValorDeVariavel,
  mascararTelefone,
  modoEfetivo,
  MOTIVO,
  precisaDoCronograma,
  primeiraTrava,
  valoresParaEnvio,
  type Candidato,
  type ContextoTravas,
} from './regras';

// Um candidato como o onb_regua_candidatos devolve: D+9 (documentos), sem cabeçalho de mídia,
// uma variável, valores já resolvidos pelo banco.
function candidato(extra: Partial<Candidato> = {}): Candidato {
  return {
    oportunidade_id: 'opo-1',
    etapa_id: 'etapa-9',
    lead_id: 'lead-1',
    nome: 'Maria',
    nome_completo: 'MARIA DA SILVA SOUZA',
    telefone: '5546999321082',
    acao: 'enviar',
    dia: 9,
    template_nome: 'int_aluno_09_documentos',
    variaveis: ['nome'],
    valores: ['Maria'],
    curso: 'Clínica Médica e Cirúrgica de Bovinos',
    marca: 'PPGVet Educação',
    ...extra,
  };
}

function contexto(extra: Partial<ContextoTravas> = {}): ContextoTravas {
  return {
    modo: 'producao',
    telefonesTeste: ['+55 46 99932-1082'],
    aprovados: new Set(['int_aluno_09_documentos', 'int_aluno_01_boasvindas_cronograma']),
    telefoneEnvio: '5546999321082',
    jaEnviado: false,
    ...extra,
  };
}

describe('modo da rodada', () => {
  it('config vazia vale teste, que é como o motor nasce', () => {
    expect(modoEfetivo(null, null).modo).toBe('teste');
    expect(modoEfetivo('lixo', undefined).modo).toBe('teste');
  });
  it('o corpo do POST desce o modo, e descer é ensaio: não grava nem move', () => {
    expect(modoEfetivo('producao', 'simulacao')).toEqual({
      modo: 'simulacao', pedido: 'simulacao', rebaixado: false, ensaio: true,
    });
  });
  it('simulação da CONFIG grava, porque é o ensaio que o desenho pediu', () => {
    expect(modoEfetivo('simulacao', null).ensaio).toBe(false);
    expect(modoEfetivo('simulacao', 'simulacao').ensaio).toBe(false);
  });
  it('o corpo do POST NUNCA sobe o modo: curl não liga a produção', () => {
    expect(modoEfetivo('teste', 'producao')).toEqual({
      modo: 'teste', pedido: 'producao', rebaixado: true, ensaio: false,
    });
    expect(modoEfetivo('simulacao', 'teste').modo).toBe('simulacao');
  });
});

describe('telefone', () => {
  it('mascara guarda DDI, DDD e os dois últimos dígitos', () => {
    expect(mascararTelefone('5546999321082')).toBe('5546*******82');
    expect(mascararTelefone(null)).toBe('(sem telefone)');
  });
  it('a lista de teste casa com ou sem nono dígito, com ou sem máscara', () => {
    const lista = ['+55 (46) 99932-1082'];
    expect(estaNaListaDeTeste('5546999321082', lista)).toBe(true);
    expect(estaNaListaDeTeste('46999321082', lista)).toBe(true);
    expect(estaNaListaDeTeste('4699321082', lista)).toBe(true);
    expect(estaNaListaDeTeste('5511999990001', lista)).toBe(false);
  });
  it('lista vazia é régua parada, não régua solta', () => {
    expect(estaNaListaDeTeste('5546999321082', [])).toBe(false);
    expect(estaNaListaDeTeste('5546999321082', null)).toBe(false);
  });
});

describe('valores das variáveis', () => {
  it('quebra de linha some: a Meta recusa o disparo inteiro com \\n no parâmetro', () => {
    expect(limparValorDeVariavel('Clínica\nMédica  e   Cirúrgica')).toBe('Clínica Médica e Cirúrgica');
  });
  it('usa o que o banco resolveu, na ordem em que veio', () => {
    expect(valoresParaEnvio(['Maria', 'Bovinos'], ['nome', 'curso']))
      .toEqual({ ok: true, valores: ['Maria', 'Bovinos'] });
  });
  it('valor vazio para o passo em vez de mandar "Olá, !"', () => {
    expect(valoresParaEnvio(['Maria', '  '], ['nome', 'curso'])).toEqual({ ok: false, faltando: 'curso' });
    expect(valoresParaEnvio([null], ['nome'])).toEqual({ ok: false, faltando: 'nome' });
  });
  it('quantidade diferente da esperada também para o passo', () => {
    expect(valoresParaEnvio(['Maria'], ['nome', 'curso']).ok).toBe(false);
  });
  it('passo sem variável vai sem componente de corpo', () => {
    expect(valoresParaEnvio([], [])).toEqual({ ok: true, valores: [] });
    expect(componentsDoCorpo([])).toEqual([]);
    expect(componentsDoCorpo(['Maria'])).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'Maria' }] }]);
  });
});

describe('cabeçalho', () => {
  it('o cabeçalho do passo vira o formato da Meta', () => {
    expect(formatoDoCabecalho('documento')).toBe('DOCUMENT');
    expect(formatoDoCabecalho('video')).toBe('VIDEO');
    expect(formatoDoCabecalho('imagem')).toBe('IMAGE');
    expect(formatoDoCabecalho(null)).toBe(null);
  });
  it('documento é o D+1: o PDF do cronograma, gerado por aluno', () => {
    expect(precisaDoCronograma({ cabecalho: 'documento' })).toBe(true);
    expect(precisaDoCronograma({ cabecalho: 'video' })).toBe(false);
    expect(precisaDoCronograma({})).toBe(false);
  });
});

describe('travas, na ordem do desenho', () => {
  it('candidato inteiro passa', () => {
    expect(primeiraTrava(candidato(), contexto())).toBe(null);
  });
  it('passo que já saiu vence tudo: é a rede contra mandar duas vezes', () => {
    const t = primeiraTrava(candidato({ telefone: null }), contexto({ jaEnviado: true, modo: 'teste' }));
    expect(t?.motivo).toBe(MOTIVO.ja_enviado);
  });
  it('no modo teste, quem não está na lista para antes de tudo', () => {
    const cand = candidato({ telefone: '5511999990001' });
    expect(primeiraTrava(cand, contexto({ modo: 'teste', telefoneEnvio: '5511999990001' }))?.motivo)
      .toBe(MOTIVO.fora_do_teste);
  });
  it('no modo produção o mesmo número segue', () => {
    const cand = candidato({ telefone: '5511999990001' });
    expect(primeiraTrava(cand, contexto({ telefoneEnvio: '5511999990001' }))).toBe(null);
  });
  it('número impossível não queima template', () => {
    expect(primeiraTrava(candidato({ telefone: '5511987654' }), contexto({ telefoneEnvio: null }))?.motivo)
      .toBe(MOTIVO.sem_telefone);
  });
  it('passo sem modelo, ou com modelo ainda não aprovado na Meta, não sai', () => {
    expect(primeiraTrava(candidato({ template_nome: null }), contexto())?.motivo).toBe(MOTIVO.sem_modelo);
    expect(primeiraTrava(candidato({ template_nome: 'int_aluno_02_plataforma_texto' }), contexto())?.motivo)
      .toBe(MOTIVO.modelo_nao_aprovado);
  });
  it('Meta fora do ar não congela a régua: sem listagem, a trava de aprovação sai de cena', () => {
    const cand = candidato({ template_nome: 'int_aluno_02_plataforma_texto' });
    expect(primeiraTrava(cand, contexto({ aprovados: null }))).toBe(null);
  });
  it('cabeçalho de vídeo sem arquivo para o passo; o do D+1 não usa midia_url', () => {
    const semVideo = candidato({ dia: 2, cabecalho: 'video', midia_url: null });
    expect(primeiraTrava(semVideo, contexto())?.motivo).toBe(MOTIVO.sem_midia);
    const dPlus1 = candidato({
      dia: 1,
      cabecalho: 'documento',
      midia_url: null,
      template_nome: 'int_aluno_01_boasvindas_cronograma',
      variaveis: ['nome', 'curso'],
      valores: ['Maria', 'Clínica Médica e Cirúrgica de Bovinos'],
    });
    expect(primeiraTrava(dPlus1, contexto())).toBe(null);
  });
  it('variável que o aluno leria vazia para o passo', () => {
    const cand = candidato({ variaveis: ['nome', 'curso'], valores: ['Maria', ''] });
    expect(primeiraTrava(cand, contexto())).toEqual({ motivo: MOTIVO.sem_variavel, detalhe: 'curso' });
  });
  it('o alerta que o banco mandou junto é obedecido, que é o contrato da coluna', () => {
    expect(primeiraTrava(candidato({ alerta: 'sem_turma' }), contexto())?.motivo).toBe(MOTIVO.sem_turma);
    expect(primeiraTrava(candidato({ alerta: 'sem_cronograma' }), contexto())?.motivo)
      .toBe(MOTIVO.sem_cronograma);
    expect(primeiraTrava(candidato({ alerta: null }), contexto())).toBe(null);
  });
});

describe('recusa da Meta por frequência', () => {
  it('131049 e 131050 são passo adiado, não erro de envio', () => {
    expect(ehFrequenciaDaMeta('(#131049) This message was not delivered')).toBe(true);
    expect(ehFrequenciaDaMeta('(#131050) User stopped marketing messages')).toBe(true);
  });
  it('qualquer outro erro continua sendo erro', () => {
    expect(ehFrequenciaDaMeta('Message undeliverable (131026)')).toBe(false);
    expect(ehFrequenciaDaMeta(null)).toBe(false);
  });
});

describe('miudezas do endpoint', () => {
  it('sem limite no corpo, quem manda é o lote_max da config (null na RPC)', () => {
    expect(limiteDaRodada(undefined)).toBe(null);
    expect(limiteDaRodada(0)).toBe(null);
    expect(limiteDaRodada(5)).toBe(5);
    expect(limiteDaRodada(9999)).toBe(200);
  });
  it('comparação de chave é em tempo constante e continua correta', () => {
    expect(iguaisTempoConstante('chave', 'chave')).toBe(true);
    expect(iguaisTempoConstante('chave', 'chaves')).toBe(false);
    expect(iguaisTempoConstante('', 'chave')).toBe(false);
  });
});
