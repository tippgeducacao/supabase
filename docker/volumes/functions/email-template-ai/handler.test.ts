import { describe, expect, it, vi } from 'vitest';
import { criarHandlerEmailIA, lerCorpoEmailIA, MODELOS_EMAIL_IA, validarPedidoEmailIA, type DependenciasEmailIA } from './handler';
import { docVazio, type DocumentoEmail } from '../_shared/emailBuilder/types';
import { validarDocumentoIA, PROMPT_DOCUMENTO_IA } from '../_shared/emailBuilder/ai';
import { compilarDocumento } from '../_shared/emailBuilder/compile';
import { SCHEMA_RESULTADO_EMAIL_IA, schemaAjusteEmailIA } from '../_shared/emailBuilder/aiSchema';
import { validarRespostaEmailIA } from '../_shared/emailBuilder/aiEdicao';
import { SCHEMA_ASSUNTOS_EMAIL_IA, validarSugestoesAssuntoEmailIA } from '../_shared/emailBuilder/aiAssuntos';
import { kitMarcaEmailIAVazio } from '../_shared/emailBuilder/aiMarca';
import { validarRespostaProtegidaEmailIA } from '../_shared/emailBuilder/aiProtecoes';
import { compararFontesEmailIA, criarSnapshotFontesEmailIA, validarSnapshotFontesEmailIA } from '../_shared/emailBuilder/aiFontes';

const USUARIO = '11111111-1111-4111-8111-111111111111';
const AGENTE = '22222222-2222-4222-8222-222222222222';
const DOCUMENTO = { ...docVazio('Convite'), assunto: 'Convite para conhecer a PPGVET' };
const PEDIDO = { acao: 'gerar', agente_id: AGENTE, modelo_id: 'claude-sonnet-5', prompt: 'Faça um convite com título e botão.', referencias: '', imagens: [] };
const URL_PUBLICA = 'https://api.exemplo.test';
// Assinatura PNG suficiente para testar o limite de transporte; nenhum provedor
// real é chamado. O teste do documento completo vive no contrato compartilhado.
const PNG = btoa('\x89PNG\r\n\x1a\n' + 'conteudo-simulado');
const IMAGEM = { nome: 'Referência.png', mime: 'image/png', base64: PNG, uso: 'referencia' };
const validar = (valor: unknown): DocumentoEmail => {
  if (!valor || typeof valor !== 'object' || !Array.isArray((valor as DocumentoEmail).linhas)) throw new Error('Documento inválido');
  return valor as DocumentoEmail;
};
type Retorno = { data: unknown; error: { message: string } | null };
interface Opcoes {
  usuario?: { id: string; is_anonymous?: boolean } | null;
  cargo?: 'admin' | 'diretor' | 'nenhum';
  ativo?: boolean;
  erroPermissao?: boolean;
  erroCota?: boolean;
  permitido?: boolean;
  agenteAtivo?: boolean;
  providers?: readonly string[];
  statusProvedor?: number;
  resultado?: unknown;
  truncado?: boolean;
  contratoReal?: boolean;
  dados?: Record<string, Array<Record<string, unknown>>>;
  estadoCota?: unknown;
  erroConsultaCota?: boolean;
}
function cenario(opcoes: Opcoes = {}) {
  const eventos: string[] = [];
  const consultas: Array<{ tabela: string; colunas: string; filtros: Record<string, unknown> }> = [];
  let consumos = 0;
  const getUser = vi.fn(async () => {
    eventos.push('auth');
    return { data: { user: opcoes.usuario === undefined ? { id: USUARIO } : opcoes.usuario }, error: null };
  });
  const rpc = vi.fn(async (nome: string, args: Record<string, unknown>) => {
    eventos.push(nome);
    if (nome === 'has_role') return { data: args.role_name === (opcoes.cargo ?? 'admin'), error: opcoes.erroPermissao ? { message: 'falha privada' } : null };
    if (nome === 'email_template_ia_consumir_cota') {
      if (opcoes.permitido !== false && !opcoes.erroCota) consumos++;
      return { data: { permitido: opcoes.permitido ?? true, retry_after: 37 }, error: opcoes.erroCota ? { message: 'falha privada' } : null };
    }
    throw new Error('RPC inesperada');
  });
  const from = vi.fn((tabela: string) => {
    eventos.push(`tabela:${tabela}`);
    const consulta = { tabela, colunas: '', filtros: {} as Record<string, unknown> };
    let unico = false;
    consultas.push(consulta);
    const resultado = (): Retorno => {
      if (tabela === 'profiles') return { data: { ativo: opcoes.ativo ?? true }, error: null };
      if (tabela === 'email_template_ia_cotas') return { data: opcoes.estadoCota === undefined ? { usos_ultimo_minuto: Array.from({ length: consumos }, () => new Date().toISOString()), dia_utc: new Date().toISOString().slice(0, 10), usos_dia: consumos } : opcoes.estadoCota, error: opcoes.erroConsultaCota ? { message: 'falha privada' } : null };
      if (tabela === 'ai_agents') {
        const agente = { id: AGENTE, name: 'Diretor de Arte', description: 'Criação visual', system_prompt: 'PROMPT_PRIVADO' };
        return { data: consulta.colunas.includes('system_prompt') ? opcoes.agenteAtivo === false ? null : agente : [agente], error: null };
      }
      if (tabela === 'ai_api_keys') return { data: consulta.colunas === 'provider' ? (opcoes.providers ?? ['anthropic', 'google']).map(provider => ({ provider })) : (opcoes.providers ?? ['anthropic', 'google']).includes(String(consulta.filtros.provider)) ? { api_key: 'CHAVE_PRIVADA_SIMULADA' } : null, error: null };
      if (opcoes.dados?.[tabela]) {
        const itens = opcoes.dados[tabela].filter(item => Object.entries(consulta.filtros).every(([campo, valor]) => item[campo] === valor));
        return { data: unico ? itens[0] ?? null : itens, error: null };
      }
      throw new Error('Tabela inesperada');
    };
    const builder = {
      select: (colunas: string) => { consulta.colunas = colunas; return builder; },
      eq: (campo: string, valor: unknown) => { consulta.filtros[campo] = valor; return builder; },
      in: () => builder, order: () => builder, limit: () => builder, range: () => builder,
      maybeSingle: async () => { unico = true; return resultado(); },
      then: (resolve: (r: Retorno) => unknown) => Promise.resolve(resultado()).then(resolve),
    };
    return builder;
  });
  const buscar = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    eventos.push('provedor');
    if (opcoes.statusProvedor) return new Response('SEGREDO_DO_PROVEDOR', { status: opcoes.statusProvedor });
    const resultado = opcoes.resultado === undefined ? { documento: DOCUMENTO, resumo: 'Organizei o convite.' } : opcoes.resultado;
    return String(url).includes('googleapis')
      ? Response.json({ candidates: [{ finishReason: opcoes.truncado ? 'MAX_TOKENS' : 'STOP', content: { parts: [{ text: JSON.stringify(resultado) }] } }] })
      : Response.json({ stop_reason: opcoes.truncado ? 'max_tokens' : 'end_turn', content: [{ type: 'text', text: JSON.stringify(resultado) }] });
  });
  const cliente = { auth: { getUser }, rpc, from } as unknown as DependenciasEmailIA['cliente'];
  const handler = criarHandlerEmailIA({ cliente, buscar: buscar as typeof fetch, validarDocumento: opcoes.contratoReal ? validarDocumentoIA : validar, promptDocumento: opcoes.contratoReal ? PROMPT_DOCUMENTO_IA : 'CONTRATO_EDITAVEL', urlPublica: URL_PUBLICA });
  const chamar = (body: unknown = PEDIDO, token: string | null = 'sessao-validada', method = 'POST') => handler(new Request('https://edge.test/email-template-ai', {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }));
  return { chamar, buscar, eventos, consultas, rpc, getUser };
}

