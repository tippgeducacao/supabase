/** Texto importado é material para revisão humana, nunca instrução privilegiada. */
export const MAX_TEXTO_MATERIAL_EMAIL_IA = 12000;
export interface MaterialEmailIA {
  tipo: "pdf" | "url";
  origem: string;
  texto: string;
  truncado: boolean;
  paginasLidas?: number;
  paginasTotal?: number;
}
export function normalizarTextoMaterialEmailIA(texto: string): string {
  // eslint-disable-next-line no-control-regex -- remove controles do material externo; conserva tab e quebras de linha.
  return texto.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
export function validarMaterialEmailIA(valor: unknown): MaterialEmailIA {
  const v = valor as MaterialEmailIA;
  if (!v || !["pdf", "url"].includes(v.tipo) || typeof v.origem !== "string" || !v.origem || v.origem.length > 2048
    || typeof v.texto !== "string" || !v.texto.trim() || v.texto.length > MAX_TEXTO_MATERIAL_EMAIL_IA || typeof v.truncado !== "boolean") throw new Error("O material importado não contém texto válido.");
  if (v.tipo === "url") { try { if (new URL(v.origem).protocol !== "https:") throw new Error(); } catch { throw new Error("Origem do material inválida."); } }
  for (const campo of ["paginasLidas", "paginasTotal"] as const) if (v[campo] !== undefined && (!Number.isInteger(v[campo]) || v[campo]! < 1 || v[campo]! > 100000)) throw new Error("Contagem de páginas inválida.");
  return { tipo: v.tipo, origem: v.origem, texto: v.texto, truncado: v.truncado,
    ...(v.paginasLidas === undefined ? {} : { paginasLidas: v.paginasLidas }), ...(v.paginasTotal === undefined ? {} : { paginasTotal: v.paginasTotal }) };
}
