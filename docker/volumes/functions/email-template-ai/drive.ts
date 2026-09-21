import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";

/**
 * Pasta do Google Drive como origem da biblioteca de imagens.
 *
 * O Drive é FONTE, não hospedagem: `drive.google.com/uc?...` redireciona para o
 * googleusercontent, tem cota e pede login em arquivo restrito — o e-mail sai
 * bonito e fica sem imagem na caixa do destinatário dias depois. Por isso cada
 * arquivo é copiado para o bucket público `email-imagens` e é a URL do bucket
 * que entra no HTML, igual ao que o painel já faz com anexo "usar no e-mail".
 *
 * Só falamos com `www.googleapis.com` por ID de pasta/arquivo validado — nunca
 * buscamos uma URL escolhida por quem cadastra, então não há SSRF a defender.
 */

type Objeto = Record<string, unknown>;
type Consulta = PromiseLike<{ data: unknown; error: unknown }>;

export class ErroDriveEmailIA extends Error {
  constructor(public status: number, public code: string, mensagem: string) { super(mensagem); }
}

export interface DependenciasDriveEmailIA {
  cliente: SupabaseClient;
  usuarioId: string;
  chaveDrive?: string;
  buscar?: typeof fetch;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_DRIVE = /^[A-Za-z0-9_-]{10,200}$/;
const BUCKET = "email-imagens";
/** Cliente de e-mail não renderiza SVG, e o validador da biblioteca já recusa a
 * extensão. Quem manda é o conteúdo do arquivo, não o nome nem o Drive. */
const EXTENSOES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
export const MAX_ARQUIVOS_PASTA_DRIVE = 400;
const MAX_BYTES_ARQUIVO = 10 * 1024 * 1024;
/** Orçamento de uma chamada. O worker tem tempo e memória finitos: o resto fica
 * para a próxima sincronização, anunciado em `restantes`, em vez de estourar no
 * meio e deixar a pasta pela metade sem ninguém saber. */
const MAX_DOWNLOADS = 25;
const MAX_BYTES_TOTAL = 60 * 1024 * 1024;
const TIMEOUT_LISTA = 15_000;
const TIMEOUT_DOWNLOAD = 40_000;

const objeto = (v: unknown): v is Objeto => !!v && typeof v === "object" && !Array.isArray(v);
const invalido = (mensagem: string) => new ErroDriveEmailIA(400, "BAD_REQUEST", mensagem);
const indisponivel = () => new ErroDriveEmailIA(503, "DRIVE_UNAVAILABLE", "Não foi possível consultar as pastas do Drive. Tente novamente.");
const texto = (v: unknown, limite: number) => typeof v === "string" ? v.trim().slice(0, limite) : "";

/** Aceita o link que a pessoa copia do Drive ou o ID cru da pasta. */
export function extrairPastaDriveEmailIA(valor: unknown): string {
  const bruto = texto(valor, 500);
  if (!bruto) throw invalido("Informe o link da pasta do Drive.");
  if (ID_DRIVE.test(bruto)) return bruto;
  let url: URL;
  try { url = new URL(bruto); } catch { throw invalido("O link da pasta do Drive é inválido."); }
  if (url.protocol !== "https:" || !/(^|\.)google\.com$/i.test(url.hostname)) throw invalido("Use um link de pasta do Google Drive.");
  const caminho = url.pathname.match(/\/(?:folders|d)\/([A-Za-z0-9_-]{10,200})/);
  const id = caminho?.[1] ?? url.searchParams.get("id") ?? "";
  if (!ID_DRIVE.test(id)) throw invalido("Não encontrei o ID da pasta nesse link. Copie o link da PASTA no Drive.");
  return id;
}

/** O Drive informa o mimeType, mas quem decide é o conteúdo: arquivo renomeado
 * não vira imagem, e é este byte que vai virar objeto público no bucket. */
export function tipoRealDaImagemDriveEmailIA(bytes: Uint8Array): string | null {
  const comeca = (assinatura: number[]) => assinatura.every((b, i) => bytes[i] === b);
  if (comeca([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (comeca([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (comeca([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (comeca([0x52, 0x49, 0x46, 0x46]) && [0x57, 0x45, 0x42, 0x50].every((b, i) => bytes[8 + i] === b)) return "image/webp";
  return null;
}

async function consultarLista(consulta: Consulta): Promise<Objeto[]> {
  const { data, error } = await consulta;
  if (error || !Array.isArray(data)) throw indisponivel();
  return data as Objeto[];
}
async function consultarUm(consulta: Consulta): Promise<Objeto | null> {
  const { data, error } = await consulta;
  if (error) throw indisponivel();
  return objeto(data) ? data : null;
}

async function buscarDrive(url: string, deps: DependenciasDriveEmailIA, timeout: number): Promise<Response> {
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), timeout);
  try {
    return await (deps.buscar ?? fetch)(url, { signal: controle.signal, headers: { Accept: "*/*" } });
  } catch {
    throw new ErroDriveEmailIA(503, "DRIVE_UNAVAILABLE", "O Google Drive demorou para responder. Tente sincronizar novamente.");
  } finally { clearTimeout(timer); }
}

function erroDoDrive(status: number): ErroDriveEmailIA {
  if (status === 403 || status === 404) {
    return new ErroDriveEmailIA(400, "DRIVE_FORBIDDEN", "O Drive recusou a pasta. Compartilhe como “qualquer pessoa com o link” e confira o link.");
  }
  if (status === 429) return new ErroDriveEmailIA(429, "DRIVE_RATE_LIMIT", "O Google limitou as consultas agora. Tente de novo em alguns minutos.");
  return new ErroDriveEmailIA(503, "DRIVE_UNAVAILABLE", "O Google Drive não respondeu como esperado. Tente novamente.");
}

export interface ArquivoDriveEmailIA {
  id: string; nome: string; mime: string; bytes?: number; md5?: string; modificado?: string; largura?: number; altura?: number;
}

/** Lista só imagens da pasta. `truncada` impede desativar o que não foi visto. */
export async function listarPastaDriveEmailIA(pastaDriveId: string, deps: DependenciasDriveEmailIA): Promise<{ arquivos: ArquivoDriveEmailIA[]; truncada: boolean }> {
  if (!deps.chaveDrive) throw new ErroDriveEmailIA(503, "DRIVE_NOT_CONFIGURED", "A chave do Google Drive não está configurada no servidor.");
  if (!ID_DRIVE.test(pastaDriveId)) throw invalido("Pasta do Drive inválida.");
  const arquivos: ArquivoDriveEmailIA[] = [];
  let pagina: string | undefined;
  for (let volta = 0; volta < 10; volta++) {
    const parametros = new URLSearchParams({
      q: `'${pastaDriveId}' in parents and trashed = false and mimeType contains 'image/'`,
      fields: "nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime,imageMediaMetadata(width,height))",
      pageSize: "100", orderBy: "name_natural", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
      key: deps.chaveDrive,
    });
    if (pagina) parametros.set("pageToken", pagina);
    const resposta = await buscarDrive(`https://www.googleapis.com/drive/v3/files?${parametros}`, deps, TIMEOUT_LISTA);
    if (!resposta.ok) { await resposta.body?.cancel(); throw erroDoDrive(resposta.status); }
    let corpo: unknown;
    try { corpo = await resposta.json(); } catch { throw indisponivel(); }
    if (!objeto(corpo) || !Array.isArray(corpo.files)) throw indisponivel();
    for (const item of corpo.files) {
      if (!objeto(item) || typeof item.id !== "string" || !ID_DRIVE.test(item.id)) continue;
      const mime = String(item.mimeType ?? "");
      if (!EXTENSOES[mime]) continue;
      const medidas = objeto(item.imageMediaMetadata) ? item.imageMediaMetadata : {};
      arquivos.push({
        id: item.id, nome: texto(item.name, 200) || "Imagem do Drive", mime,
        ...(Number(item.size) > 0 ? { bytes: Number(item.size) } : {}),
        ...(typeof item.md5Checksum === "string" && /^[0-9a-f]{32}$/.test(item.md5Checksum) ? { md5: item.md5Checksum } : {}),
        ...(typeof item.modifiedTime === "string" ? { modificado: item.modifiedTime.slice(0, 40) } : {}),
        ...(Number(medidas.width) > 0 ? { largura: Math.trunc(Number(medidas.width)) } : {}),
        ...(Number(medidas.height) > 0 ? { altura: Math.trunc(Number(medidas.height)) } : {}),
      });
      if (arquivos.length >= MAX_ARQUIVOS_PASTA_DRIVE) return { arquivos, truncada: true };
    }
    pagina = typeof corpo.nextPageToken === "string" ? corpo.nextPageToken : undefined;
    if (!pagina) return { arquivos, truncada: false };
  }
  return { arquivos, truncada: true };
}

export interface ResumoSincronizacaoDriveEmailIA {
  total: number; novas: number; atualizadas: number; inalteradas: number; desativadas: number; ignoradas: number; restantes: number; truncada: boolean;
}

/**
 * Espelha a pasta no bucket. Arquivo com o mesmo md5 não é baixado de novo;
 * arquivo que sumiu do Drive é DESATIVADO (e só quando a listagem veio inteira,
 * senão uma página perdida apagaria a biblioteca).
 */
export async function sincronizarPastaDriveEmailIA(pastaId: string, deps: DependenciasDriveEmailIA): Promise<ResumoSincronizacaoDriveEmailIA> {
  const { cliente } = deps;
  const pasta = await consultarUm(cliente.from("email_ia_drive_pastas").select("id,nome,pasta_drive_id,ativo").eq("id", pastaId).maybeSingle());
  if (!pasta) throw invalido("A pasta do Drive não está cadastrada.");
  let listagem: { arquivos: ArquivoDriveEmailIA[]; truncada: boolean };
  try {
    listagem = await listarPastaDriveEmailIA(String(pasta.pasta_drive_id), deps);
  } catch (e) {
    const mensagem = e instanceof ErroDriveEmailIA ? e.message : "Falha ao consultar o Drive.";
    await cliente.from("email_ia_drive_pastas").update({ sincronizacao_erro: mensagem.slice(0, 400), atualizado_em: new Date().toISOString() }).eq("id", pastaId);
    throw e;
  }
  const existentes = await consultarLista(cliente.from("email_ia_drive_imagens").select("id,arquivo_drive_id,md5,url,ativo,nome,largura,altura").eq("pasta_id", pastaId));
  const porArquivo = new Map(existentes.map(l => [String(l.arquivo_drive_id), l]));
  const resumo: ResumoSincronizacaoDriveEmailIA = { total: listagem.arquivos.length, novas: 0, atualizadas: 0, inalteradas: 0, desativadas: 0, ignoradas: 0, restantes: 0, truncada: listagem.truncada };
  let baixados = 0;
  let bytesBaixados = 0;
  const agora = () => new Date().toISOString();

  for (const arquivo of listagem.arquivos) {
    const atual = porArquivo.get(arquivo.id);
    const igual = !!atual && atual.ativo === true && !!atual.url && !!arquivo.md5 && atual.md5 === arquivo.md5;
    if (igual) {
      resumo.inalteradas++;
      // Renomear no Drive não muda o arquivo: atualiza só o rótulo, sem baixar.
      if (atual.nome !== arquivo.nome || (arquivo.largura ?? null) !== (atual.largura ?? null) || (arquivo.altura ?? null) !== (atual.altura ?? null)) {
        await cliente.from("email_ia_drive_imagens").update({
          nome: arquivo.nome, largura: arquivo.largura ?? null, altura: arquivo.altura ?? null, atualizado_em: agora(),
        }).eq("id", atual.id);
      }
      continue;
    }
    if (arquivo.bytes != null && arquivo.bytes > MAX_BYTES_ARQUIVO) { resumo.ignoradas++; continue; }
    if (baixados >= MAX_DOWNLOADS || bytesBaixados >= MAX_BYTES_TOTAL) { resumo.restantes++; continue; }
    baixados++;
    const parametros = new URLSearchParams({ alt: "media", supportsAllDrives: "true", key: deps.chaveDrive! });
    const resposta = await buscarDrive(`https://www.googleapis.com/drive/v3/files/${arquivo.id}?${parametros}`, deps, TIMEOUT_DOWNLOAD);
    if (!resposta.ok) { await resposta.body?.cancel(); resumo.ignoradas++; continue; }
    const bytes = new Uint8Array(await resposta.arrayBuffer());
    bytesBaixados += bytes.byteLength;
    const mime = tipoRealDaImagemDriveEmailIA(bytes);
    if (!mime || bytes.byteLength > MAX_BYTES_ARQUIVO) { resumo.ignoradas++; continue; }
    const caminho = `drive/${pastaId}/${arquivo.id}.${EXTENSOES[mime]}`;
    const envio = await cliente.storage.from(BUCKET).upload(caminho, bytes, { contentType: mime, cacheControl: "31536000", upsert: true });
    if (envio.error) { resumo.ignoradas++; continue; }
    const url = cliente.storage.from(BUCKET).getPublicUrl(caminho).data.publicUrl;
    const gravacao = await cliente.from("email_ia_drive_imagens").upsert({
      pasta_id: pastaId, arquivo_drive_id: arquivo.id, nome: arquivo.nome, mime, bytes: bytes.byteLength,
      md5: arquivo.md5 ?? null, modificado_em: arquivo.modificado ?? null, caminho, url,
      largura: arquivo.largura ?? null, altura: arquivo.altura ?? null, ativo: true, atualizado_em: agora(),
    }, { onConflict: "pasta_id,arquivo_drive_id" });
    if (gravacao.error) { resumo.ignoradas++; continue; }
    if (atual) resumo.atualizadas++; else resumo.novas++;
  }

  if (!listagem.truncada) {
    const presentes = new Set(listagem.arquivos.map(a => a.id));
    const sumidas = existentes.filter(l => l.ativo === true && !presentes.has(String(l.arquivo_drive_id))).map(l => String(l.id));
    if (sumidas.length) {
      const desativacao = await cliente.from("email_ia_drive_imagens").update({ ativo: false, atualizado_em: agora() }).in("id", sumidas);
      if (!desativacao.error) resumo.desativadas = sumidas.length;
    }
  }
  await cliente.from("email_ia_drive_pastas").update({ sincronizado_em: agora(), sincronizacao_erro: null, atualizado_em: agora() }).eq("id", pastaId);
  return resumo;
}

async function listarPastasEmailIA(cliente: SupabaseClient): Promise<Objeto[]> {
  const [pastas, imagens] = await Promise.all([
    consultarLista(cliente.from("email_ia_drive_pastas").select("id,nome,pasta_drive_id,marca_id,ativo,sincronizado_em,sincronizacao_erro").order("nome").order("id")),
    consultarLista(cliente.from("email_ia_drive_imagens").select("pasta_id,ativo").eq("ativo", true)),
  ]);
  const contagem = new Map<string, number>();
  for (const imagem of imagens) contagem.set(String(imagem.pasta_id), (contagem.get(String(imagem.pasta_id)) ?? 0) + 1);
  return pastas.map(p => ({
    id: String(p.id), nome: String(p.nome), pasta_drive_id: String(p.pasta_drive_id),
    marca_id: typeof p.marca_id === "string" ? p.marca_id : null, ativo: p.ativo === true,
    sincronizado_em: p.sincronizado_em ?? null, sincronizacao_erro: p.sincronizacao_erro ?? null,
    imagens: contagem.get(String(p.id)) ?? 0,
  }));
}

/** Chamado somente DEPOIS da autorização admin/diretor feita pelo handler. */
export async function tratarAcaoDriveEmailIA(corpo: Objeto, deps: DependenciasDriveEmailIA): Promise<Objeto | null> {
  const acao = String(corpo.acao ?? "");
  if (!["listar_pastas_drive", "salvar_pasta_drive", "sincronizar_pasta_drive"].includes(acao)) return null;
  if (!deps.chaveDrive) throw new ErroDriveEmailIA(503, "DRIVE_NOT_CONFIGURED", "A chave do Google Drive não está configurada no servidor. Peça ao TI para definir GOOGLE_DRIVE_API_KEY.");
  const { cliente } = deps;

  if (acao === "listar_pastas_drive") return { pastas: await listarPastasEmailIA(cliente) };

  if (acao === "salvar_pasta_drive") {
    const nome = texto(corpo.nome, 120);
    if (!nome) throw invalido("Dê um nome para a pasta.");
    const marca = corpo.marca_id == null || corpo.marca_id === "" ? null : String(corpo.marca_id);
    if (marca !== null && !UUID.test(marca)) throw invalido("Marca inválida.");
    const ativo = corpo.ativo === undefined ? true : corpo.ativo === true;
    if (corpo.id != null && corpo.id !== "") {
      const id = String(corpo.id);
      if (!UUID.test(id)) throw invalido("Pasta inválida.");
      // O link não muda numa edição: trocar a pasta de origem manteria as
      // imagens espelhadas da pasta anterior penduradas neste cadastro.
      const gravacao = await cliente.from("email_ia_drive_pastas").update({ nome, marca_id: marca, ativo, atualizado_em: new Date().toISOString() }).eq("id", id).select("id").maybeSingle();
      if (gravacao.error) throw indisponivel();
      if (!gravacao.data) throw invalido("Essa pasta não está mais cadastrada. Atualize a lista.");
      return { pastas: await listarPastasEmailIA(cliente) };
    }
    const pastaDriveId = extrairPastaDriveEmailIA(corpo.link ?? corpo.pasta_drive_id);
    // Falar com o Drive ANTES de gravar: pasta que ninguém consegue ler não vira
    // cadastro que só denuncia o erro na primeira sincronização.
    await listarPastaDriveEmailIA(pastaDriveId, deps);
    const gravacao = await cliente.from("email_ia_drive_pastas").insert({
      nome, pasta_drive_id: pastaDriveId, marca_id: marca, ativo, criado_por: deps.usuarioId,
    }).select("id").maybeSingle();
    if (gravacao.error) {
      const codigo = objeto(gravacao.error) ? String(gravacao.error.code ?? "") : "";
      if (codigo === "23505") throw invalido("Essa pasta do Drive já está cadastrada.");
      throw indisponivel();
    }
    const criada = String(gravacao.data?.id ?? "");
    const resumo = criada ? await sincronizarPastaDriveEmailIA(criada, deps) : undefined;
    return { pastas: await listarPastasEmailIA(cliente), ...(resumo ? { resumo } : {}) };
  }

  const id = String(corpo.id ?? "");
  if (!UUID.test(id)) throw invalido("Selecione uma pasta cadastrada.");
  const resumo = await sincronizarPastaDriveEmailIA(id, deps);
  return { pastas: await listarPastasEmailIA(cliente), resumo };
}