describe('controle de acesso e catálogo de templates IA', () => {
  it.each(['listar_ofertas', 'carregar_oferta', 'salvar_oferta', 'desativar_oferta', 'consultar_resultados', 'verificar_links'])(
    '%s exige conta explícita antes de consultar dados ou gastar cota', async acao => {
      const c = cenario();
      const resposta = await c.chamar({ acao });
      expect(resposta.status).toBe(409);
      expect(c.consultas.map(v => v.tabela)).toEqual(['profiles']);
      expect(c.rpc).not.toHaveBeenCalledWith('email_template_ia_consumir_cota', expect.anything());
      expect(c.buscar).not.toHaveBeenCalled();
    });
  it('oferta expirada interrompe geração antes da cota e do provedor', async () => {
    const c = cenario({ dados: {
      email_ia_ofertas: [{ id: AGENTE, curso_id: USUARIO, nome: 'Condições encerradas', preco_centavos: 150000,
        parcelas: null, valor_parcela_centavos: null, desconto_pontos_base: null, vagas_informadas: null,
        inicio_em: '2025-01-01T00:00:00Z', fim_em: '2025-02-01T00:00:00Z', url_destino: 'https://exemplo.test/curso',
        condicoes: 'Condições para matrícula à vista.', disponivel: true, revisao: 1, aprovada_por: USUARIO,
        aprovada_em: '2025-01-01T00:00:00Z', revogada_em: null }],
      comercial_cursos: [{ id: USUARIO, ativo: true }],
    } });
    const resposta = await c.chamar({ ...PEDIDO, contexto: { curso_id: USUARIO, oferta_id: AGENTE } });
    expect(resposta.status).toBe(409);
    expect(await resposta.json()).toMatchObject({ code: 'OFFER_NOT_CURRENT' });
    expect(c.rpc).not.toHaveBeenCalledWith('email_template_ia_consumir_cota', expect.anything());
    expect(c.buscar).not.toHaveBeenCalled();
  });
  it('aceita a conta capturada quando corresponde à sessão autenticada', async () => {
    const c = cenario();
    expect((await c.chamar({ ...PEDIDO, usuario_esperado: USUARIO })).status).toBe(200);
    expect(c.rpc).toHaveBeenCalledWith('email_template_ia_consumir_cota', { p_usuario_id: USUARIO });
  });
  it('recusa troca de conta antes de consultar dados, consumir cota ou chamar provedor', async () => {
    const c = cenario();
    const resposta = await c.chamar({ ...PEDIDO, usuario_esperado: AGENTE });
    expect(resposta.status).toBe(409);
    expect(await resposta.json()).toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect(c.consultas.map(v => v.tabela)).toEqual(['profiles']);
    expect(c.rpc).not.toHaveBeenCalledWith('email_template_ia_consumir_cota', expect.anything());
    expect(c.buscar).not.toHaveBeenCalled();
  });
  it('OPTIONS não autentica nem consulta dados', async () => {
    const c = cenario();
    expect((await c.chamar({}, null, 'OPTIONS')).status).toBe(200);
    expect(c.eventos).toEqual([]);
  });
  it.each(['GET', 'DELETE'])('recusa método %s', async method => {
    const c = cenario();
    expect((await c.chamar({}, null, method)).status).toBe(405);
    expect(c.eventos).toEqual([]);
  });
  it('recusa pedido sem sessão antes de consultar banco', async () => {
    const c = cenario();
    expect((await c.chamar(PEDIDO, null)).status).toBe(401);
    expect(c.eventos).toEqual([]);
  });
  it.each([null, { id: USUARIO, is_anonymous: true }])('recusa sessão inválida ou anônima', async usuario => {
    const c = cenario({ usuario });
    expect((await c.chamar()).status).toBe(401);
    expect(c.consultas).toEqual([]);
  });
  it.each([{ cargo: 'nenhum' as const }, { ativo: false }])('exige role de edição e perfil ativo', async opcoes => {
    const c = cenario(opcoes);
    expect((await c.chamar()).status).toBe(403);
    expect(c.consultas.map(v => v.tabela)).toEqual(['profiles']);
    expect(c.buscar).not.toHaveBeenCalled();
  });
  it('falha fechada quando não consegue consultar permissão', async () => {
    const c = cenario({ erroPermissao: true });
    expect((await c.chamar()).status).toBe(503);
    expect(c.buscar).not.toHaveBeenCalled();
  });
  it('lista agentes e só modelos com chave ativa, sem devolver prompt/chave', async () => {
    const c = cenario({ cargo: 'diretor', providers: ['google', 'tavily'] });
    const resposta = await c.chamar({ acao: 'listar_agentes' });
    const corpo = await resposta.json();
    expect(resposta.status).toBe(200);
    expect(corpo.agentes).toEqual([{ id: AGENTE, nome: 'Diretor de Arte', descricao: 'Criação visual' }]);
    expect(corpo.modelos).toEqual([MODELOS_EMAIL_IA[1]]);
    expect(corpo.geracao_imagem).toBe(true);
    expect(corpo.recursos).toEqual({ memoria_escrita: 1, conferencia_fontes: 1, ofertas: 0, resultados_campanhas: 0, verificar_links: 0 });
    expect(JSON.stringify(corpo)).not.toMatch(/PRIVAD/);
    expect(c.rpc).not.toHaveBeenCalledWith('email_template_ia_consumir_cota', expect.anything());
    expect(c.buscar).not.toHaveBeenCalled();
  });
  it('não aceita modelo arbitrário, agente inativo ou provedor sem chave', async () => {
    const c = cenario();
    expect((await c.chamar({ ...PEDIDO, modelo_id: 'modelo-caro-injetado' })).status).toBe(400);
    expect((await cenario({ agenteAtivo: false }).chamar()).status).toBe(403);
    expect((await cenario({ providers: [] }).chamar()).status).toBe(503);
    expect(c.buscar).not.toHaveBeenCalled();
  });
});

