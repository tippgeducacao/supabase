type ModeloWebhook = {
  assunto: string;
  corpoHtml: string;
  corpoTexto: string | null;
  variaveis: Record<string, string>;
};

const VARIAVEL = /\{\{\s*([\w.]+)\s*\}\}/g;

function escaparHtml(valor: string): string {
  return valor.replace(/[&<>"']/g, (caractere) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[caractere]!);
}

function decodificarEntidadesDeUrl(valor: string): string {
  return valor.replace(/&(#x[0-9a-f]+|#[0-9]+|colon|Tab|NewLine|amp);?/gi, (entidade, nome: string) => {
    if (nome.startsWith("#")) {
      const hexadecimal = nome[1].toLowerCase() === "x";
      const codigo = Number.parseInt(nome.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return codigo > 0 && codigo <= 0x10ffff ? String.fromCodePoint(codigo) : "";
    }
    return ({ colon: ":", tab: "\t", newline: "\n", amp: "&" })[nome.toLowerCase()] ?? entidade;
  });
}

/** Dados de formulários são texto, nunca HTML autorizado pelo editor do modelo. */
export function renderizarEmailWebhook(modelo: ModeloWebhook) {
  for (const [bloco] of modelo.corpoHtml.matchAll(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi)) {
    if (bloco.includes("{{")) throw new Error("Variáveis não podem preencher scripts ou estilos.");
  }
  // O editor usa atributos entre aspas. HTML legado continua válido, mas uma
  // variável externa não pode construir tags, eventos ou atributos sem aspas.
  // `>` dentro de alt/title não encerra a tag: só o delimitador fora das aspas.
  for (const [tag] of modelo.corpoHtml.matchAll(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
    const semAtributosDeTexto = tag.replace(/\b(?:href|src|alt|title)\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
    if (/\{\{/.test(semAtributosDeTexto)) {
      throw new Error("Use variáveis no texto ou em links e imagens entre aspas.");
    }
  }
  function renderizar(fonte: string, html: boolean, permitirDescadastro: boolean): string {
    const resultado = fonte.replace(VARIAVEL, (_token, nome: string) => {
      if (nome === "descadastro_url" && permitirDescadastro) return "{{descadastro_url}}";
      if (nome === "descadastro_url" || !Object.hasOwn(modelo.variaveis, nome)
        || typeof modelo.variaveis[nome] !== "string" || !modelo.variaveis[nome].trim()) {
        throw new Error("O modelo contém uma variável sem valor.");
      }
      return html ? escaparHtml(modelo.variaveis[nome]) : modelo.variaveis[nome];
    });
    const semDescadastro = permitirDescadastro ? resultado.replaceAll("{{descadastro_url}}", "") : resultado;
    if (/\{\{|\}\}|\{webhook=/i.test(semDescadastro)) {
      throw new Error("O modelo contém uma variável que não foi resolvida.");
    }
    return resultado;
  }

  const assunto = renderizar(modelo.assunto, false, false);
  const corpoHtml = renderizar(modelo.corpoHtml, true, true);
  const corpoTexto = modelo.corpoTexto == null ? null : renderizar(modelo.corpoTexto, false, true);
  if (!assunto.trim() || /[\r\n]/.test(assunto) || !corpoHtml.trim()) {
    throw new Error("O modelo precisa de assunto válido e conteúdo.");
  }
  // Escapar aspas protege atributos, mas não muda o protocolo de uma URL dinâmica.
  for (const atributo of corpoHtml.matchAll(/\b(?:href|src|action|background)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const valor = [...decodificarEntidadesDeUrl(atributo[1] ?? atributo[2] ?? atributo[3])]
      .filter((caractere) => caractere.charCodeAt(0) > 32 && caractere.charCodeAt(0) !== 127).join("");
    if (/^(?:javascript|vbscript|data|file):/i.test(valor)) {
      throw new Error("O modelo contém um endereço de link ou imagem inválido.");
    }
  }
  return { assunto, corpoHtml, corpoTexto };
}

/** O webhook mantém seu contexto no histórico, e usa a finalidade do modelo. */
export function emailEhMarketing(contexto: string | undefined, usoModelo: string | null) {
  return contexto === "campanha" || (contexto === "webhook" && usoModelo === "marketing");
}
