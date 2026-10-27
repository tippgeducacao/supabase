import { assinaturaCompativel, extensaoArquivo, validarManifesto, validarProfessor, type ArquivoDeclarado, type ArquivoDoEnvio, type RegraArquivo } from "./arquivosValidacao.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_PUBLICO = "https://api.ppgeducacao.site";
const resposta = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" } });

/**
 * Extensão de transporte da integração, não um segundo CRM/processador. Depois de
 * conferir os bytes, chama o MESMO intake e suas ações de funil/responsável/SAC.
 * O segredo fica no servidor da LP; os arquivos sobem por tokens de caminho único.
 */
export async function receberComArquivos(req: Request, integracao: any, db: any, intake: (payload: Record<string, unknown>) => Promise<Response>): Promise<Response> {
  try {
    if (Number(req.headers.get("content-length")) > 65536) return resposta({ ok: false, erro: "Corpo muito grande." }, 413);
    const texto = await req.text();
    if (texto.length > 65536) return resposta({ ok: false, erro: "Corpo muito grande." }, 413);
    let body: any;
    try { body = JSON.parse(texto); } catch { return resposta({ ok: false, erro: "Envie JSON." }, 400); }
    if (!body || !UUID.test(body.envio_id ?? "")) return resposta({ ok: false, erro: "Identificador do envio inválido." }, 422);
    const cfg = integracao.config.arquivos;
    const regras: RegraArquivo[] = cfg.campos;
    const agora = Date.now();

    if (body.operacao === "preparar") {
      if (agora < Date.parse(cfg.inicio) || agora > Date.parse(cfg.fim)) return resposta({ ok: false, erro: "O período de inscrições não está aberto." }, 422);
      const erro = validarManifesto(regras, body.arquivos);
      if (erro) return resposta({ ok: false, erro }, 422);
      const arquivos: ArquivoDoEnvio[] = body.arquivos.map((a: ArquivoDeclarado) => ({
        campo: a.campo, tipo: a.tipo, tamanho: a.tamanho,
        nome: `${a.campo}.${extensaoArquivo(a.tipo)}`,
        rotulo: regras.find(r => r.campo === a.campo)!.rotulo,
        bucket: a.tipo.startsWith("video/") ? "crm-webhook-aulas" : "crm-webhook-documentos",
        caminho: `${integracao.id}/${body.envio_id}/${a.campo}.${extensaoArquivo(a.tipo)}`,
      }));
      // Id do pedido vem da LP e é estável no retry. Não cria protocolos/pastas órfãos.
      const protocolo = `PROF26-${body.envio_id.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
      const { error: erroInsert } = await db.from("crm_webhook_envios").upsert({
        id: body.envio_id, integration_id: integracao.id, protocolo, arquivos,
      }, { onConflict: "id", ignoreDuplicates: true });
      if (erroInsert) throw erroInsert;
      const { data: envio, error } = await db.from("crm_webhook_envios").select("*").eq("id", body.envio_id).eq("integration_id", integracao.id).single();
      if (error) throw error;
      if (JSON.stringify(envio.arquivos) !== JSON.stringify(arquivos)) {
        // JSONB pode reordenar chaves. Compara os campos do contrato, não serialização.
        const mesmo = envio.arquivos.length === arquivos.length && arquivos.every(a => envio.arquivos.some((b: ArquivoDoEnvio) => a.campo === b.campo && a.tipo === b.tipo && a.tamanho === b.tamanho));
        if (!mesmo) return resposta({ ok: false, erro: "Os arquivos mudaram. Inicie um novo envio." }, 409);
      }
      const envios: Record<string, string> = {};
      let envioAula: Record<string, string> | null = null;
      for (const a of envio.arquivos as ArquivoDoEnvio[]) {
        const { data, error } = await db.storage.from(a.bucket).createSignedUploadUrl(a.caminho);
        if (error) throw error;
        if (a.tipo.startsWith("video/")) {
          envioAula = { endpoint: `${STORAGE_PUBLICO}/storage/v1/upload/resumable/sign`, token: data.token, caminho: a.caminho, bucket: a.bucket };
        } else {
          // O runtime self-hosted pode usar Kong interno; o navegador recebe a origem pública.
          const link = new URL(data.signedUrl);
          envios[a.campo] = `${STORAGE_PUBLICO}${link.pathname}${link.search}`;
        }
      }
      return resposta({ ok: true, protocolo: envio.protocolo, envioId: envio.id, envios, envioAula });
    }

    if (body.operacao !== "concluir") return resposta({ ok: false, erro: "Operação inválida." }, 422);
    const { data: envio, error } = await db.from("crm_webhook_envios").select("*").eq("id", body.envio_id).eq("integration_id", integracao.id).single();
    if (error || !envio) return resposta({ ok: false, erro: "Envio não encontrado. Inicie novamente." }, 404);
    if (envio.estado === "concluido") return resposta({ ok: true, protocolo: envio.protocolo, ...envio.resultado, repetido: true });
    // A tolerância só vale para quem de fato preparou o envio antes do prazo.
    if (agora < Date.parse(cfg.inicio) || agora > Date.parse(cfg.fim) + 3 * 3600000 || agora > Date.parse(envio.criado_em) + 3 * 3600000) return resposta({ ok: false, erro: "O prazo deste envio expirou. Inicie novamente." }, 422);
    const dados = body.dados;
    if (!dados || typeof dados !== "object" || Array.isArray(dados)) return resposta({ ok: false, erro: "Dados inválidos." }, 422);
    const arquivos = envio.arquivos as ArquivoDoEnvio[];
    if (cfg.formulario === "professores_2026") {
      const problema = validarProfessor(dados, arquivos.some(a => a.campo === "aula"));
      if (problema) return resposta({ ok: false, ...problema }, 422);
    }

    // Reserva atômica, com lease: duas conclusões simultâneas não executam ações duas vezes.
    const lease = new Date(agora + 120000).toISOString();
    const { data: reservado, error: erroReserva } = await db.from("crm_webhook_envios")
      .update({ estado: "processando", lease_ate: lease }).eq("id", envio.id)
      .neq("estado", "concluido").or(`lease_ate.is.null,lease_ate.lt.${new Date(agora).toISOString()}`).select("id").maybeSingle();
    if (erroReserva) throw erroReserva;
    if (!reservado) return resposta({ ok: false, erro: "A inscrição ainda está sendo confirmada. Tente novamente em instantes.", repetir: true }, 409);
    try {
      for (const a of arquivos) {
        const { data: lista, error: erroLista } = await db.storage.from(a.bucket).list(`${integracao.id}/${envio.id}`, { search: a.nome, limit: 20 });
        const recebido = lista?.find((o: any) => o.name === a.nome);
        if (erroLista || !recebido || Number(recebido.metadata?.size) !== a.tamanho || recebido.metadata?.mimetype !== a.tipo) return resposta({ ok: false, campo: a.campo, erro: `O arquivo não chegou completo: ${a.rotulo}.` }, 422);
        const { data: link, error: erroLink } = await db.storage.from(a.bucket).createSignedUrl(a.caminho, 60);
        if (erroLink) throw erroLink;
        // Um objeto menor que 32 bytes precisa chegar à validação de formato;
        // pedir além do tamanho pode retornar 416 e parecer falha temporária.
        const limite = Math.min(32, a.tamanho);
        const r = await fetch(link.signedUrl, { headers: { Range: `bytes=0-${limite - 1}` }, signal: AbortSignal.timeout(15000) });
        // Cancela o stream depois do cabeçalho: um servidor sem Range nunca força baixar 2 GB.
        const leitor = r.body?.getReader();
        if (!r.ok || !leitor) throw new Error("Não foi possível conferir o arquivo.");
        const cabecalho = new Uint8Array(limite);
        let lidos = 0;
        while (lidos < limite) {
          const { value, done } = await leitor.read();
          if (done || !value) break;
          const trecho = value.subarray(0, limite - lidos);
          cabecalho.set(trecho, lidos);
          lidos += trecho.length;
        }
        await leitor.cancel();
        if (!assinaturaCompativel(a.tipo, cabecalho.subarray(0, lidos))) return resposta({ ok: false, campo: a.campo, erro: `O conteúdo não corresponde ao formato: ${a.rotulo}.` }, 422);
      }
      // Recupera entrega cujo HTTP se perdeu APÓS o log do intake, antes do recibo final.
      const { data: anterior } = await db.from("crm_webhook_logs").select("resultado").eq("integration_id", integracao.id)
        .eq("payload->dados_completos->>id", envio.id).in("status", ["ok", "duplicado"]).order("criado_em").limit(1).maybeSingle();
      let resultado = anterior?.resultado;
      if (!resultado?.lead_id || !resultado?.oportunidade_id) {
        // Só campos esperados são encaminhados. O visitante não pode injetar destinos/ações.
        const payload: Record<string, unknown> = { Protocolo: envio.protocolo, dados_completos: { id: envio.id } };
        for (const chave of ["Nome", "WhatsApp", "E_mail", "Area", "Subarea", "Tema_aula", "Lattes", "Link_aula", "Ciente", "URL", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
          if (typeof dados[chave] === "string") payload[chave] = dados[chave].slice(0, 2000);
          else if (chave === "Ciente") payload[chave] = dados[chave];
        }
        const r = await intake(payload);
        resultado = await r.json();
        if (!r.ok || !resultado.ok || !resultado.lead_id || !resultado.oportunidade_id) return resposta({ ok: false, erro: "Não foi possível confirmar a chegada ao CRM. Tente novamente.", repetir: true }, 503);
      }
      const { error: erroFim } = await db.from("crm_webhook_envios").update({
        estado: "concluido", dados, resultado, lead_id: resultado.lead_id,
        oportunidade_id: resultado.oportunidade_id, concluido_em: new Date().toISOString(), lease_ate: null,
      }).eq("id", envio.id);
      if (erroFim) throw erroFim;
      return resposta({ ok: true, protocolo: envio.protocolo, lead_id: resultado.lead_id, oportunidade_id: resultado.oportunidade_id });
    } finally {
      await db.from("crm_webhook_envios").update({ lease_ate: null, estado: "preparado" }).eq("id", envio.id).eq("estado", "processando").eq("lease_ate", lease);
    }
  } catch {
    // Não ecoar links assinados, segredos ou dados do candidato nos erros.
    return resposta({ ok: false, erro: "Não foi possível confirmar o envio. Tente novamente.", repetir: true }, 503);
  }
}