describe('geração estruturada sem ferramentas externas', () => {
  it('entrega documento validado pelo contrato real e compilável pelo editor', async () => {
    const documento = { versao: 1, nome: 'Convite', assunto: 'Seu próximo passo', globais: { fonte: 'Arial' }, linhas: [{ colunas: [{ larguraPct: 100, blocos: [
      { tipo: 'texto', props: { texto: 'Conheça nossa formação' }, estilo: { tamanhoFonte: 30, pesoFonte: 700 } },
      { tipo: 'botao', props: { texto: 'Conhecer', href: 'https://exemplo.test/curso' } },
    ] }] }] };
    const c = cenario({ contratoReal: true, resultado: { documento, resumo: 'Montei título e botão.' } });
    const resposta = await c.chamar({ ...PEDIDO, documento: docVazio() });
    expect(resposta.status).toBe(200);
    const proposta = await resposta.json();
    const compilado = compilarDocumento(proposta.documento);
    expect(compilado.html).toContain('Conheça nossa formação');
    expect(compilado.html).toContain('https://exemplo.test/curso');
    expect(proposta.documento.linhas[0].colunas[0].blocos[0].id).toBeTruthy();
  });
  it('o contrato real impede HTML bruto devolvido pelo provedor', async () => {
    const documento = { versao: 1, nome: 'Inválido', linhas: [{ colunas: [{ larguraPct: 100, blocos: [{ tipo: 'html', props: { html: '<script>alert(1)</script>' } }] }] }] };
    const resposta = await cenario({ contratoReal: true, resultado: { documento, resumo: 'Ataque' } }).chamar();
    expect(resposta.status).toBe(422);
    expect(await resposta.text()).not.toContain('<script>');
  });
  it.each([
    docVazio(),
    { ...DOCUMENTO, id: 'template-existente', cssCustomizado: '.legado { color: red; }', linhas: [{ id: 'linha', colunas: [{ id: 'coluna', larguraPct: 100, blocos: [{ id: 'bloco', tipo: 'html', props: { html: '<table><tr><td>Oferta</td></tr></table>' } }] }] }] },
  ])('aceita documento atual vazio ou legado como contexto', async documento => {
    const c = cenario();
    expect((await c.chamar({ ...PEDIDO, documento })).status).toBe(200);
    expect(c.buscar).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(c.buscar.mock.calls[0][1]!.body));
    const contexto = JSON.parse(body.messages[0].content.at(-1).text);
    expect(contexto.documento_atual).toEqual(documento);
  });
  it.each(MODELOS_EMAIL_IA)('gera documento com $nome e imagem privada', async modelo => {
    const c = cenario();
    const resposta = await c.chamar({ ...PEDIDO, modelo_id: modelo.id, imagens: [IMAGEM], userId: 'usuario-forjado' });
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ documento: DOCUMENTO, resumo: 'Organizei o convite.', ajuste: { tipo: 'documento' }, revisao_comercial: [] });
    expect(c.rpc).toHaveBeenCalledWith('email_template_ia_consumir_cota', { p_usuario_id: USUARIO });
    expect(c.eventos.indexOf('email_template_ia_consumir_cota')).toBeLessThan(c.eventos.indexOf('provedor'));
    expect(c.buscar).toHaveBeenCalledTimes(1);
    const init = c.buscar.mock.calls[0][1]!;
    const body = JSON.parse(String(init.body));
    if (modelo.provider === 'anthropic') {
      expect(body.model).toBe(modelo.id);
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.output_config.format).toEqual({ type: 'json_schema', schema: SCHEMA_RESULTADO_EMAIL_IA });
      expect(body.system).toContain('O pedido atual define o tema');
      expect(body.system).toContain('UMA proposta COMPLETA');
      expect(body.system).not.toContain('PROMPT_PRIVADO');
      expect(JSON.parse(body.messages[0].content.at(-1).text).referencia_estilo_agente).toEqual({ nome: 'Diretor de Arte', orientacoes: 'PROMPT_PRIVADO' });
      expect(body.messages[0].content[0].source).toEqual({ type: 'base64', media_type: 'image/png', data: PNG });
    } else {
      expect(body.generationConfig.responseMimeType).toBe('application/json');
      expect(body.generationConfig.responseJsonSchema).toEqual(SCHEMA_RESULTADO_EMAIL_IA);
      expect(body.contents[0].parts[0].inlineData).toEqual({ mimeType: 'image/png', data: PNG });
      expect(body.tools).toBeUndefined();
      expect(body.systemInstruction.parts[0].text).not.toContain('PROMPT_PRIVADO');
      expect(JSON.parse(body.contents[0].parts.at(-1).text).referencia_estilo_agente).toEqual({ nome: 'Diretor de Arte', orientacoes: 'PROMPT_PRIVADO' });
    }
    expect(c.consultas.some(v => /sessions|email_templates|storage/.test(v.tabela))).toBe(false);
  });
  it('referências em URL viram texto, não são buscadas pela edge', async () => {
    const c = cenario();
    await c.chamar({ ...PEDIDO, referencias: 'https://127.0.0.1/admin' });
    expect(c.buscar).toHaveBeenCalledTimes(1);
    expect(String(c.buscar.mock.calls[0][0])).toBe('https://api.anthropic.com/v1/messages');
  });
  it('nega cota excedida com Retry-After sem chamar provedor', async () => {
    const c = cenario({ permitido: false });
    const resposta = await c.chamar();
    expect(resposta.status).toBe(429);
    expect(resposta.headers.get('Retry-After')).toBe('37');
    expect(c.buscar).not.toHaveBeenCalled();
  });
  it('falha fechada quando o contador fica indisponível', async () => {
    const c = cenario({ erroCota: true });
    expect((await c.chamar()).status).toBe(503);
    expect(c.buscar).not.toHaveBeenCalled();
  });
  it.each([400, 429, 500])('não devolve detalhes privados de erro %s do provedor', async statusProvedor => {
    const c = cenario({ statusProvedor });
    const resposta = await c.chamar();
    expect(resposta.status).toBe(statusProvedor === 429 ? 429 : 422);
    expect(await resposta.text()).not.toMatch(/SEGREDO|CHAVE_PRIVADA/);
  });
  it.each([null, { documento: {}, resumo: 'Inválido' }, { documento: DOCUMENTO }, { documento: DOCUMENTO, resumo: '' }])('recusa saída sem documento ou resumo válido', async resultado => {
    expect((await cenario({ resultado }).chamar()).status).toBe(422);
  });
  it('registra o campo recusado sem revelar conteúdo, prompt ou credenciais', async () => {
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const c = cenario({ contratoReal: true, resultado: {
        resumo: 'Resumo privado', documento: { ...DOCUMENTO, linhas: [{ colunas: [{ blocos: [
          { tipo: 'texto', props: { texto: 'CONTEUDO_PRIVADO' }, estilo: { corTexto: 'VALOR_PRIVADO' } },
        ] }] }] },
      } });
      const resposta = await c.chamar();
      expect(resposta.status).toBe(422);
      expect(aviso).toHaveBeenCalledWith('[email-template-ai] proposta recusada', {
        modelo: 'claude-sonnet-5', codigo: 'INVALID_OUTPUT',
        campo: 'linhas[0].colunas[0].blocos[0].estilo.corTexto', motivo: 'texto excede 7 caracteres',
      });
      const saidas = JSON.stringify(aviso.mock.calls) + await resposta.text();
      expect(saidas).not.toMatch(/CONTEUDO_PRIVADO|VALOR_PRIVADO|PROMPT_PRIVADO|CHAVE_PRIVADA|Resumo privado/);
      expect(c.buscar).toHaveBeenCalledTimes(1);
    } finally { aviso.mockRestore(); }
  });
  it.each(MODELOS_EMAIL_IA)('aceita JSON serializado de $nome apenas após validação real', async modelo => {
    const documento = { ...DOCUMENTO, linhas: [{ colunas: [{ blocos: [
      { tipo: 'texto', props: { texto: 'Conheça nossas pós-graduações.' } },
    ] }] }] };
    const c = cenario({ contratoReal: true, resultado: { resumo: 'Convite', documento: JSON.stringify(documento) } });
    const resposta = await c.chamar({ ...PEDIDO, modelo_id: modelo.id });
    expect(resposta.status).toBe(200);
    const resultado = await resposta.json();
    expect(typeof resultado.documento).toBe('object');
    expect(compilarDocumento(resultado.documento).html).toContain('Conheça nossas pós-graduações.');
    expect(c.buscar).toHaveBeenCalledTimes(1);
  });
  it.each(MODELOS_EMAIL_IA)('recusa truncamento em $nome', async modelo => {
    expect((await cenario({ truncado: true }).chamar({ ...PEDIDO, modelo_id: modelo.id })).status).toBe(422);
  });
  it.each(MODELOS_EMAIL_IA)('recusa JSON nativo malformado de $nome sem repetir a chamada', async modelo => {
    const c = cenario();
    c.buscar.mockResolvedValue(Response.json(modelo.provider === 'anthropic'
      ? { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"documento":' }] }
      : { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"documento":' }] } }] }));
    const resposta = await c.chamar({ ...PEDIDO, modelo_id: modelo.id });
    expect(resposta.status).toBe(422);
    expect(await resposta.json()).toMatchObject({ code: 'INVALID_OUTPUT' });
    expect(c.buscar).toHaveBeenCalledTimes(1);
  });
  it('aguarda geração longa e cancela antes do timeout do aplicativo sem repetir consumo', async () => {
    vi.useFakeTimers();
    try {
      const c = cenario();
      c.buscar.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelado', 'AbortError')));
      }));
      let terminou = false;
      const pendente = c.chamar().then(r => { terminou = true; return r; });
      await vi.advanceTimersByTimeAsync(90_000);
      expect(terminou).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      const resposta = await pendente;
      expect(resposta.status).toBe(503);
      expect(await resposta.json()).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expect(c.buscar).toHaveBeenCalledTimes(1);
      expect(c.rpc.mock.calls.filter(([nome]) => nome === 'email_template_ia_consumir_cota')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});

describe('limites de entrada e imagens', () => {
  const deps = { validarDocumento: validar, urlPublica: URL_PUBLICA };
  it.each([
    { prompt: 'a'.repeat(6001) }, { referencias: 'a'.repeat(12001) }, { imagens: Array(5).fill(IMAGEM) },
    { imagens: [{ ...IMAGEM, mime: 'image/svg+xml' }] }, { imagens: [{ ...IMAGEM, base64: btoa('não é PNG') }] },
    { imagens: [{ ...IMAGEM, uso: 'conteudo' }] }, { imagens: [{ ...IMAGEM, uso: 'conteudo', url: 'https://malicioso.test/foto.png' }] },
    { imagens: [{ ...IMAGEM, uso: 'conteudo', url: `${URL_PUBLICA}/storage/v1/object/public/email-anexos/foto.png` }] },
    { imagens: [{ ...IMAGEM, uso: 'conteudo', url: `${URL_PUBLICA}/storage/v1/object/public/email-imagens/foto.png?token=x` }] },
    { documento: { ...DOCUMENTO, nome: 'a'.repeat(121 * 1024) } },
  ])('recusa payload fora do contrato', invalido => {
    expect(() => validarPedidoEmailIA({ ...PEDIDO, ...invalido }, deps)).toThrow();
  });
  it('preserva URL pública apenas em imagem de conteúdo', () => {
    const url = `${URL_PUBLICA}/storage/v1/object/public/email-imagens/foto.png`;
    const p = validarPedidoEmailIA({ ...PEDIDO, imagens: [{ ...IMAGEM, uso: 'conteudo', url }, { ...IMAGEM, url }] }, deps);
    expect(p.imagens[0].url).toBe(url);
    expect(p.imagens[1].url).toBeUndefined();
  });
  it('limita a soma de anexos e imagens da biblioteca a quatro', () => {
    const biblioteca = ['marketing:33333333-3333-4333-8333-333333333333', 'marketing:44444444-4444-4444-8444-444444444444'];
    expect(() => validarPedidoEmailIA({ ...PEDIDO, imagens: [IMAGEM, IMAGEM], imagens_biblioteca_ids: biblioteca }, deps)).not.toThrow();
    expect(() => validarPedidoEmailIA({ ...PEDIDO, imagens: [IMAGEM, IMAGEM, IMAGEM], imagens_biblioteca_ids: biblioteca }, deps)).toThrow('quatro imagens no total');
  });
  it('aceita data URL com o MIME correspondente', () => {
    const p = validarPedidoEmailIA({ ...PEDIDO, imagens: [{ ...IMAGEM, base64: `data:image/png;base64,${PNG}` }] }, deps);
    expect(p.imagens[0].base64).toBe(PNG);
  });
  it('limita cada imagem e o total pelos bytes decodificados', () => {
    const imagemGrande = { ...IMAGEM, base64: btoa('\x89PNG\r\n\x1a\n' + 'x'.repeat(1024 * 1024)) };
    expect(() => validarPedidoEmailIA({ ...PEDIDO, imagens: [imagemGrande] }, deps)).toThrow();
    const imagem800k = { ...IMAGEM, base64: btoa('\x89PNG\r\n\x1a\n' + 'x'.repeat(800 * 1024)) };
    expect(() => validarPedidoEmailIA({ ...PEDIDO, imagens: Array(4).fill(imagem800k) }, deps)).toThrow();
  });
  it('limita body real mesmo quando Content-Length não existe', async () => {
    const req = new Request('https://edge.test', { method: 'POST', body: 'x'.repeat(6 * 1024 * 1024 + 1) });
    await expect(lerCorpoEmailIA(req)).rejects.toMatchObject({ status: 413 });
  });
  it('recusa JSON inválido e arrays na raiz', async () => {
    for (const body of ['{', '[]']) await expect(lerCorpoEmailIA(new Request('https://edge.test', { method: 'POST', body }))).rejects.toMatchObject({ status: 400 });
  });
});

describe('imagens da proposta precisam ter sido fornecidas', () => {
  const documentoCom = (tipo: string, props: Record<string, unknown>) => ({
    ...DOCUMENTO,
    linhas: [{ id: 'linha', colunas: [{ id: 'coluna', larguraPct: 100, blocos: [{ id: 'bloco', tipo, props }] }] }],
  });
  const gerarImagem = async (url: string, contexto: Record<string, unknown> = {}) => {
    const c = cenario({ contratoReal: true, resultado: { resumo: 'Adicionei a imagem.', documento: documentoCom('imagem', { src: url, alt: 'Formação' }) } });
    return { c, resposta: await c.chamar({ ...PEDIDO, ...contexto }) };
  };
  it('bloqueia imagem inventada antes de devolver o documento', async () => {
    const { resposta } = await gerarImagem('https://inventado.test/coletar?dado=REFERENCIA_PRIVADA');
    expect(resposta.status).toBe(422);
    const body = await resposta.json();
    expect(body.code).toBe('IMAGE_NOT_PROVIDED');
    expect(body.documento).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('REFERENCIA_PRIVADA');
  });
  it('permite imagem enviada para uso no conteúdo', async () => {
    const url = `${URL_PUBLICA}/storage/v1/object/public/email-imagens/hero.png`;
    const { resposta } = await gerarImagem(url, { imagens: [{ ...IMAGEM, uso: 'conteudo', url }] });
    expect(resposta.status).toBe(200);
  });
  it('preserva imagem nativa do documento atual sem novo upload', async () => {
    const url = 'https://cdn.exemplo.test/hero.png';
    const { resposta } = await gerarImagem(url, { documento: documentoCom('imagem-link', { src: url, href: 'https://exemplo.test/curso', alt: 'Formação' }) });
    expect(resposta.status).toBe(200);
  });
  it.each([
    ['html', '<img src="https://cdn.exemplo.test/hero.png?a=1&amp;b=2" alt="Teste">'],
    ['texto-composto', "<IMG class='hero' SRC='https://cdn.exemplo.test/hero.png?a=1&#38;b=2'>"],
    ['html-dinamico', '<img src=https://cdn.exemplo.test/hero.png?a=1&#x26;b=2>'],
  ])('preserva img[src] do bloco legado %s', async (tipo, html) => {
    const { c, resposta } = await gerarImagem('https://cdn.exemplo.test/hero.png?a=1&b=2', { documento: documentoCom(tipo, { html }) });
    expect(resposta.status).toBe(200);
    expect(c.buscar).toHaveBeenCalledTimes(1);
    expect(String(c.buscar.mock.calls[0][0])).toBe('https://api.anthropic.com/v1/messages');
  });
  it('URL citada na referência ou em link de texto não autoriza nova imagem', async () => {
    const url = 'https://cdn.exemplo.test/hero.png';
    const { resposta } = await gerarImagem(url, {
      referencias: `Use como referência ${url}`,
      documento: documentoCom('link', { texto: 'Site', href: url }),
      imagens: [{ ...IMAGEM, uso: 'referencia', url }],
    });
    expect(resposta.status).toBe(422);
  });
  it('não confunde data-src com imagem incorporada no HTML legado', async () => {
    const { resposta } = await gerarImagem('https://cdn.exemplo.test/inventada.png', { documento: documentoCom('html', { html: '<img data-src="https://cdn.exemplo.test/inventada.png" src="https://cdn.exemplo.test/original.png">' }) });
    expect(resposta.status).toBe(422);
  });
  it('valida também miniaturas de vídeo', async () => {
    const url = 'https://cdn.exemplo.test/aula.jpg';
    const documento = documentoCom('video', { thumbnail: url, href: 'https://exemplo.test/aula', alt: 'Aula' });
    const c = cenario({ contratoReal: true, resultado: { resumo: 'Organizei o vídeo.', documento } });
    expect((await c.chamar()).status).toBe(422);
    expect((await c.chamar({ ...PEDIDO, documento })).status).toBe(200);
  });
});

describe('ajuste localizado e revisão comercial no endpoint', () => {
  const atual: DocumentoEmail = { ...DOCUMENTO, cssCustomizado: '.aviso{color:#444}', linhas: [
    { id: 'abertura', colunas: [{ id: 'coluna-abertura', larguraPct: 100, blocos: [
      { id: 'titulo', tipo: 'texto', props: { texto: 'Título original' } },
      { id: 'legado', tipo: 'html', props: { html: '<p>Conteúdo preservado</p>' } },
    ] }] },
    { id: 'rodape', colunas: [{ id: 'coluna-rodape', larguraPct: 100, blocos: [{ id: 'descadastro', tipo: 'link', props: { texto: 'Descadastrar', href: '{{descadastro_url}}' } }] }] },
  ] };
  const bloco = { tipo: 'texto', props: { texto: 'Título ajustado' }, estilo: {}, estiloMobile: {} };
  it.each(MODELOS_EMAIL_IA)('recebe somente bloco de $nome e conserva o restante também no front', async modelo => {
    const c = cenario({ contratoReal: true, resultado: { resumo: 'Ajustei o título', bloco } });
    const resposta = await c.chamar({ ...PEDIDO, modelo_id: modelo.id, documento: atual, direcao_visual: 'evento', ajuste: { tipo: 'bloco', alvo_id: 'titulo' } });
    expect(resposta.status).toBe(200);
    const resultado = await resposta.json();
    expect(resultado.documento.linhas[0].colunas[0].blocos[0].id).toBe('titulo');
    expect(resultado.documento.linhas[0].colunas[0].blocos[1]).toEqual(atual.linhas[0].colunas[0].blocos[1]);
    expect(resultado.documento.linhas[1]).toEqual(atual.linhas[1]);
    expect(resultado.documento.cssCustomizado).toBe(atual.cssCustomizado);
    expect(validarRespostaEmailIA(resultado, atual).documento).toEqual(resultado.documento);
    const body = JSON.parse(String(c.buscar.mock.calls[0][1]!.body));
    const schema = modelo.provider === 'anthropic' ? body.output_config.format.schema : body.generationConfig.responseJsonSchema;
    expect(schema).toEqual(schemaAjusteEmailIA('bloco'));
    const sistema = modelo.provider === 'anthropic' ? body.system : body.systemInstruction.parts[0].text;
    expect(sistema).toContain('AJUSTE LOCALIZADO');
    expect(sistema).not.toContain('Base de convite:');
    expect(c.buscar).toHaveBeenCalledTimes(1);
  });
  it('recusa documento completo ou campos adicionais durante ajuste parcial', async () => {
    const c = cenario({ contratoReal: true, resultado: { resumo: 'Mudei tudo', bloco, documento: atual } });
    const resposta = await c.chamar({ ...PEDIDO, documento: atual, ajuste: { tipo: 'bloco', alvo_id: 'titulo' } });
    expect(resposta.status).toBe(422);
    expect(await resposta.json()).toMatchObject({ code: 'INVALID_OUTPUT' });
  });
  it('recusa alvos inexistentes e cores com alvo antes de consumir cota', async () => {
    const c = cenario();
    for (const ajuste of [{ tipo: 'bloco', alvo_id: 'inexistente' }, { tipo: 'cores', alvo_id: 'titulo' }]) {
      expect((await c.chamar({ ...PEDIDO, documento: atual, ajuste })).status).toBe(400);
    }
    expect(c.rpc).not.toHaveBeenCalledWith('email_template_ia_consumir_cota', expect.anything());
    expect(c.buscar).not.toHaveBeenCalled();
  });
  it('aplica direção segura apenas na geração do documento inteiro', async () => {
    const c = cenario();
    expect((await c.chamar({ ...PEDIDO, direcao_visual: 'ultima_chamada' })).status).toBe(200);
    const body = JSON.parse(String(c.buscar.mock.calls[0][1]!.body));
    expect(body.system).toContain('não invente urgência');
    expect(JSON.parse(body.messages[0].content.at(-1).text).direcao_visual).toBe('ultima_chamada');
  });
  it('retorna revisão de valores ausentes sem nova chamada de IA', async () => {
    const c = cenario({ contratoReal: true, resultado: { resumo: 'Ajustei a oferta', bloco: { ...bloco, props: { texto: 'Investimento de R$ 900,00 até 30/09/2026.' } } } });
    const resposta = await c.chamar({ ...PEDIDO, documento: atual, ajuste: { tipo: 'bloco', alvo_id: 'titulo' } });
    expect(resposta.status).toBe(200);
    expect((await resposta.json()).revisao_comercial.map((a: { tipo: string }) => a.tipo)).toEqual(['preco', 'prazo']);
    expect(c.buscar).toHaveBeenCalledTimes(1);
  });
  it('uma segunda rodada não confirma o preço inventado na proposta anterior', async () => {
    const anterior = structuredClone(atual);
    anterior.linhas[0].colunas[0].blocos[0].props.texto = 'Investimento de R$ 900,00 até 30/09/2026.';
    const c = cenario({ contratoReal: true, resultado: { resumo: 'Ajustei o tamanho do título', bloco: { ...bloco, props: { texto: anterior.linhas[0].colunas[0].blocos[0].props.texto } } } });
    const resposta = await c.chamar({ ...PEDIDO, documento: anterior, ajuste: { tipo: 'bloco', alvo_id: 'titulo' } });
    expect(resposta.status).toBe(200);
    expect((await resposta.json()).revisao_comercial.map((a: { tipo: string }) => a.tipo)).toEqual(['preco', 'prazo']);
  });
});

describe('gerar imagem exige escolha explícita, sessão e a mesma cota', () => {
  const pngReal = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKeUAAAAASUVORK5CYII=';
  it('gera uma imagem privada e consome a RPC global com o usuário da sessão', async () => {
    const c = cenario();
    c.buscar.mockResolvedValue(Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngReal } }] } }] }));
    const resposta = await c.chamar({ acao: 'gerar_imagem', prompt: 'Banner de veterinária', usuarioId: 'FORJADO', url: 'https://forjada.test', modelo: 'forjado' });
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ imagem: { mime: 'image/png', base64: pngReal, uso: 'referencia' }, cota: { restante_minuto: 4, restante_dia: 49 } });
    expect(c.rpc).toHaveBeenCalledWith('email_template_ia_consumir_cota', { p_usuario_id: USUARIO });
    expect(c.buscar).toHaveBeenCalledTimes(1);
    expect(c.buscar.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent');
    expect(c.consultas.some(consulta => /storage|generations|templates/.test(consulta.tabela))).toBe(false);
  });
  it.each([
    [{ cargo: 'nenhum' as const }, 403], [{ permitido: false }, 429], [{ erroCota: true }, 503], [{ providers: ['anthropic'] }, 503],
  ] as const)('recusa antes do provedor quando acesso, configuração ou cota impedem', async (opcoes, status) => {
    const c = cenario({ ...opcoes, ...('providers' in opcoes ? { providers: [...opcoes.providers] } : {}) });
    const resposta = await c.chamar({ acao: 'gerar_imagem', prompt: 'Banner' });
    expect(resposta.status).toBe(status);
    expect(c.buscar).not.toHaveBeenCalled();
    if (status === 429) expect(resposta.headers.get('Retry-After')).toBe('37');
  });
  it('recusa descrição vazia ou longa sem consumir cota', async () => {
    const c = cenario();
    for (const prompt of ['', 'a'.repeat(2001)]) expect((await c.chamar({ acao: 'gerar_imagem', prompt })).status).toBe(400);
    expect(c.rpc).not.toHaveBeenCalledWith('email_template_ia_consumir_cota', expect.anything());
  });
});

