interface ResultadoHttp {
  statusHttp: number;
  body: unknown;
}

const LIMITE_CORPO = 32 * 1024;
const falha = (statusHttp: number, erro: string, mensagem: string): ResultadoHttp => ({
  statusHttp, body: { ok: false, erro, mensagem, repetir: false },
});

/** Limita o stream real, inclusive quando o remetente omite Content-Length. */
export async function receberModulosPraticosHttp(
  req: Request,
  processar: (payload: unknown) => Promise<ResultadoHttp>,
): Promise<ResultadoHttp> {
  const tipo = req.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (tipo !== 'application/json') return falha(415, 'content_type_invalido', 'Envie application/json.');
  if (Number(req.headers.get('content-length')) > LIMITE_CORPO) {
    return falha(413, 'corpo_grande_demais', 'Envie uma inscrição por chamada, com até 32 KiB.');
  }
  if (!req.body) return falha(400, 'json_invalido', 'Envie um objeto JSON válido.');
  const leitor = req.body.getReader();
  const partes: Uint8Array[] = [];
  let tamanho = 0;
  let payload: unknown;
  try {
    while (true) {
      const { value, done } = await leitor.read();
      if (done) break;
      tamanho += value.byteLength;
      if (tamanho > LIMITE_CORPO) {
        await leitor.cancel();
        return falha(413, 'corpo_grande_demais', 'Envie uma inscrição por chamada, com até 32 KiB.');
      }
      partes.push(value);
    }
    const bytes = new Uint8Array(tamanho);
    let inicio = 0;
    for (const parte of partes) { bytes.set(parte, inicio); inicio += parte.byteLength; }
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return falha(400, 'json_invalido', 'Envie um objeto JSON válido.');
  } finally {
    leitor.releaseLock();
  }
  return processar(payload);
}
