/** Fotografia da cota existente; a reserva autoritativa continua na RPC atômica. */
export interface CotaEmailIA {
  limite_minuto: 5;
  restante_minuto: number;
  limite_dia: 50;
  restante_dia: number;
  retry_after: number;
  reinicia_dia_em: string;
  consultada_em: string;
}
const invalida = (): never => { throw new Error("A cota de IA não pôde ser conferida."); };
const inteiro = (v: unknown, maximo: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= maximo;

export function validarCotaEmailIA(valor: unknown): CotaEmailIA {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return invalida();
  const v = valor as Record<string, unknown>;
  if (v.limite_minuto !== 5 || v.limite_dia !== 50 || !inteiro(v.restante_minuto, 5) || !inteiro(v.restante_dia, 50)
    || !inteiro(v.retry_after, 86400) || typeof v.reinicia_dia_em !== "string" || !Number.isFinite(Date.parse(v.reinicia_dia_em))
    || typeof v.consultada_em !== "string" || !Number.isFinite(Date.parse(v.consultada_em))) return invalida();
  return { limite_minuto: 5, restante_minuto: v.restante_minuto, limite_dia: 50, restante_dia: v.restante_dia,
    retry_after: v.retry_after, reinicia_dia_em: v.reinicia_dia_em, consultada_em: v.consultada_em };
}

/** Mesma janela aberta de 60s e virada UTC de email_template_ia_consumir_cota.
 * Consulta não grava nem reseta a linha; o próximo consumo faz isso no Postgres. */
export function calcularCotaEmailIA(registro: unknown, agora = Date.now()): CotaEmailIA {
  if (!Number.isFinite(agora)) return invalida();
  const hoje = new Date(agora).toISOString().slice(0, 10);
  const amanha = Date.parse(`${hoje}T00:00:00.000Z`) + 86400000;
  let minuto: number[] = [];
  let dia = 0;
  if (registro !== null) {
    if (!registro || typeof registro !== "object" || Array.isArray(registro)) return invalida();
    const r = registro as Record<string, unknown>;
    if (!Array.isArray(r.usos_ultimo_minuto) || r.usos_ultimo_minuto.length > 5 || !inteiro(r.usos_dia, 50)
      || typeof r.dia_utc !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.dia_utc)) return invalida();
    minuto = r.usos_ultimo_minuto.map(v => typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : invalida())
      .filter(v => v > agora - 60000).sort((a, b) => a - b);
    dia = r.dia_utc === hoje ? r.usos_dia : 0;
  }
  const retry = Math.max(minuto.length >= 5 ? Math.ceil((minuto[0] + 60000 - agora) / 1000) : 0, dia >= 50 ? Math.ceil((amanha - agora) / 1000) : 0);
  return validarCotaEmailIA({ limite_minuto: 5, restante_minuto: 5 - minuto.length, limite_dia: 50, restante_dia: 50 - dia,
    retry_after: Math.max(0, retry), reinicia_dia_em: new Date(amanha).toISOString(), consultada_em: new Date(agora).toISOString() });
}
