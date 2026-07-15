// Helpers de data/hora no fuso de Brasília (America/Sao_Paulo = UTC-3, sem DST desde 2019).

export function hojeSP(): string {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' -> 'DD/MM'. */
export function fmtData(iso: string): string {
  const [, m, d] = String(iso).slice(0, 10).split("-");
  return d && m ? `${d}/${m}` : String(iso).slice(0, 10);
}

/** data 'YYYY-MM-DD' + hora 'HH:MM' interpretadas em Brasília -> ISO (UTC). */
export function spToIso(data: string, hora: string): string {
  return new Date(`${data}T${(hora || "00:00")}:00-03:00`).toISOString();
}

/** Janela [de, ate) em ISO para consulta de agenda. */
export function janela(input: any): { de: string; ate: string } {
  const base = hojeSP();
  const ms = (d: string, n: number) => new Date(`${d}T00:00:00-03:00`).getTime() + n * 86400000;
  const iso = (t: number) => new Date(t).toISOString();

  if (input?.de) {
    const ateD = input.ate || input.de;
    return { de: new Date(`${input.de}T00:00:00-03:00`).toISOString(), ate: iso(ms(ateD, 1)) };
  }
  const p = input?.periodo || "hoje";
  if (p === "amanha") return { de: iso(ms(base, 1)), ate: iso(ms(base, 2)) };
  if (p === "semana") return { de: iso(ms(base, 0)), ate: iso(ms(base, 7)) };
  return { de: iso(ms(base, 0)), ate: iso(ms(base, 1)) }; // hoje
}

// ── Períodos (dia / semana comercial qua→ter / mês) ──────────────────────────
function dowYmd(ymd: string): number {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay(); // 0=dom..6=sáb (meio-dia UTC evita drift de fuso)
}
export function addDiasYmd(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function primeiroDiaMes(ymd: string): string { return `${ymd.slice(0, 7)}-01`; }
function proxMes(ymd: string): string {
  const [y, m] = ymd.slice(0, 7).split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}
/** Semana comercial (quarta→terça) que contém a data. */
export function semanaComercial(ymd: string): { ini: string; fim: string } {
  const back = (dowYmd(ymd) - 3 + 7) % 7; // quarta = 3
  const ini = addDiasYmd(ymd, -back);
  return { ini, fim: addDiasYmd(ini, 6) };
}
export function mesRange(ymd: string): { ini: string; fim: string; mes: string } {
  const ini = primeiroDiaMes(ymd);
  return { ini, fim: addDiasYmd(proxMes(ini), -1), mes: ini.slice(0, 7) };
}
/** Resolve {de, ate, mes, label} a partir do periodo/param que o modelo passou. */
export function resolverPeriodo(input: any): { de: string; ate: string; mes: string; label: string } {
  const hoje = hojeSP();
  if (input?.de) {
    const de = String(input.de).slice(0, 10);
    const ate = String(input.ate || input.de).slice(0, 10);
    return { de, ate, mes: de.slice(0, 7), label: `${fmtData(de)}–${fmtData(ate)}` };
  }
  if (input?.mes) {
    const r = mesRange(`${String(input.mes).slice(0, 7)}-01`);
    return { de: r.ini, ate: r.fim, mes: r.mes, label: r.mes };
  }
  switch (input?.periodo) {
    case "ontem": { const o = addDiasYmd(hoje, -1); return { de: o, ate: o, mes: o.slice(0, 7), label: "ontem" }; }
    case "semana": { const s = semanaComercial(hoje); return { de: s.ini, ate: s.fim, mes: s.ini.slice(0, 7), label: "esta semana" }; }
    case "semana_passada": { const s = semanaComercial(addDiasYmd(hoje, -7)); return { de: s.ini, ate: s.fim, mes: s.ini.slice(0, 7), label: "semana passada" }; }
    case "mes": case "este_mes": { const r = mesRange(hoje); return { de: r.ini, ate: r.fim, mes: r.mes, label: "este mês" }; }
    case "mes_passado": { const r = mesRange(addDiasYmd(primeiroDiaMes(hoje), -1)); return { de: r.ini, ate: r.fim, mes: r.mes, label: "mês passado" }; }
    default: { return { de: hoje, ate: hoje, mes: hoje.slice(0, 7), label: "hoje" }; }
  }
}