describe('contexto real e biblioteca no endpoint autenticado', () => {
  const cursoId = '33333333-3333-4333-8333-333333333333';
  const arteId = '44444444-4444-4444-8444-444444444444';
  const urlArte = 'https://cdn.exemplo.test/arte-aprovada.png';
  const dados = {
    comercial_cursos: [{ id: cursoId, nome: 'Formação cadastrada', resumo_curto: 'Resumo vindo do catálogo', ativo: true }],
    comercial_curso_playbook: [{ curso_id: cursoId, ativo: true, publico_alvo: 'Médicos-veterinários' }],
    comercial_curso_links: [{ curso_id: cursoId, ativo: true, titulo: 'Inscrição oficial', tipo: 'inscricao', url: 'https://ppg.test/inscricao' }],
    ai_content_pipeline: [{ id: arteId, user_id: USUARIO, status: 'approved', title: 'Banner aprovado', generated_image_url: urlArte }],
  };
  it('consulta dados selecionados e os envia ao modelo sem ferramentas nem contatos', async () => {
    const c = cenario({ dados });
    const resposta = await c.chamar({ ...PEDIDO, contexto: { curso_id: cursoId } });
    expect(resposta.status).toBe(200);
    const body = JSON.parse(String(c.buscar.mock.calls[0][1]!.body));
    const contexto = JSON.parse(body.messages[0].content.at(-1).text).contexto_real;
    expect(contexto.texto).toContain('Resumo vindo do catálogo');
    expect(contexto.texto).toContain('https://ppg.test/inscricao');
    expect(contexto.texto).toContain('Preço, vagas, desconto e prazo de matrícula não foram confirmados');
    expect(c.consultas.some(consulta => /contatos|leads|destinatarios/.test(consulta.tabela))).toBe(false);
    expect(c.buscar).toHaveBeenCalledTimes(1);
  });
  it('autoriza uma arte escolhida somente a partir do registro aprovado do usuário', async () => {
    const documento = { ...DOCUMENTO, linhas: [{ colunas: [{ blocos: [{ tipo: 'imagem', props: { src: urlArte, alt: 'Banner' } }] }] }] };
    const c = cenario({ dados, contratoReal: true, resultado: { documento, resumo: 'Usei a arte aprovada.' } });
    const resposta = await c.chamar({ ...PEDIDO, imagens_biblioteca_ids: [`marketing:${arteId}`] });
    expect(resposta.status).toBe(200);
    expect(c.consultas.find(consulta => consulta.tabela === 'ai_content_pipeline')?.filtros).toEqual({ id: arteId, user_id: USUARIO, status: 'approved' });
    const body = JSON.parse(String(c.buscar.mock.calls[0][1]!.body));
    expect(JSON.parse(body.messages[0].content.at(-1).text).imagens_biblioteca[0].url).toBe(urlArte);
  });
  it('não consulta dados nem biblioteca quando a sessão não pode editar templates', async () => {
    const c = cenario({ dados, cargo: 'nenhum' });
    for (const acao of ['listar_contextos', 'carregar_contexto', 'listar_imagens']) expect((await c.chamar({ acao, contexto: { curso_id: cursoId } })).status).toBe(403);
    expect(c.consultas.every(consulta => consulta.tabela === 'profiles')).toBe(true);
  });
});

