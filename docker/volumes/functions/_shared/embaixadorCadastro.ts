// Regras do formulário de cadastro do embaixador — UM lugar só, usado pela edge
// emb-cadastro-publico (que decide) e pelo formulário em /embaixador/cadastro (que avisa antes).
// Puro (sem Deno nem DOM) para rodar no vitest. Ver docs/Embaixadores.md.

export const UFS = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB", "PE", "PI",
  "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
] as const;

export const TRATAMENTOS = ["embaixador", "embaixadora"] as const;

export const PIX_TIPOS = ["cnpj", "email", "celular", "aleatoria"] as const;
export type PixTipo = (typeof PIX_TIPOS)[number];

export interface CadastroEmbaixador {
  nome: string;
  /** Como aparece na página: "Embaixador PPGVET" ou "Embaixadora PPGVET". */
  tratamento: string;
  email: string;
  email_confirmacao: string;
  whatsapp: string;
  profissao: string;
  onde_trabalha: string;
  area_atuacao: string;
  cidade: string;
  uf: string;
  bio: string;
  frase?: string;
  instagram?: string;
  linkedin?: string;
  cnpj?: string;
  razao_social?: string;
  pix_tipo?: string;
  pix_chave?: string;
  aceite: boolean;
}

/** Campo → mensagem. Vazio = pode enviar. */
export type ErrosCadastro = Partial<Record<keyof CadastroEmbaixador | "foto" | "senha", string>>;

const limpar = (s: string | undefined | null) => (s ?? "").trim().replace(/\s+/g, " ");
export const soDigitos = (s: string | undefined | null) => (s ?? "").replace(/\D/g, "");

export function emailValido(email: string): boolean {
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/.test(email);
}

/** WhatsApp brasileiro → 55 + DDD + número (10 ou 11 dígitos depois do 55). Null se não der. */
export function normalizarWhatsapp(entrada: string): string | null {
  let d = soDigitos(entrada);
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  if (!d.startsWith("55") || (d.length !== 12 && d.length !== 13)) return null;
  const ddd = Number(d.slice(2, 4));
  if (ddd < 11 || ddd > 99) return null;
  return d;
}

