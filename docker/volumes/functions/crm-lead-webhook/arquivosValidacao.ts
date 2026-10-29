/** Upload opt-in do webhook existente. O manifesto é fixado ANTES do envio. */
export type RegraArquivo = { campo: string; rotulo: string; tipos: string[]; maxBytes: number; obrigatorio?: boolean };
export type ArquivoDeclarado = { campo: string; tipo: string; tamanho: number; nome?: string };
export type ArquivoDoEnvio = ArquivoDeclarado & { caminho: string; rotulo: string; bucket: string };

export function validarManifesto(regras: RegraArquivo[], entrada: unknown): string | null {
  if (!Array.isArray(entrada) || entrada.length > regras.length) return "Lista de arquivos inválida.";
  const vistos = new Set<string>();
  for (const a of entrada) {
    const r = regras.find(r => r.campo === a?.campo);
    if (!r || vistos.has(a.campo)) return "Arquivo desconhecido ou repetido.";
    vistos.add(a.campo);
    if (!r.tipos.includes(a.tipo)) return `Formato inválido: ${r.rotulo}.`;
    if (!Number.isSafeInteger(a.tamanho) || a.tamanho <= 0 || a.tamanho > r.maxBytes) return `Tamanho inválido: ${r.rotulo}.`;
  }
  const faltando = regras.find(r => r.obrigatorio && !vistos.has(r.campo));
  return faltando ? `Anexe o arquivo: ${faltando.rotulo}.` : null;
}

export function extensaoArquivo(tipo: string): string {
  const mapa: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
  if (!mapa[tipo]) throw new Error("Formato não suportado.");
  return mapa[tipo];
}

/** MIME declarado sozinho não prova conteúdo. Lemos só o cabeçalho, inclusive de vídeos grandes. */
export function assinaturaCompativel(tipo: string, b: Uint8Array): boolean {
  const texto = (a: number, z: number) => new TextDecoder().decode(b.slice(a, z));
  if (tipo === "application/pdf") return texto(0, 5) === "%PDF-";
  if (tipo === "image/png") return [137,80,78,71,13,10,26,10].every((v,i) => b[i] === v);
  if (tipo === "image/jpeg") return b[0] === 255 && b[1] === 216 && b[2] === 255;
  if (tipo === "image/webp") return texto(0, 4) === "RIFF" && texto(8, 12) === "WEBP";
  if (tipo === "video/webm") return [26,69,223,163].every((v,i) => b[i] === v);
  if (tipo === "video/mp4" || tipo === "video/quicktime") return texto(4, 8) === "ftyp";
  return false;
}

const AREAS = ["Direito Animal", "Anestesiologia Veterinária", "Medicina Felina", "Clínica Geral de Cães e Gatos", "Medicina Integrativa Veterinária", "Diagnóstico por Imagem Veterinário", "Comportamento de Animais de Companhia, Silvestres e Pets Não Convencionais", "Piscicultura", "Direito Agrário", "Gestão e Cooperativas", "Nutrição de monogástricos", "Terapia intensiva veterinária", "Nutrição de cães e gatos", "Adestramento de cães"];

/** Mapeamento explícito por opção: área desconhecida nunca cai na etapa padrão. */
export function etapaPorCampo(params: any, dados: Record<string, unknown>): string | null {
  const mapa = params?.etapaPorCampo;
  if (!mapa) return typeof params?.etapaId === "string" ? params.etapaId : null;
  const valor = dados[mapa.campo];
  return typeof valor === "string" && Object.hasOwn(mapa.etapas ?? {}, valor)
    ? mapa.etapas[valor] : null;
}
const SUBAREAS = ["Vendas", "Marketing", "Compliance", "Liderança", "Gestão Financeira"];
export function linkHttp(valor: unknown): string | null {
  if (typeof valor !== "string" || valor.length > 2000) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(valor.trim()) ? valor.trim() : `https://${valor.trim()}`);
    return ["http:", "https:"].includes(u.protocol) && u.hostname.includes(".") && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}

/** Exigências do edital 002. CPF/RG estão no PDF de identificação, não em logs extras. */
export function validarProfessor(d: Record<string, unknown>, temVideo: boolean): { campo: string; erro: string } | null {
  const s = (k: string) => typeof d[k] === "string" ? (d[k] as string).trim() : "";
  if (s("Nome").length < 3 || !s("Nome").includes(" ") || s("Nome").length > 120) return { campo: "nome", erro: "Informe seu nome completo." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s("E_mail")) || s("E_mail").length > 255) return { campo: "email", erro: "Informe um e-mail válido." };
  // O DDI só é removido quando SOBRA um número nacional. DDD 55 é legítimo.
  let tel = s("WhatsApp").replace(/\D/g, "");
  if (tel.startsWith("55") && tel.length >= 12) tel = tel.slice(2);
  if (!/^[1-9][1-9](?:9\d{8}|[2-5]\d{7})$/.test(tel)) return { campo: "whatsapp", erro: "Informe seu WhatsApp com DDD." };
  if (!AREAS.includes(s("Area"))) return { campo: "area", erro: "Escolha a área de inscrição." };
  if (s("Area") === "Gestão e Cooperativas" && !SUBAREAS.includes(s("Subarea"))) return { campo: "subarea", erro: "Escolha a subárea." };
  if (s("Tema_aula").length < 3 || s("Tema_aula").length > 200) return { campo: "tema", erro: "Informe o tema da aula." };
  const lattes = linkHttp(s("Lattes"));
  if (!lattes || new URL(lattes).hostname !== "lattes.cnpq.br") return { campo: "lattes", erro: "Cole o endereço do currículo Lattes (lattes.cnpq.br)." };
  if (!temVideo && !linkHttp(s("Link_aula"))) return { campo: "link_aula", erro: "Envie o vídeo ou um link da aula." };
  if (s("Link_aula") && !linkHttp(s("Link_aula"))) return { campo: "link_aula", erro: "Link da aula inválido." };
  if (d.Ciente !== true) return { campo: "ciente", erro: "Confirme as condições de envio." };
  d.WhatsApp = `55${tel}`;
  d.Nome = s("Nome"); d.E_mail = s("E_mail").toLowerCase();
  d.Lattes = lattes;
  d.Link_aula = s("Link_aula") ? linkHttp(s("Link_aula")) : "";
  d.Subarea = s("Area") === "Gestão e Cooperativas" ? s("Subarea") : "";
  return null;
}