describe('registro e conferência das fontes efetivamente usadas', () => {
  const cursoId = '33333333-3333-4333-8333-333333333333';
  const dadosCurso = () => ({
    comercial_cursos: [{ id: cursoId, nome: 'Formação cadastrada', resumo_curto: 'Resumo inicial', ativo: true }],
    comercial_curso_playbook: [{ curso_id: cursoId, ativo: true, publico_alvo: 'Médicos-veterinários' }],
    comercial_curso_links: [{ curso_id: cursoId, ativo: true, titulo: 'Inscrição', tipo: 'inscricao', url: 'https://ppg.test/inscricao' }],
  });
  it('confere os dados atuais sem consultar chaves, consumir cota ou chamar IA', async () => {
    const dados = dadosCurso(); const c = cenario({ dados });
    const carregado = await (await c.chamar({ acao: 'carregar_contexto', contexto: { curso_id: cursoId }, usuario_esperado: USUARIO })).json();
    const anterior = validarSnapshotFontesEmailIA(carregado.contexto.snapshot_fontes);
    const conferir = () => c.chamar({ acao: 'conferir_fontes', snapshot_fontes: anterior, usuario_esperado: USUARIO });
    expect((await (await conferir()).json()).comparacao).toEqual({ estado: 'sem_alteracoes', alteracoes: [] });
    dados.comercial_cursos[0].resumo_curto = 'Resumo atualizado por outra pessoa';
    const resposta = await conferir(); expect(resposta.status).toBe(200);
    const atual = await resposta.json();
    expect(atual.comparacao).toEqual(compararFontesEmailIA(anterior, atual.snapshot_fontes));
    expect(atual.comparacao.alteracoes[0].campos).toContainEqual({ campo: 'Resumo', anterior: 'Resumo inicial', atual: 'Resumo atualizado por outra pessoa' });
    expect(c.consultas.some(v => /ai_agents|ai_api_keys|email_template_ia_cotas|contatos|destinatarios/.test(v.tabela))).toBe(false);
    expect(c.rpc).not.toHaveBeenCalledWith('email_template_ia_consumir_cota', expect.anything());
    expect(c.buscar).not.toHaveBeenCalled();
  });
  it('informa curso removido como indisponível sem invalidar o registro anterior', async () => {
    const dados = dadosCurso(); const c = cenario({ dados });
    const carregado = await (await c.chamar({ acao: 'carregar_contexto', contexto: { curso_id: cursoId } })).json();
    const anterior = structuredClone(carregado.contexto.snapshot_fontes);
    dados.comercial_cursos[0].ativo = false;
    const resposta = await c.chamar({ acao: 'conferir_fontes', snapshot_fontes: anterior, usuario_esperado: USUARIO });
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ comparacao: { estado: 'indisponivel', alteracoes: expect.arrayContaining([expect.objectContaining({ tipo: 'curso', situacao: 'indisponivel' })]) } });
    expect(anterior).toEqual(carregado.contexto.snapshot_fontes);
    expect((await c.chamar({ ...PEDIDO, contexto: { curso_id: cursoId } })).status).toBe(400);
    expect(c.rpc).not.toHaveBeenCalledWith('email_template_ia_consumir_cota', expect.anything());
    expect(c.buscar).not.toHaveBeenCalled();
  });
  it('usa uma leitura nova na geração e conserva exatamente o contexto daquela chamada', async () => {
    const dados = dadosCurso(); const c = cenario({ dados });
    const carregado = await (await c.chamar({ acao: 'carregar_contexto', contexto: { curso_id: cursoId } })).json();
    dados.comercial_cursos[0].resumo_curto = 'Conteúdo que foi enviado ao modelo';
    c.buscar.mockImplementationOnce(async () => {
      dados.comercial_cursos[0].resumo_curto = 'Mudou enquanto a IA respondia';
      return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ documento: DOCUMENTO, resumo: 'Convite revisado' }) }] });
    });
    const resposta = await c.chamar({ ...PEDIDO, contexto: { curso_id: cursoId }, snapshot_fontes: carregado.contexto.snapshot_fontes,
      documento: { ...DOCUMENTO, fontesIA: { instrucao: 'FATO_FORJADO'.repeat(13000) } } });
    expect(resposta.status).toBe(200);
    const resultado = await resposta.json(); const snapshot = validarSnapshotFontesEmailIA(resultado.snapshot_fontes);
    const body = JSON.parse(String(c.buscar.mock.calls[0][1]!.body));
    const entrada = JSON.parse(body.messages[0].content.at(-1).text);
    expect(entrada.documento_atual).not.toHaveProperty('fontesIA');
    expect(entrada.contexto_real).not.toHaveProperty('snapshot_fontes');
    expect(entrada.contexto_real.texto).toContain('Conteúdo que foi enviado ao modelo');
    expect(entrada.contexto_real.texto).not.toMatch(/FATO_FORJADO|Mudou enquanto/);
    expect(snapshot.fontes.find(f => f.tipo === 'curso')?.campos.Resumo).toBe('Conteúdo que foi enviado ao modelo');
    for (const fonte of snapshot.fontes) for (const [campo, valor] of Object.entries(fonte.campos)) expect(entrada.contexto_real.texto).toContain(`${campo}: ${valor}`);
    expect(compararFontesEmailIA(carregado.contexto.snapshot_fontes, snapshot).estado).toBe('alterado');
    expect(c.consultas.filter(v => v.tabela === 'comercial_cursos')).toHaveLength(2);
  });
  it('mantém autenticação, autorização e conta esperada antes de consultar fontes', async () => {
    const snapshot_fontes = await criarSnapshotFontesEmailIA({}, []);
    const pedido = { acao: 'conferir_fontes', snapshot_fontes, usuario_esperado: USUARIO };
    const semSessao = cenario(); expect((await semSessao.chamar(pedido, null)).status).toBe(401);
    expect(semSessao.consultas).toEqual([]);
    const semCargo = cenario({ cargo: 'nenhum' }); expect((await semCargo.chamar(pedido)).status).toBe(403);
    const outraConta = cenario(); expect((await outraConta.chamar({ ...pedido, usuario_esperado: AGENTE })).status).toBe(409);
    for (const c of [semCargo, outraConta]) {
      expect(c.consultas.map(v => v.tabela)).toEqual(['profiles']);
      expect(c.buscar).not.toHaveBeenCalled();
      expect(c.rpc).not.toHaveBeenCalledWith('email_template_ia_consumir_cota', expect.anything());
    }
  });
  it('recusa snapshot inválido antes dos dados e não apresenta vazio como conferido', async () => {
    const c = cenario();
    expect((await c.chamar({ acao: 'conferir_fontes', snapshot_fontes: { versao: 1 }, usuario_esperado: USUARIO })).status).toBe(400);
    expect(c.consultas.map(v => v.tabela)).toEqual(['profiles']);
    const snapshot_fontes = await criarSnapshotFontesEmailIA({}, []);
    const resposta = await c.chamar({ acao: 'conferir_fontes', snapshot_fontes, usuario_esperado: USUARIO });
    expect(await resposta.json()).toMatchObject({ comparacao: { estado: 'sem_fontes', alteracoes: [] } });
    expect(c.buscar).not.toHaveBeenCalled();
  });
});

