import { describe, expect, it, vi } from 'vitest';
import { criarHandlerEmailIA, lerCorpoEmailIA, MODELOS_EMAIL_IA, validarPedidoEmailIA, type DependenciasEmailIA } from './handler';
import { docVazio, type DocumentoEmail } from '../_shared/emailBuilder/types';
import { validarDocumentoIA, PROMPT_DOCUMENTO_IA } from '../_shared/emailBuilder/ai';
import { compilarDocumento } from '../_shared/emailBuilder/compile';

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
  providers?: string[];
  statusProvedor?: number;
  resultado?: unknown;
  truncado?: boolean;
  contratoReal?: boolean;
}
function cenario(opcoes: Opcoes = {}) {
  const eventos: string[] = [];
  const consultas: Array<{ tabela: string; colunas: string; filtros: Record<string, unknown> }> = [];
  const getUser = vi.fn(async () => {
    eventos.push('auth');
    return { data: { user: opcoes.usuario === undefined ? { id: USUARIO } : opcoes.usuario }, error: null };
  });
  const rpc = vi.fn(async (nome: string, args: Record<string, unknown>) => {
    eventos.push(nome);
    if (nome === 'has_role') return { data: args.role_name === (opcoes.cargo ?? 'admin'), error: opcoes.erroPermissao ? { message: 'falha privada' } : null };
    if (nome === 'email_template_ia_consumir_cota') return { data: { permitido: opcoes.permitido ?? true, retry_after: 37 }, error: opcoes.erroCota ? { message: 'falha privada' } : null };
    throw new Error('RPC inesperada');
  });
  const from = vi.fn((tabela: string) => {
    eventos.push(`tabela:${tabela}`);
    const consulta = { tabela, colunas: '', filtros: {} as Record<string, unknown> };
    consultas.push(consulta);
    const resultado = (): Retorno => {
      if (tabela === 'profiles') return { data: { ativo: opcoes.ativo ?? true }, error: null };
      if (tabela === 'ai_agents') {
        const agente = { id: AGENTE, name: 'Diretor de Arte', description: 'Criação visual', system_prompt: 'PROMPT_PRIVADO' };
        return { data: consulta.colunas.includes('system_prompt') ? opcoes.agenteAtivo === false ? null : agente : [agente], error: null };
      }
      if (tabela === 'ai_api_keys') return { data: consulta.colunas === 'provider' ? (opcoes.providers ?? ['anthropic', 'google']).map(provider => ({ provider })) : (opcoes.providers ?? ['anthropic', 'google']).includes(String(consulta.filtros.provider)) ? { api_key: 'CHAVE_PRIVADA_SIMULADA' } : null, error: null };
      throw new Error('Tabela inesperada');
    };
    const builder = {
      select: (colunas: string) => { consulta.colunas = colunas; return builder; },
      eq: (campo: string, valor: unknown) => { consulta.filtros[campo] = valor; return builder; },
      in: () => builder, order: () => builder, limit: () => builder,
      maybeSingle: async () => resultado(),
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
      : Response.json({ stop_reason: opcoes.truncado ? 'max_tokens' : 'tool_use', content: [{ type: 'tool_use', name: 'entregar_template', input: resultado }] });
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
    expect(await resposta.json()).toEqual({ documento: DOCUMENTO, resumo: 'Organizei o convite.' });
    expect(c.rpc).toHaveBeenCalledWith('email_template_ia_consumir_cota', { p_usuario_id: USUARIO });
    expect(c.eventos.indexOf('email_template_ia_consumir_cota')).toBeLessThan(c.eventos.indexOf('provedor'));
    expect(c.buscar).toHaveBeenCalledTimes(1);
    const init = c.buscar.mock.calls[0][1]!;
    const body = JSON.parse(String(init.body));
    if (modelo.provider === 'anthropic') {
      expect(body.model).toBe(modelo.id);
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].name).toBe('entregar_template');
      expect(body.messages[0].content[0].source).toEqual({ type: 'base64', media_type: 'image/png', data: PNG });
    } else {
      expect(body.generationConfig.responseMimeType).toBe('application/json');
      expect(body.contents[0].parts[0].inlineData).toEqual({ mimeType: 'image/png', data: PNG });
      expect(body.tools).toBeUndefined();
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
  it.each(MODELOS_EMAIL_IA)('recusa truncamento em $nome', async modelo => {
    expect((await cenario({ truncado: true }).chamar({ ...PEDIDO, modelo_id: modelo.id })).status).toBe(422);
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
