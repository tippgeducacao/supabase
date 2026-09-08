/**
 * Estrutura enviada aos provedores, compartilhada com o exemplo usado no prompt.
 * O esquema anterior só dizia documento:object e aceitava até um documento vazio.
 *
 * Subconjunto comum de Claude JSON outputs e Gemini responseJsonSchema: referências locais,
 * enums e objetos fechados, sem recursão. Não adicionar limites numéricos,
 * maxLength ou maxItems aqui: Claude strict rejeita essas palavras-chave. Restrições
 * semânticas (URLs, cores, medidas, tamanho total) continuam em validarDocumentoIA.
 * Estilos de bloco vazios são explícitos. Uma união das nove variantes repetia as
 * escolhas de estilos desktop/mobile e excedeu a gramática do Claude na API real.
 * O shape único limita essas escolhas; validarDocumentoIA correlaciona tipo/props.
 *
 * Referências oficiais consultadas em 08/09/2026:
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 * https://ai.google.dev/api/generate-content#GenerationConfig
 */
import { GLOBAIS_PADRAO } from "./types.ts";

interface Schema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: false;
  items?: Schema;
  minItems?: 0 | 1;
  enum?: Array<string | number>;
  $ref?: string;
  $defs?: Record<string, Schema>;
}

const texto = (description: string): Schema => ({ type: "string", description });
const numero = (description: string): Schema => ({ type: "number", description });
const opcoes = (valores: Array<string | number>, description?: string): Schema => ({ type: typeof valores[0] === "number" ? "number" : "string", enum: valores, ...(description ? { description } : {}) });
const ref = (nome: string): Schema => ({ $ref: `#/$defs/${nome}` });
const objeto = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: "object", properties, required, additionalProperties: false });
const lista = (items: Schema, description: string): Schema => ({ type: "array", items, minItems: 1, description });

const COR = texto("Cor hexadecimal #RGB ou #RRGGBB. Sem nomes, transparent, RGB(), CSS ou HTML.");
const FONTE = opcoes([
  "Arial", "Arial, Helvetica, sans-serif", "Helvetica", "Helvetica, Arial, sans-serif",
  "Verdana", "Verdana, Geneva, sans-serif", "Tahoma", "Tahoma, Verdana, sans-serif",
  "Trebuchet MS", "'Trebuchet MS', Helvetica, sans-serif", "Georgia", "Georgia, 'Times New Roman', serif",
  "Times New Roman", "'Times New Roman', Times, serif", "Courier New", "'Courier New', Courier, monospace",
]);
const HREF = texto("Destino real http(s), mailto, tel ou {{descadastro_url}} exata. Se o pedido não informar destino do CTA, use exatamente # para o usuário completar no editor. Nunca URL inventada, vazia ou fragmento diferente de #.");
const IMAGEM = texto("URL http(s) de PNG/JPEG/GIF/WebP fornecida para o conteúdo ou já presente no documento. Não inventar URL, usar referência privada, SVG ou data:.");
const ALVO = opcoes(["_blank", "_self"]);

const DEFINICOES: Record<string, Schema> = {
  padding: objeto({
    topo: numero("Pixels de 0 a 80."), direita: numero("Pixels de 0 a 80."),
    baixo: numero("Pixels de 0 a 80."), esquerda: numero("Pixels de 0 a 80."),
  }),
  estilo_bloco: objeto({
    corTexto: COR, corFundo: COR,
    tamanhoFonte: numero("Tamanho de 10 a 72px. Títulos 28–40, corpo 16–18."),
    pesoFonte: numero("Peso de 100 a 900; 400 normal e 700 negrito."),
    alinhamento: opcoes(["left", "center", "right", "justify"]),
    padding: ref("padding"), raio: numero("Pixels de 0 a 60."),
  }, []),
  // Padding explícito (zeros quando não desejado) evita mais escolhas opcionais.
  estilo_area: objeto({ corFundo: COR, padding: ref("padding") }, ["padding"]),
  props: {
    ...objeto({
      texto: texto("Obrigatório em texto/botao/link; opcional em video. Texto puro, até 4000 caracteres no texto e até 200 nos outros. Nunca HTML."),
      href: HREF, alvo: ALVO, src: IMAGEM,
      alt: texto("Descrição de imagem/imagem-link/video, até 200 caracteres."),
      itens: lista(texto("Item de texto puro não vazio, até 500 caracteres."), "Somente lista: de 1 a 30 itens."),
      ordenada: { type: "boolean", description: "Somente lista." },
      thumbnail: IMAGEM,
      espessura: numero("Somente separador: de 1 a 8px."),
      altura: numero("Somente espacador: de 0 a 200px."),
    }, []),
    description: "Inclua SOMENTE props do tipo escolhido: texto{texto}; botao/link{texto,href,alvo}; lista{itens,ordenada}; imagem{src,alt}; imagem-link{src,alt,href,alvo}; video{thumbnail,href,alt,texto,alvo}; separador{espessura}; espacador{altura}. Omitir campos dos outros tipos, nunca preencher com null ou vazios.",
  },
  globais: objeto({
    larguraContainer: numero("Largura de 320 a 800px; prefira 600."), fonte: FONTE,
    corFundo: COR, corFundoPagina: COR, corTexto: COR, corLink: COR,
    tamanhoFonte: numero("Corpo de 12 a 32px; prefira 16."), alturaLinha: numero("Multiplicador numérico de 1 a 3; prefira 1.5."),
    paddingPadrao: ref("padding"), breakpointMobile: numero("Largura de 320 a 640px; prefira 480."),
  }),
};