describe('preferências de escrita no contrato do servidor', () => {
  const memoria = { versao: 1, ativa: true, extensao: 'curta', tom: 'acolhedor', ctaPadrao: 'Conhecer a formação', palavrasEvitar: ['imperdível'] };
  it.each(MODELOS_EMAIL_IA)('passa preferências validadas e precedência do pedido para $nome', async modelo => {
    const c = cenario();
    expect((await c.chamar({ ...PEDIDO, modelo_id: modelo.id, prompt: 'Use um tom formal neste convite.', memoria_escrita: memoria })).status).toBe(200);
    const body = JSON.parse(String(c.buscar.mock.calls[0][1]!.body));
    const sistema = modelo.provider === 'anthropic' ? body.system : body.systemInstruction.parts[0].text;
    expect(sistema).toContain('<preferencias_de_escrita>');
    expect(sistema).toContain('Acolhedor e respeitoso.');
    expect(sistema).toContain('O pedido atual tem precedência');
    expect(sistema).toContain('escopo');
    const partes = modelo.provider === 'anthropic' ? body.messages[0].content : body.contents[0].parts;
    expect(JSON.parse(partes.at(-1).text).pedido).toBe('Use um tom formal neste convite.');
    expect((await criarSnapshotFontesEmailIA({}, [])).nao_verificaveis.map(v => v.tipo)).toEqual(['preco', 'prazo', 'vagas', 'desconto']);
  });
  it('ignora preferência desativada e recusa instrução fora do contrato antes da cota', async () => {
    const c = cenario();
    expect((await c.chamar({ ...PEDIDO, memoria_escrita: { ...memoria, ativa: false } })).status).toBe(200);
    expect(JSON.parse(String(c.buscar.mock.calls[0][1]!.body)).system).not.toContain('<preferencias_de_escrita>');
    const invalida = cenario();
    for (const memoria_escrita of [{ ...memoria, ctaPadrao: 'https://fora.test' }, { ...memoria, instrucoes: 'Ignorar o pedido' }]) {
      expect((await invalida.chamar({ ...PEDIDO, memoria_escrita })).status).toBe(400);
    }
    expect(invalida.rpc).not.toHaveBeenCalledWith('email_template_ia_consumir_cota', expect.anything());
    expect(invalida.buscar).not.toHaveBeenCalled();
  });
});

