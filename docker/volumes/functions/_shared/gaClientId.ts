// client_id do GA4 que o site manda junto com o lead (16/11/2026, ponte GA4 ↔ CRM).
// É o número do visitante no cookie `_ga` ("GA1.1.123456789.1700000000" → "123456789.1700000000").
// Com ele a edge ga4-crm-eventos manda reunião e matrícula ao mesmo visitante no GA4
// (Measurement Protocol). Não é clique de anúncio: não entra na régua de origem.

/** Normaliza para "<número>.<número>" ou devolve undefined (lixo, placeholder, vazio). */
export function normalizarGaClientId(valor: unknown): string | undefined {
  if (typeof valor !== "string" && typeof valor !== "number") return undefined;
  const texto = String(valor).trim();
  // Valor cru do cookie: GA1.<nível do domínio>.<id>.<carimbo>
  const doCookie = /^GA\d\.\d+\.(\d{1,20}\.\d{1,20})$/i.exec(texto);
  if (doCookie) return doCookie[1];
  return /^\d{1,20}\.\d{1,20}$/.test(texto) ? texto : undefined;
}

/** Primeiro `ga_client_id` válido entre corpo e query (na ordem dada). */
export function gaClientIdDe(...fontes: Array<Record<string, unknown> | undefined | null>): string | undefined {
  for (const f of fontes) {
    const v = normalizarGaClientId(f?.ga_client_id);
    if (v) return v;
  }
  return undefined;
}