DEFINICOES.bloco = {
  ...objeto({
    tipo: opcoes(["texto", "botao", "link", "lista", "imagem", "imagem-link", "video", "separador", "espacador"]),
    props: ref("props"), estilo: ref("estilo_bloco"), estiloMobile: ref("estilo_bloco"),
  }),
  description: "Bloco nativo com props específicas do seu tipo. estilo/estiloMobile:{} herdam os globais. Fonte/altura de linha vêm dos globais; imagens usam largura responsiva automática. Sem IDs, HTML, CSS customizado ou extras.",
};
DEFINICOES.coluna = objeto({
  larguraPct: numero("Porcentagem positiva; colunas da mesma linha somam 100."),
  blocos: lista(ref("bloco"), "Conteúdo nativo da coluna. No máximo 120 blocos somando o documento todo."),
  estilo: ref("estilo_area"), alinhamentoVertical: opcoes(["top", "middle", "bottom"]),
});
DEFINICOES.linha = objeto({
  nome: texto("Nome interno da seção em até 120 caracteres."),
  colunas: lista(ref("coluna"), "De 1 a 3 colunas; no celular prefira empilhar."),
  estilo: ref("estilo_area"), empilharMobile: { type: "boolean" }, corFundoExterna: COR,
}, ["nome", "colunas", "estilo", "empilharMobile"]);

export const SCHEMA_RESULTADO_EMAIL_IA: Schema = {
  ...objeto({
    resumo: texto("Resumo em português do que foi criado ou ajustado, não vazio, até 300 caracteres."),
    documento: objeto({
      versao: opcoes([1]), nome: texto("Nome interno não vazio, até 120 caracteres."),
      assunto: texto("Assunto do e-mail, até 200 caracteres."), preheader: texto("Prévia da caixa de entrada, até 250 caracteres."),
      globais: ref("globais"), linhas: lista(ref("linha"), "Documento completo de 1 a 40 linhas, até 120 blocos no total."),
    }),
  }),
  $defs: DEFINICOES,
};

/** Exemplo real, validado nos testes contra o schema E contra o compilador.
 * Sem imagem nem link de campanha inventados: o único destino é o descadastro. */
export const EXEMPLO_RESULTADO_EMAIL_IA = {
  resumo: "Organizei uma abertura visual, apresentação das formações e rodapé.",
  documento: {
    versao: 1,
    nome: "Conheça nossas pós-graduações",
    assunto: "Sua próxima etapa na Medicina Veterinária",
    preheader: "Amplie sua formação e conheça novas possibilidades profissionais.",
    globais: { ...GLOBAIS_PADRAO, paddingPadrao: { ...GLOBAIS_PADRAO.paddingPadrao } },
    linhas: [{
      nome: "Apresentação", empilharMobile: true, estilo: { padding: { topo: 0, direita: 0, baixo: 0, esquerda: 0 } },
      colunas: [{
        larguraPct: 100, estilo: { padding: { topo: 0, direita: 0, baixo: 0, esquerda: 0 } }, alinhamentoVertical: "top",
        blocos: [
          { tipo: "texto", props: { texto: "Conhecimento para o seu próximo passo" }, estilo: { tamanhoFonte: 32, pesoFonte: 700, corTexto: "#7c3aed" }, estiloMobile: { tamanhoFonte: 26 } },
          { tipo: "texto", props: { texto: "Conheça nossas pós-graduações e encontre a formação que combina com seus objetivos profissionais." }, estilo: {}, estiloMobile: {} },
          { tipo: "link", props: { texto: "Descadastrar", href: "{{descadastro_url}}", alvo: "_blank" }, estilo: { tamanhoFonte: 12 }, estiloMobile: {} },
        ],
      }],
    }],
  },
};