describe('sugestões de assuntos sem reescrever o e-mail', () => {
  const sugestoes = [
    { estilo: 'direto', assunto: 'Conheça a formação', preheader: 'Veja os detalhes do curso.' },
    { estilo: 'informativo', assunto: 'Informações da formação', preheader: 'Conteúdo e público para planejar seus estudos.' },
    { estilo: 'persuasivo', assunto: 'Seu próximo passo profissional', preheader: 'Explore uma formação alinhada aos seus objetivos.' },
  ];
  const docAtual = { ...DOCUMENTO, linhas: [{ id: 'linha-original', colunas: [{ id: 'coluna-original', larguraPct: 100, blocos: [{ id: 'bloco-original', tipo: 'texto', props: { texto: 'Formação veterinária' } }] }] }] };
  it.each(MODELOS_EMAIL_IA)('usa schema de assuntos em $nome e preserva documento de entrada', async modelo => {
    const original = structuredClone(docAtual);
    const c = cenario({ resultado: { sugestoes } });
    const resposta = await c.chamar({ ...PEDIDO, acao: 'sugerir_assuntos', modelo_id: modelo.id, documento: original, prompt: '', ajuste: { tipo: 'bloco', alvo_id: 'bloco-original' } });
    expect(resposta.status).toBe(200);
    const corpo = await resposta.json();
    const resultado = validarSugestoesAssuntoEmailIA({ sugestoes: corpo.sugestoes });
    expect(corpo.cota).toMatchObject({ restante_minuto: 4, restante_dia: 49 });
    expect(validarSnapshotFontesEmailIA(corpo.snapshot_fontes).fontes).toEqual([]);
    expect(resultado.sugestoes).toHaveLength(3);
    expect(resultado).not.toHaveProperty('documento');
    expect(original).toEqual(docAtual);
    const body = JSON.parse(String(c.buscar.mock.calls[0][1]!.body));
    const schema = modelo.provider === 'anthropic' ? body.output_config.format.schema : body.generationConfig.responseJsonSchema;
    expect(schema).toEqual(SCHEMA_ASSUNTOS_EMAIL_IA);
    const sistema = modelo.provider === 'anthropic' ? body.system : body.systemInstruction.parts[0].text;
    expect(sistema).toContain('Não retorne nem reescreva o documento');
    expect(sistema).not.toContain('PROMPT_PRIVADO');
    expect(c.buscar).toHaveBeenCalledTimes(1);
    expect(c.consultas.some(consulta => /email_templates|storage|sessions/.test(consulta.tabela))).toBe(false);
    expect(c.rpc).toHaveBeenCalledWith('email_template_ia_consumir_cota', { p_usuario_id: USUARIO });
  });
  it('não gera com pedido vazio sem conteúdo de apoio', async () => {
    const c = cenario({ resultado: { sugestoes } });
    expect((await c.chamar({ ...PEDIDO, acao: 'sugerir_assuntos', prompt: '' })).status).toBe(400);
    expect(c.buscar).not.toHaveBeenCalled();
  });
  it('registra o contexto efetivo e usa a memória sem devolver nem reescrever o corpo', async () => {
    const cursoId = '33333333-3333-4333-8333-333333333333';
    const c = cenario({ resultado: { sugestoes }, dados: {
      comercial_cursos: [{ id: cursoId, nome: 'Formação para assuntos', resumo_curto: 'Conteúdo atualizado do curso', ativo: true }],
      comercial_curso_playbook: [], comercial_curso_links: [],
    } });
    const original = structuredClone(docAtual);
    const resposta = await c.chamar({ ...PEDIDO, acao: 'sugerir_assuntos', documento: original, contexto: { curso_id: cursoId },
      memoria_escrita: { versao: 1, ativa: true, extensao: 'curta', tom: 'direto', ctaPadrao: '', palavrasEvitar: [] } });
    expect(resposta.status).toBe(200); const resultado = await resposta.json();
    expect(resultado).not.toHaveProperty('documento'); expect(original).toEqual(docAtual);
    const snapshot = validarSnapshotFontesEmailIA(resultado.snapshot_fontes);
    expect(snapshot.fontes[0].campos.Resumo).toBe('Conteúdo atualizado do curso');
    const body = JSON.parse(String(c.buscar.mock.calls[0][1]!.body));
    expect(body.system).toContain('<preferencias_de_escrita>');
    const entrada = JSON.parse(body.messages[0].content.at(-1).text);
    expect(entrada.contexto_real.texto).toContain(`Resumo: ${snapshot.fontes[0].campos.Resumo}`);
    expect(entrada.documento_atual).toEqual(docAtual);
    expect(c.buscar).toHaveBeenCalledTimes(1);
  });
  it('revisa condições de cada opção sem validar a oferta pela proposta anterior', async () => {
    const atuais = structuredClone(sugestoes); atuais[0].assunto = 'Formação por R$ 900,00';
    const c = cenario({ resultado: { sugestoes: atuais } });
    const resposta = await c.chamar({ ...PEDIDO, acao: 'sugerir_assuntos', documento: { ...docAtual, assunto: 'Formação por R$ 900,00' } });
    expect(resposta.status).toBe(200);
    const resultado = await resposta.json();
    expect(resultado.sugestoes[0].revisao_comercial).toMatchObject([{ tipo: 'preco', trecho: 'R$ 900,00' }]);
    expect(resultado.sugestoes[1].revisao_comercial).toEqual([]);
    expect(c.buscar).toHaveBeenCalledTimes(1);
  });
  it.each([
    { sugestoes: sugestoes.slice(0, 2) },
    { sugestoes, documento: docAtual },
    { sugestoes: [{ ...sugestoes[0], assunto: 'Assunto\r\nBcc: privado@exemplo.test' }, ...sugestoes.slice(1)] },
  ])('recusa saída fora do contrato e preserva e-mail', async resultado => {
    const c = cenario({ resultado });
    const resposta = await c.chamar({ ...PEDIDO, acao: 'sugerir_assuntos' });
    expect(resposta.status).toBe(422);
    expect(await resposta.json()).toMatchObject({ code: 'INVALID_OUTPUT' });
  });
  it('compartilha a mesma cota e não chama o provedor quando ela terminou', async () => {
    const c = cenario({ resultado: { sugestoes }, permitido: false });
    const resposta = await c.chamar({ ...PEDIDO, acao: 'sugerir_assuntos' });
    expect(resposta.status).toBe(429);
    expect(resposta.headers.get('Retry-After')).toBe('37');
    expect(c.buscar).not.toHaveBeenCalled();
  });
});

describe('proteção aprovada no endpoint e na recomposição do navegador', () => {
  const documento: DocumentoEmail = { ...DOCUMENTO, linhas: [
    { id: 'linha-livre', colunas: [{ id: 'coluna-livre', larguraPct: 100, blocos: [
      { id: 'titulo-livre', tipo: 'texto', props: { texto: 'Título antes' } },
      { id: 'bloco-protegido', tipo: 'html', props: { html: '<p>Conteúdo aprovado</p>' }, estiloMobile: { tamanhoFonte: 18 } },
    ] }] },
    { id: 'linha-protegida', colunas: [{ id: 'coluna-protegida', larguraPct: 100, blocos: [{ id: 'link-protegido', tipo: 'link', props: { texto: 'Descadastrar', href: '{{descadastro_url}}' } }] }] },
  ] };
  const protecao = { blocos: ['bloco-protegido'], linhas: ['linha-protegida'], cores: true };
  const estrutura = { ...DOCUMENTO, linhas: [{ preservar_id: 'linha-protegida' }, { colunas: [{ larguraPct: 100, blocos: [{ preservar_id: 'bloco-protegido' }, { tipo: 'texto', props: { texto: 'Apresentação nova' } }] }] }] };
  it.each(MODELOS_EMAIL_IA)('regenera com marcadores no $nome conservando protegidos nos dois lados', async modelo => {
    const c = cenario({ contratoReal: true, resultado: { resumo: 'Reorganizei o conteúdo livre', documento: estrutura } });
    const resposta = await c.chamar({ ...PEDIDO, modelo_id: modelo.id, documento, protecao });
    expect(resposta.status).toBe(200);
    const resultado = await resposta.json();
    expect(resultado.documento.linhas[0]).toEqual(documento.linhas[1]);
    expect(resultado.documento.linhas[1].colunas[0].blocos[0]).toEqual(documento.linhas[0].colunas[0].blocos[1]);
    expect(validarRespostaProtegidaEmailIA(resultado, documento, protecao).documento).toEqual(resultado.documento);
    expect(resultado.cota).toMatchObject({ restante_dia: 49 });
    const body = JSON.parse(String(c.buscar.mock.calls[0][1]!.body));
    const schema = modelo.provider === 'anthropic' ? body.output_config.format.schema : body.generationConfig.responseJsonSchema;
    expect(schema.$defs.linha.anyOf[1].properties.preservar_id.enum).toEqual(['linha-protegida']);
    expect(c.buscar).toHaveBeenCalledTimes(1);
  });
  it.each([{ tipo: 'bloco', alvo_id: 'bloco-protegido' }, { tipo: 'bloco', alvo_id: 'link-protegido' }, { tipo: 'linha', alvo_id: 'linha-livre' }, { tipo: 'cores' }])('recusa conflito antes do contador e da chamada paga', async ajuste => {
    const c = cenario();
    const resposta = await c.chamar({ ...PEDIDO, documento, protecao, ajuste });
    expect(resposta.status).toBe(400);
    expect(await resposta.json()).toMatchObject({ code: 'PROTECTED_CONTENT' });
    expect(c.rpc).not.toHaveBeenCalledWith('email_template_ia_consumir_cota', expect.anything());
    expect(c.buscar).not.toHaveBeenCalled();
  });
  it('ajusta irmão livre sem alterar bloco ou linha aprovados', async () => {
    const c = cenario({ contratoReal: true, resultado: { resumo: 'Troquei título', bloco: { tipo: 'texto', props: { texto: 'Depois' } } } });
    const resposta = await c.chamar({ ...PEDIDO, documento, protecao, ajuste: { tipo: 'bloco', alvo_id: 'titulo-livre' } });
    expect(resposta.status).toBe(200);
    const resultado = validarRespostaProtegidaEmailIA(await resposta.json(), documento, protecao);
    expect(resultado.documento.linhas[1]).toEqual(documento.linhas[1]);
    expect(resultado.documento.linhas[0].colunas[0].blocos[1]).toEqual(documento.linhas[0].colunas[0].blocos[1]);
  });
  it.each(['omissao', 'duplicacao', 'injetar-id'])('falha fechada se a IA tentar %s da proteção', async tipo => {
    const saida = structuredClone(estrutura);
    if (tipo === 'omissao') saida.linhas.shift();
    if (tipo === 'duplicacao') saida.linhas.push({ preservar_id: 'linha-protegida' });
    if (tipo === 'injetar-id') Object.assign(saida.linhas[1], { id: 'linha-protegida' });
    const c = cenario({ contratoReal: true, resultado: { resumo: 'Tentativa', documento: saida } });
    const resposta = await c.chamar({ ...PEDIDO, documento, protecao });
    expect(resposta.status).toBe(422);
    expect(await resposta.json()).toMatchObject({ code: 'INVALID_OUTPUT', cota: { restante_dia: 49 } });
    expect(c.buscar).toHaveBeenCalledTimes(1);
  });
});