/** CNPJ com dígitos verificadores certos (14 dígitos, não repetidos). */
export function cnpjValido(entrada: string): boolean {
  const c = soDigitos(entrada);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const dv = (base: string) => {
    const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = pesos.reduce((s, p, i) => s + p * Number(base[i]), 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(c.slice(0, 12));
  const d2 = dv(c.slice(0, 12) + d1);
  return c.endsWith(`${d1}${d2}`);
}

/** Endereço da página: "Ana Souza" → "ana-souza" (sem acento, só a-z, 0-9 e hífen). */
export function apelidoDoNome(nome: string): string {
  const base = limpar(nome)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return base.length >= 3 ? base : `embaixador-${base || "ppgvet"}`.slice(0, 50);
}

/** Nome abreviado para o painel do embaixador: "Carlos Mendes Souza" → "Carlos M." */
export function nomeAbreviado(nome: string): string {
  const partes = limpar(nome).split(" ").filter(Boolean);
  if (partes.length === 0) return "";
  const primeiro = partes[0].charAt(0).toUpperCase() + partes[0].slice(1).toLowerCase();
  if (partes.length === 1) return primeiro;
  const ultimo = partes[partes.length - 1];
  return `${primeiro} ${ultimo.charAt(0).toUpperCase()}.`;
}

const tamanho = (v: string, min: number, max: number, rotulo: string): string | undefined => {
  if (v.length < min) return min <= 1 ? `Preencha ${rotulo}.` : `${rotulo.charAt(0).toUpperCase() + rotulo.slice(1)}: escreva pelo menos ${min} caracteres.`;
  if (v.length > max) return `${rotulo.charAt(0).toUpperCase() + rotulo.slice(1)}: no máximo ${max} caracteres.`;
  return undefined;
};

/**
 * Confere o formulário. `pessoal` = convite pessoal (o e-mail vem do convite e não é digitado).
 * Pagamento (CNPJ, PIX) é opcional no cadastro, mas o que vier tem de estar certo.
 */
export function validarCadastro(c: CadastroEmbaixador, opcoes: { pessoal?: boolean } = {}): ErrosCadastro {
  const e: ErrosCadastro = {};
  const nome = limpar(c.nome);
  if (nome.length < 5 || !nome.includes(" ")) e.nome = "Escreva o nome completo.";
  else if (nome.length > 120) e.nome = "Nome: no máximo 120 caracteres.";

  if (!opcoes.pessoal) {
    const email = limpar(c.email).toLowerCase();
    if (!emailValido(email)) e.email = "E-mail inválido.";
    else if (email !== limpar(c.email_confirmacao).toLowerCase()) e.email_confirmacao = "Os dois e-mails não são iguais.";
  }

  if (!TRATAMENTOS.includes(limpar(c.tratamento) as (typeof TRATAMENTOS)[number])) e.tratamento = "Escolha como você quer aparecer na página.";

  if (!normalizarWhatsapp(c.whatsapp)) e.whatsapp = "WhatsApp com DDD, por exemplo (49) 99999-0000.";

  const t = (k: keyof CadastroEmbaixador, min: number, max: number, rotulo: string) => {
    const msg = tamanho(limpar(c[k] as string), min, max, rotulo);
    if (msg) e[k] = msg;
  };
  t("profissao", 2, 80, "a profissão");
  t("onde_trabalha", 2, 120, "onde você trabalha");
  t("area_atuacao", 2, 80, "a área de atuação");
  t("cidade", 2, 80, "a cidade");
  if (!UFS.includes(limpar(c.uf).toUpperCase() as (typeof UFS)[number])) e.uf = "Escolha o estado.";
  t("bio", 40, 800, "a sua história");
  if (limpar(c.frase).length > 160) e.frase = "Frase: no máximo 160 caracteres.";
  if (limpar(c.instagram).length > 120) e.instagram = "Instagram: no máximo 120 caracteres.";
  if (limpar(c.linkedin).length > 200) e.linkedin = "LinkedIn: no máximo 200 caracteres.";

  if (soDigitos(c.cnpj).length > 0 && !cnpjValido(c.cnpj ?? "")) e.cnpj = "CNPJ inválido.";
  if (limpar(c.razao_social).length > 160) e.razao_social = "Razão social: no máximo 160 caracteres.";
  const pixTipo = limpar(c.pix_tipo);
  const pixChave = limpar(c.pix_chave);
  if (pixTipo && !PIX_TIPOS.includes(pixTipo as PixTipo)) e.pix_tipo = "Tipo de chave inválido.";
  else if (pixTipo && !pixChave) e.pix_chave = "Informe a chave PIX.";
  else if (!pixTipo && pixChave) e.pix_tipo = "Escolha o tipo da chave PIX.";
  else if (pixTipo && pixChave) {
    const erroChave = problemaDaChavePix(pixTipo as PixTipo, pixChave);
    if (erroChave) e.pix_chave = erroChave;
  }

  if (c.aceite !== true) e.aceite = "Aceite o termo do programa para continuar.";
  return e;
}

export function problemaDaChavePix(tipo: PixTipo, chave: string): string | undefined {
  if (tipo === "cnpj" && !cnpjValido(chave)) return "Chave PIX: CNPJ inválido.";
  if (tipo === "email" && !emailValido(chave.toLowerCase())) return "Chave PIX: e-mail inválido.";
  if (tipo === "celular" && !normalizarWhatsapp(chave)) return "Chave PIX: celular com DDD.";
  if (tipo === "aleatoria" && !/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(chave.trim())) {
    return "Chave PIX aleatória inválida.";
  }
  return undefined;
}

/** O que vai para emb_embaixadores, já normalizado (depois de validarCadastro sem erros). */
export function dadosNormalizados(c: CadastroEmbaixador) {
  const pixTipo = limpar(c.pix_tipo) as PixTipo | "";
  let pixChave = limpar(c.pix_chave);
  if (pixTipo === "cnpj") pixChave = soDigitos(pixChave);
  if (pixTipo === "celular") pixChave = normalizarWhatsapp(pixChave) ?? pixChave;
  if (pixTipo === "email") pixChave = pixChave.toLowerCase();
  const redes: Record<string, string> = {};
  if (limpar(c.instagram)) redes.instagram = limpar(c.instagram);
  if (limpar(c.linkedin)) redes.linkedin = limpar(c.linkedin);
  return {
    nome: limpar(c.nome),
    tratamento: limpar(c.tratamento),
    email: limpar(c.email).toLowerCase(),
    whatsapp: normalizarWhatsapp(c.whatsapp),
    profissao: limpar(c.profissao),
    onde_trabalha: limpar(c.onde_trabalha),
    area_atuacao: limpar(c.area_atuacao),
    cidade: limpar(c.cidade),
    uf: limpar(c.uf).toUpperCase(),
    bio: (c.bio ?? "").trim(),
    frase: limpar(c.frase) || null,
    redes,
    cnpj: soDigitos(c.cnpj) || null,
    razao_social: limpar(c.razao_social) || null,
    pix_tipo: pixTipo || null,
    pix_chave: pixChave || null,
  };
}

/** Foto recortada que o formulário manda: data URL JPEG/PNG/WebP de até 1,5 MB. */
export function fotoDoDataUrl(dataUrl: string | undefined): { mime: string; base64: string } | null {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec((dataUrl ?? "").trim());
  if (!m) return null;
  const bytes = Math.floor((m[2].length * 3) / 4);
  if (bytes < 2_000 || bytes > 1_500_000) return null;
  return { mime: m[1], base64: m[2] };
}
