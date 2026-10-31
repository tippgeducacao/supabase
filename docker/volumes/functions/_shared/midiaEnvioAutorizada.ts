// Assinatura de envio como a pessoa (31/10/2026, revisão do pentest).
// A service_role não deve transformar uma URL escolhida por logado em acesso ao arquivo.
// Para mídia recebida, exige referência à mensagem lida com o JWT; nos demais buckets o
// próprio Storage decide com a RLS da pessoa. Automação autenticada mantém a via de serviço.
import { AcessoNegado, type Chamador } from "./acessoRegra.ts";
import { BUCKET_RECEBIDOS, MidiaInvalida, objetoDoStorage, paraHostPublico, urlBaixavel } from "./midiaRecebida.ts";

export interface ReferenciaMidia { tabela?: unknown; id?: unknown }
export interface DepsMidiaEnvio {
  base: string;
  chaveAnon: string;
  chaveServico: string;
  publico: string;
  fetchImpl?: typeof fetch;
  conferirExterna: (url: string) => Promise<void>;
}
export interface MidiaEnvio {
  baixar: (url: string) => Promise<Response>;
  paraTerceiros: (url: string) => Promise<string>;
  conferir: (url: string) => Promise<string>;
  componentes: (valor: unknown, idsResolvidosNoServidor?: boolean) => Promise<unknown>;
}

const TABELAS = new Set(["crm_whatsapp_messages", "sac_mensagens", "ped_conversas_mensagens"]);

export function criarMidiaEnvio(quem: Chamador, deps: DepsMidiaEnvio, origem?: ReferenciaMidia): MidiaEnvio {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = deps.base.replace(/\/$/, "");
  const cache = new Map<string, Promise<string>>();

  async function resolver(url: string): Promise<string> {
    const o = objetoDoStorage(url); // Recusa travessia antes de new URL normalizá-la.
    if (!o) {
      await deps.conferirExterna(url);
      return url;
    }
    if (quem.tipo !== "usuario") {
      return await urlBaixavel(url, { base, chave: deps.chaveServico, fetchImpl });
    }
    let token = quem.token;
    if (o.bucket === BUCKET_RECEBIDOS) {
      const tabela = String(origem?.tabela ?? "");
      const id = String(origem?.id ?? "");
      if (!TABELAS.has(tabela) || !/^[0-9a-f-]{36}$/i.test(id)) {
        throw new AcessoNegado(403, "Informe a mensagem de origem para encaminhar esta mídia recebida.");
      }
      const r = await fetchImpl(`${base}/rest/v1/${tabela}?select=anexos&id=eq.${id}&limit=1`, {
        headers: { apikey: deps.chaveAnon, Authorization: `Bearer ${quem.token}` },
      });
      if (!r.ok) throw new AcessoNegado(403, "Sem acesso à mensagem de origem.");
      const rows = await r.json() as Array<{ anexos?: unknown }>;
      const anexos = Array.isArray(rows[0]?.anexos) ? rows[0].anexos : [];
      const pertence = anexos.some((a: Record<string, unknown>) => [a.url, a.url_storage].some((u) => {
        const alvo = objetoDoStorage(typeof u === "string" ? u : null);
        return alvo?.bucket === o.bucket && alvo.caminho === o.caminho;
      }));
      if (!pertence) throw new AcessoNegado(403, "O arquivo não pertence à mensagem autorizada.");
      token = deps.chaveServico; // Só após conferir registro e caminho exatos com a sessão.
    }
    const caminho = o.caminho.split("/").map(encodeURIComponent).join("/");
    const r = await fetchImpl(`${base}/storage/v1/object/sign/${o.bucket}/${caminho}`, {
      method: "POST",
      headers: { apikey: deps.chaveAnon, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 600 }),
    });
    if (!r.ok) throw new AcessoNegado(403, "Você não tem acesso ao arquivo deste envio.");
    const data = await r.json() as { signedURL?: string };
    if (!data.signedURL?.startsWith("/object/sign/")) throw new AcessoNegado(503, "Não foi possível preparar o arquivo.");
    return `${base}/storage/v1${data.signedURL}`;
  }

  function conferir(url: string): Promise<string> {
    if (!cache.has(url)) cache.set(url, resolver(url));
    return cache.get(url)!;
  }
  async function paraTerceiros(url: string): Promise<string> {
    const resolvida = await conferir(url);
    return resolvida.startsWith(`${base}/storage/v1/`)
      ? `${deps.publico.replace(/\/$/, "")}${resolvida.slice(base.length)}`
      : paraHostPublico(resolvida, deps.publico);
  }
  async function baixar(url: string): Promise<Response> {
    let atual = await conferir(url);
    for (let i = 0; i < 5; i++) {
      const r = await fetchImpl(atual, { redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(r.status)) return r;
      const location = r.headers.get("location");
      await r.body?.cancel();
      if (!location) throw new MidiaInvalida();
      // Redirect nunca herda a autorização do endereço anterior.
      atual = await conferir(new URL(location, atual).href);
    }
    throw new MidiaInvalida();
  }
  async function transformar(valor: unknown, idsResolvidosNoServidor: boolean, campo = ""): Promise<unknown> {
    if (Array.isArray(valor)) return await Promise.all(valor.map((v) => transformar(v, idsResolvidosNoServidor, campo)));
    if (!valor || typeof valor !== "object") return valor;
    if (quem.tipo === "usuario" && !idsResolvidosNoServidor
        && ["image", "video", "document", "audio", "sticker"].includes(campo) && "id" in valor) {
      // Um media_id copiado do cache da Meta também é uma capacidade de leitura.
      // O navegador envia a URL; só o servidor gera/reusa id depois de autorizá-la.
      throw new AcessoNegado(403, "Informe o arquivo de origem do cabeçalho para conferir o acesso.");
    }
    const saida: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor)) {
      saida[k] = k === "link" && typeof v === "string" ? await paraTerceiros(v) : await transformar(v, idsResolvidosNoServidor, k);
    }
    return saida;
  }
  const componentes = (valor: unknown, idsResolvidosNoServidor = false) => transformar(valor, idsResolvidosNoServidor);
  return { conferir, paraTerceiros, baixar, componentes };
}