describe('consulta da cota existente sem consumir ou chamar provedor', () => {
  it.each(['admin', 'diretor'] as const)('consulta saldo real do %s, ignorando usuário forjado', async cargo => {
    const c = cenario({ cargo, estadoCota: { dia_utc: new Date().toISOString().slice(0, 10), usos_dia: 23, usos_ultimo_minuto: [new Date().toISOString()] } });
    const resposta = await c.chamar({ acao: 'consultar_cota', usuario_id: AGENTE });
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ cota: { restante_minuto: 4, restante_dia: 27 } });
    expect(c.consultas.find(v => v.tabela === 'email_template_ia_cotas')?.filtros).toEqual({ usuario_id: USUARIO });
    expect(c.rpc).not.toHaveBeenCalledWith('email_template_ia_consumir_cota', expect.anything());
    expect(c.buscar).not.toHaveBeenCalled();
    expect(c.consultas.some(v => v.tabela === 'ai_api_keys')).toBe(false);
  });
  it.each([{ cargo: 'nenhum' as const }, { ativo: false }])('não consulta cota sem autorização completa', async opcoes => {
    const c = cenario(opcoes);
    expect((await c.chamar({ acao: 'consultar_cota' })).status).toBe(403);
    expect(c.consultas.some(v => v.tabela === 'email_template_ia_cotas')).toBe(false);
  });
  it('consulta indisponível não inventa saldo', async () => {
    const c = cenario({ erroConsultaCota: true });
    const resposta = await c.chamar({ acao: 'consultar_cota' });
    expect(resposta.status).toBe(503);
    expect(await resposta.json()).toEqual({ code: 'LIMIT_UNAVAILABLE', error: 'Não foi possível consultar sua cota de IA. Tente novamente.' });
  });
  it('fotografia auxiliar indisponível não descarta proposta já gerada', async () => {
    const c = cenario({ erroConsultaCota: true });
    const resposta = await c.chamar();
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ documento: DOCUMENTO, cota: null });
  });
  it('falha do provedor devolve saldo real após a tentativa consumida', async () => {
    const c = cenario({ statusProvedor: 500 });
    const resposta = await c.chamar();
    expect(resposta.status).toBe(422);
    expect(await resposta.json()).toMatchObject({ cota: { restante_minuto: 4, restante_dia: 49 } });
  });
});

describe('kit de marca como padrão seguro que cede ao pedido manual', () => {
  const logoUrl = `${URL_PUBLICA}/storage/v1/object/public/email-imagens/logo.png`;
  const kit = { ...kitMarcaEmailIAVazio('Marca cadastrada'), logoUrl, tom: 'Texto claro e acolhedor', rodape: 'Entre em contato com nossa equipe.', email: 'contato@ppg.test', ctaUrl: 'https://ppg.test/contato' };
  const documento = { ...DOCUMENTO, globais: { ...DOCUMENTO.globais, corTexto: '#112233' }, linhas: [{ id: 'linha', colunas: [{ id: 'coluna', larguraPct: 100, blocos: [
    { id: 'logo', tipo: 'imagem', props: { src: logoUrl, alt: 'Marca' } },
    { id: 'cta', tipo: 'botao', props: { texto: 'Saiba mais', href: kit.ctaUrl } },
  ] }] }] };
  it('envia kit validado como contexto e permite logo sem forçar cor sobre o resultado solicitado', async () => {
    const c = cenario({ contratoReal: true, resultado: { documento, resumo: 'Apliquei a identidade e a cor solicitada.' } });
    const resposta = await c.chamar({ ...PEDIDO, kit_marca: kit, prompt: 'Use a identidade, mas o texto deve ser #112233.' });
    expect(resposta.status).toBe(200);
    const proposta = await resposta.json();
    expect(proposta.documento.globais.corTexto).toBe('#112233');
    expect(proposta.revisao_comercial).toEqual([]);
    const body = JSON.parse(String(c.buscar.mock.calls[0][1]!.body));
    expect(JSON.parse(body.messages[0].content.at(-1).text).kit_marca).toEqual(kit);
    expect(body.system).toContain('O pedido manual atual prevalece');
    expect(body.system).toContain('um link ativo de inscrição/conhecimento do curso');
  });
  it('não aplica global nem rodapé do kit fora do bloco escolhido', async () => {
    const atual = { ...docVazio('E-mail existente'), linhas: [{ id: 'linha', colunas: [{ id: 'coluna', larguraPct: 100, blocos: [{ id: 'texto', tipo: 'texto', props: { texto: 'Texto anterior' } }] }] }] };
    const c = cenario({ contratoReal: true, resultado: { resumo: 'Ajustei o texto.', bloco: { tipo: 'texto', props: { texto: 'Texto novo' }, estilo: {}, estiloMobile: {} } } });
    const resposta = await c.chamar({ ...PEDIDO, documento: atual, kit_marca: kit, ajuste: { tipo: 'bloco', alvo_id: 'texto' } });
    expect(resposta.status).toBe(200);
    const proposta = await resposta.json();
    expect(proposta.documento.globais).toEqual(atual.globais);
    expect(proposta.documento.linhas).toHaveLength(1);
    expect(proposta.documento.linhas[0].colunas[0].blocos).toHaveLength(1);
    expect(proposta.documento.linhas[0].colunas[0].blocos[0].id).toBe('texto');
  });
  it('não trata preço escrito no rodapé do kit como condição confirmada', async () => {
    const oferta = { ...DOCUMENTO, linhas: [{ colunas: [{ blocos: [{ tipo: 'texto', props: { texto: 'Investimento de R$ 900,00.' } }] }] }] };
    const c = cenario({ contratoReal: true, resultado: { documento: oferta, resumo: 'Oferta criada.' } });
    const resposta = await c.chamar({ ...PEDIDO, kit_marca: { ...kit, rodape: 'Investimento de R$ 900,00.' } });
    expect(resposta.status).toBe(200);
    expect((await resposta.json()).revisao_comercial).toMatchObject([{ tipo: 'preco', trecho: 'R$ 900,00' }]);
  });
  it.each([
    { ...kit, logoUrl: 'https://outro.test/logo.png' },
    { ...kit, logoUrl: `${URL_PUBLICA}/storage/v1/object/public/email-imagens/logo.svg` },
    { ...kit, ctaUrl: 'javascript:alert(1)' },
    { ...kit, fonte: 'Arial; color:red' },
    { ...kit, provider_url: 'https://forjado.test' },
  ])('rejeita preferências inválidas antes de consumir cota', async kit_marca => {
    const c = cenario();
    expect((await c.chamar({ ...PEDIDO, kit_marca })).status).toBe(400);
    expect(c.buscar).not.toHaveBeenCalled();
    expect(c.rpc).not.toHaveBeenCalledWith('email_template_ia_consumir_cota', expect.anything());
  });
});
