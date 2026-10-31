import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Handlers reais, com Auth, PostgREST e provedores simulados: nenhum envio sai.
const estado = vi.hoisted(() => ({
  atual: "", handlers: {} as Record<string, (r: Request) => Promise<Response>>,
  eventos: [] as any[], ativo: true, dono: "outra-pessoa", marketing: false, gestao: false,
  pedagogico: false, escreve: false, arquivado: false, erroPermissao: false, erroResposta: false,
  canalTarefa: false, tarefaPermitida: true,
  perdeuClaim: false, contaAtiva: true, templateExiste: true, contaDona: null as string | null,
  ferramenta: null as { name: string; input: Record<string, unknown> } | null,
  usouFerramenta: false, atendimento: false, conversaVisivel: false,
  tarefas: [] as any[], permissoes: { editavel: "edit", leitura: "view", oculta: null } as Record<string, string | null>,
}));

function clienteFalso(_url: string, chave: string, opcoes?: any) {
  const papel = chave === "servico-teste" ? "servico" : "usuario";
  if (papel === "usuario" && opcoes?.global?.headers?.Authorization !== "Bearer sessao-teste") throw Error("Cliente sem JWT do solicitante");
  return {
    async rpc(nome: string, args?: any) {
      estado.eventos.push({ tipo: "rpc", papel, nome, args });
      const error = estado.erroPermissao && ["is_marketing_user", "is_admin_ou_diretor_user", "user_can_access_pedagogico", "gt_ia_pode_usar_canal"].includes(nome)
        ? { code: "indisponivel" } : nome === "gt_ia_registrar_resposta" && estado.erroResposta ? { code: "42501" } : null;
      const data = nome === "is_marketing_user" ? estado.marketing
        : nome === "is_admin_ou_diretor_user" ? estado.gestao
        : nome === "user_can_access_pedagogico" ? estado.pedagogico
        : nome === "gt_can_write_channel" ? estado.escreve
        : nome === "gt_ia_pode_usar_canal" ? estado.escreve && (!estado.canalTarefa || estado.tarefaPermitida)
        : nome === "gt_get_effective_list_permission" ? estado.permissoes[args._list_id]
        : nome === "get_wa_account_pedagogico" ? { id: "producao", waba_id: "waba-producao", phone_number_id: "numero-teste", access_token: "token-falso" }
        : nome === "ig_claim_due_posts" ? [] : "id-sintetico";
      return { data, error };
    },
    from(tabela: string) {
      let operacao = "select", colunas = "", valor: any;
      const filtros: any[] = [];
      const resultado = () => {
        estado.eventos.push({ tipo: "banco", papel, tabela, operacao, colunas, valor, filtros: [...filtros] });
        if (operacao !== "select") {
          if (tabela === "ig_scheduled_posts" && valor?.status === "publishing") return {
            data: estado.perdeuClaim ? null : [{ id: "post-teste" }], error: estado.perdeuClaim ? { code: "42501" } : null,
          };
          return { data: { id: "nova-tarefa", ...valor }, error: null };
        }
        const data = tabela === "profiles" ? colunas === "ativo" ? { ativo: estado.ativo } : [{ id: "usuario-teste", name: "Pessoa sintética" }]
          : tabela === "ig_scheduled_posts" ? colunas.includes("ig_accounts")
            ? { id: "post-teste", media_type: "IMAGE", media_url: "https://midia.invalid/teste.jpg", ig_accounts: { ig_user_id: "ig-teste", access_token: "token-falso" } }
            : { id: "post-teste", user_id: estado.dono }
          : tabela === "gt_chat_channels" ? { id: "canal-real", type: estado.canalTarefa ? "task" : "channel", department_id: "setor-real", archived_at: estado.arquivado ? "2026-01-01" : null }
          : tabela === "ped_conversas_avulsas" ? estado.conversaVisivel ? { id: "conversa-teste", metadata: {} } : null
          : tabela === "gt_task_lists" ? [{ id: "editavel" }, { id: "leitura" }, { id: "oculta" }]
          : tabela === "gt_tasks" ? estado.tarefas
          : tabela === "gt_activity_log" ? []
          : tabela === "ped_wa_templates" ? estado.templateExiste ? { id: "template-teste", nome: "modelo_teste", corpo: "Olá", wa_account_id: estado.contaDona } : null
          : tabela === "ped_configuracoes" ? [{ chave: "wa_account_id_pedagogico", valor: "producao" }, { chave: "wa_account_id_pedagogico_migracao", valor: "migracao" }]
          : tabela === "wa_accounts" ? estado.contaAtiva ? { id: filtros.find(f => f[0] === "eq" && f[1] === "id")?.[2], waba_id: `waba-${filtros.find(f => f[0] === "eq" && f[1] === "id")?.[2]}`, phone_number_id: "numero-teste", access_token: "token-falso" } : null
          : tabela === "crm_whatsapp_accounts" ? { access_token: "token-falso" } : [];
        return { data, error: null };
      };
      const q: any = {};
      for (const metodo of ["select", "eq", "in", "lt", "gte", "is", "order", "range", "limit", "ilike", "update", "insert", "upsert"]) {
        q[metodo] = (...args: any[]) => {
          if (metodo === "select") colunas = args[0];
          else if (["update", "insert", "upsert"].includes(metodo)) { operacao = metodo; valor = args[0]; }
          else filtros.push([metodo, ...args]);
          return q;
        };
      }
      q.maybeSingle = q.single = async () => resultado();
      q.then = (resolve: any) => Promise.resolve(resultado()).then(resolve);
      return q;
    },
  };
}

vi.mock("https://esm.sh/@supabase/supabase-js@2.49.4", () => ({ createClient: (...args: any[]) => clienteFalso(...args as [string, string, any]) }));
vi.mock("https://esm.sh/@supabase/supabase-js@2.39.3", () => ({ createClient: (...args: any[]) => clienteFalso(...args as [string, string, any]) }));
vi.mock("https://esm.sh/@supabase/supabase-js@2.45.0", () => ({ createClient: (...args: any[]) => clienteFalso(...args as [string, string, any]) }));
vi.mock("npm:@supabase/supabase-js@2", () => ({ createClient: (...args: any[]) => clienteFalso(...args as [string, string, any]) }));
vi.mock("https://deno.land/std@0.168.0/http/server.ts", () => ({ serve: (h: any) => { estado.handlers[estado.atual] = h; } }));

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  vi.stubGlobal("Deno", {
    env: { get: (nome: string) => ({ SUPABASE_URL: "https://supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "servico-teste", SUPABASE_ANON_KEY: "anon-teste", ANTHROPIC_API_KEY: "ia-falsa" } as any)[nome] },
    serve: (h: any) => { estado.handlers[estado.atual] = h; },
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const destino = String(url);
    estado.eventos.push({ tipo: "rede", destino, metodo: init?.method });
    if (destino === "https://supabase.invalid/auth/v1/user") return Response.json({ id: "usuario-teste", is_anonymous: false });
    if (destino === "https://supabase.invalid/rest/v1/rpc/crm_pode_ler_atendimentos") return Response.json(estado.atendimento);
    if (destino.startsWith("https://supabase.invalid/storage/v1/object/sign/")) return Response.json({ error: "sem acesso" }, { status: 403 });
    if (destino === "https://api.anthropic.com/v1/messages") {
      if (estado.ferramenta && !estado.usouFerramenta) {
        estado.usouFerramenta = true;
        return Response.json({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "tool-1", ...estado.ferramenta }] });
      }
      return Response.json({ content: [{ type: "text", text: "Resposta sintética." }] });
    }
    if (destino === "https://midia.invalid/teste.jpg") return new Response(null, { headers: { "content-type": "image/jpeg" } });
    if (destino.startsWith("https://graph.facebook.com/")) return Response.json({ id: "meta-sintetico", status_code: "FINISHED" });
    throw new Error(`Rede não simulada: ${destino}`);
  }));
  estado.atual = "instagram"; await import("../ig-publish/index");
  estado.atual = "assistente"; await import("../ai-internal-agent/index");
  estado.atual = "template"; await import("../submit-meta-template/index");
  estado.atual = "crm"; await import("../crm-whatsapp-send/index");
  estado.atual = "whatsapp"; await import("../whatsapp-send-message/index");
});
afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
beforeEach(() => {
  Object.assign(estado, { eventos: [], ativo: true, dono: "outra-pessoa", marketing: false, gestao: false,
    pedagogico: false, escreve: false, arquivado: false, erroPermissao: false, erroResposta: false,
    canalTarefa: false, tarefaPermitida: true,
    perdeuClaim: false, contaAtiva: true, templateExiste: true, contaDona: null, ferramenta: null,
    usouFerramenta: false, atendimento: false, conversaVisivel: false,
    tarefas: [], permissoes: { editavel: "edit", leitura: "view", oculta: null } });
});
const chamar = async (edge: string, body: any, token = "sessao-teste") => {
  const resposta = estado.handlers[edge](new Request("https://edge.invalid", {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }));
  await vi.runAllTimersAsync();
  return resposta;
};
const publicou = () => estado.eventos.some(e => e.tipo === "rede" && e.destino.includes("media_publish"));
const mutacoes = () => estado.eventos.filter(e => e.tipo === "banco" && e.operacao !== "select");
const externas = () => estado.eventos.filter(e => e.tipo === "rede" && !e.destino.startsWith("https://supabase.invalid/"));

describe("Instagram: autorização antes do claim e da Meta", () => {
  it("recusa leitura ampla usada para publicar post alheio", async () => {
    expect((await chamar("instagram", { mode: "single", post_id: "post-teste" })).status).toBe(403);
    expect(mutacoes()).toEqual([]); expect(externas()).toEqual([]);
  });
  it.each(["dono", "marketing", "gestao"])("permite %s e reivindica como usuário", async (papel) => {
    if (papel === "dono") estado.dono = "usuario-teste"; else (estado as any)[papel] = true;
    expect((await chamar("instagram", { mode: "single", post_id: "post-teste" })).status).toBe(200);
    expect(mutacoes()[0]).toMatchObject({ papel: "usuario", valor: { status: "publishing" } });
    expect(publicou()).toBe(true);
  });
  it("a perda de permissão no claim impede leitura do token e publicação", async () => {
    estado.marketing = true; estado.perdeuClaim = true;
    expect((await chamar("instagram", { mode: "single", post_id: "post-teste" })).status).toBe(403);
    expect(externas()).toEqual([]);
    expect(estado.eventos.some(e => e.colunas?.includes("ig_accounts"))).toBe(false);
  });
  it("recusa perfil inativo e falha de conferência", async () => {
    estado.ativo = false; estado.dono = "usuario-teste";
    expect((await chamar("instagram", { mode: "single", post_id: "post-teste" })).status).toBe(403);
    estado.ativo = true; estado.dono = "outro"; estado.erroPermissao = true;
    expect((await chamar("instagram", { mode: "single", post_id: "post-teste" })).status).toBe(503);
    expect(mutacoes()).toEqual([]);
  });
  it("cron exige serviço e preserva o caminho interno", async () => {
    expect((await chamar("instagram", {})).status).toBe(403);
    expect((await chamar("instagram", {}, "servico-teste")).status).toBe(200);
    expect(estado.eventos).toContainEqual(expect.objectContaining({ nome: "ig_claim_due_posts", papel: "servico" }));
  });
});

describe("Assistente: identidade do Auth, setor do canal e listas permitidas", () => {
  const corpo = { message: "consulta de teste", channel_id: "canal-pedido", user_id: "diretor-forjado", department_id: "setor-forjado" };
  it("recusa não participante antes de IA e gravação", async () => {
    expect((await chamar("assistente", corpo)).status).toBe(403);
    expect(externas()).toEqual([]); expect(mutacoes()).toEqual([]);
  });
  it("canal de tarefa com escrita genérica não autoriza tarefa privada alheia", async () => {
    estado.escreve = true; estado.canalTarefa = true; estado.tarefaPermitida = false;
    expect((await chamar("assistente", corpo)).status).toBe(403);
    expect(estado.eventos).toContainEqual(expect.objectContaining({
      nome: "gt_ia_pode_usar_canal", papel: "usuario", args: { p_canal: "canal-pedido" },
    }));
    expect(estado.eventos.some(e => e.nome === "gt_can_write_channel")).toBe(false);
    expect(externas()).toEqual([]); expect(mutacoes()).toEqual([]);
  });
  it("preserva resposta no canal de tarefa autorizada", async () => {
    estado.escreve = true; estado.canalTarefa = true; estado.tarefaPermitida = true;
    expect((await chamar("assistente", corpo)).status).toBe(200);
    expect(estado.eventos.some(e => e.nome === "gt_ia_registrar_resposta")).toBe(true);
  });
  it("canal arquivado, perfil inativo e falha de RPC não autorizam", async () => {
    estado.escreve = true; estado.arquivado = true;
    expect((await chamar("assistente", corpo)).status).toBe(403);
    estado.arquivado = false; estado.ativo = false;
    expect((await chamar("assistente", corpo)).status).toBe(403);
    estado.ativo = true; estado.erroPermissao = true;
    expect((await chamar("assistente", corpo)).status).toBe(503);
    expect(externas()).toEqual([]);
  });
  it("ignora identidade/setor forjados e limita consultas ao JWT e listas autorizadas", async () => {
    estado.escreve = true; estado.ferramenta = { name: "query_tasks", input: { department_id: "setor-da-ia" } };
    expect((await chamar("assistente", corpo)).status).toBe(200);
    const leitura = estado.eventos.find(e => e.tabela === "gt_tasks");
    expect(leitura.papel).toBe("usuario");
    expect(leitura.filtros).toContainEqual(["in", "list_id", ["editavel", "leitura"]]);
    expect(leitura.filtros).toContainEqual(["eq", "gt_task_lists.gt_projects.department_id", "setor-real"]);
    expect(estado.eventos).toContainEqual(expect.objectContaining({ nome: "gt_ia_registrar_resposta", papel: "servico", args: { p_canal: "canal-real", p_usuario: "usuario-teste", p_conteudo: "Resposta sintética." } }));
  });
  it("atividades também filtram as listas", async () => {
    estado.escreve = true; estado.ferramenta = { name: "query_activity", input: { period: "today" } };
    await chamar("assistente", corpo);
    expect(estado.eventos.find(e => e.tabela === "gt_activity_log").filtros).toContainEqual(["in", "gt_tasks.list_id", ["editavel", "leitura"]]);
  });
  it.each(["oculta", "leitura", "outro-setor"])("não cria em lista %s", async (lista) => {
    estado.escreve = true; estado.ferramenta = { name: "create_task", input: { list_id: lista, title: "Não criar" } };
    await chamar("assistente", corpo);
    expect(mutacoes()).toEqual([]);
  });
  it("cria em lista editável como usuário e autor verificado", async () => {
    estado.escreve = true; estado.ferramenta = { name: "create_task", input: { list_id: "editavel", title: "Tarefa sintética", created_by: "forjado" } };
    await chamar("assistente", corpo);
    expect(mutacoes()).toContainEqual(expect.objectContaining({ papel: "usuario", tabela: "gt_tasks", valor: expect.objectContaining({ created_by: "usuario-teste", list_id: "editavel" }) }));
  });
  it("permissão revogada durante a IA impede registrar a resposta", async () => {
    estado.escreve = true; estado.erroResposta = true;
    expect((await chamar("assistente", corpo)).status).toBe(403);
    expect(mutacoes()).toEqual([]);
  });
  it("métricas não usam a view global e consultam só listas permitidas", async () => {
    estado.escreve = true; estado.ferramenta = { name: "query_metrics", input: {} };
    await chamar("assistente", corpo);
    expect(estado.eventos.some(e => e.tabela === "gt_v_collaborator_metrics")).toBe(false);
    expect(estado.eventos.find(e => e.tabela === "gt_tasks").filtros).toContainEqual(["in", "list_id", ["editavel", "leitura"]]);
  });
  it("permissão de comentário permite consultar, mas não criar", async () => {
    estado.escreve = true; estado.permissoes.leitura = "comment";
    estado.ferramenta = { name: "query_tasks", input: {} };
    await chamar("assistente", corpo);
    expect(estado.eventos.find(e => e.tabela === "gt_tasks").filtros).toContainEqual(["in", "list_id", ["editavel", "leitura"]]);
    estado.usouFerramenta = false;
    estado.ferramenta = { name: "create_task", input: { list_id: "leitura", title: "Não criar" } };
    await chamar("assistente", corpo);
    expect(mutacoes()).toEqual([]);
  });
});

describe("Templates pedagógicos: gate e conta resolvida pelo servidor", () => {
  it("recusa usuário sem permissão antes de ler template/credencial e chamar a Meta", async () => {
    expect((await chamar("template", { template_id: "template-teste" })).status).toBe(403);
    expect(estado.eventos.some(e => e.tipo === "banco")).toBe(false); expect(externas()).toEqual([]);
  });
  it("erro da conferência não libera o template", async () => {
    estado.erroPermissao = true;
    expect((await chamar("template", { template_id: "template-teste" })).status).toBe(503);
    expect(externas()).toEqual([]);
  });
  it("recusa conta arbitrária mesmo com acesso pedagógico", async () => {
    estado.pedagogico = true;
    expect((await chamar("template", { template_id: "template-teste", wa_account_id: "outra-conta" })).status).toBe(403);
    expect(estado.eventos.some(e => e.tabela === "wa_accounts")).toBe(false); expect(externas()).toEqual([]);
  });
  it.each([undefined, "migracao"])("preserva submissão autorizada em %s", async (conta) => {
    estado.pedagogico = true;
    expect((await chamar("template", { template_id: "template-teste", wa_account_id: conta })).status).toBe(200);
    expect(externas()).toHaveLength(1);
    expect(estado.eventos.find(e => e.tabela === "ped_wa_templates").papel).toBe("usuario");
    expect(mutacoes().some(e => e.tabela === "ped_wa_templates")).toBe(conta === undefined);
  });
  it("conta inativa não cai silenciosamente na produção", async () => {
    estado.pedagogico = true; estado.contaAtiva = false;
    expect((await chamar("template", { template_id: "template-teste", wa_account_id: "migracao" })).status).toBe(422);
    expect(externas()).toEqual([]); expect(mutacoes()).toEqual([]);
  });
  it("preserva a conta dona salva no template sem aceitar substituição arbitrária", async () => {
    estado.pedagogico = true; estado.contaDona = "podcast-dono";
    expect((await chamar("template", { template_id: "template-teste" })).status).toBe(200);
    expect(estado.eventos.find(e => e.tabela === "wa_accounts").filtros).toContainEqual(["eq", "id", "podcast-dono"]);
    expect(mutacoes().some(e => e.tabela === "ped_wa_templates")).toBe(false);
  });
  it("template inexistente não busca credencial nem publica", async () => {
    estado.pedagogico = true; estado.templateExiste = false;
    expect((await chamar("template", { template_id: "inexistente" })).status).toBe(404);
    expect(externas()).toEqual([]);
  });
});

describe("Envio WhatsApp: recusa antes de provedor e assinatura privilegiada", () => {
  const recebido = "https://api.ppgeducacao.site/storage/v1/object/public/whatsapp-recebidos/pasta/arquivo.pdf";
  it("CRM sem acesso ao atendimento não consulta com serviço", async () => {
    expect((await chamar("crm", { tipo: "text", telefone: "5546999990001", conteudo: "Não enviar" })).status).toBe(403);
    expect(estado.eventos.some(e => e.tipo === "banco" || e.tipo === "rpc")).toBe(false);
    expect(externas()).toEqual([]);
  });
  it.each([recebido, recebido.replace("pasta/", "%252e%252e%252frh-admissional/")])("CRM recusa origem ausente ou travessia antes de qualquer envio (%s)", async (anexo_url) => {
    estado.atendimento = true;
    expect((await chamar("crm", { tipo: "document", telefone: "5546999990001", anexo_url })).status).toBe(403);
    expect(estado.eventos.some(e => e.tipo === "banco" || e.tipo === "rpc")).toBe(false);
    expect(externas()).toEqual([]);
  });
  it("pedagógico sem conversa visível não lê conta com serviço", async () => {
    expect((await chamar("whatsapp", { conversa_id: "conversa-teste", telefone: "5546999990001", tipo: "text", conteudo: "Não enviar" })).status).toBe(403);
    expect(estado.eventos.some(e => e.papel === "servico")).toBe(false);
    expect(externas()).toEqual([]);
  });
  it("pedagógico não envia arquivo que o Storage recusou ao usuário", async () => {
    estado.conversaVisivel = true;
    expect((await chamar("whatsapp", { conversa_id: "conversa-teste", telefone: "5546999990001", tipo: "document", media_url: "https://api.ppgeducacao.site/storage/v1/object/public/rh-admissional/ficticio.pdf" })).status).toBe(403);
    expect(externas()).toEqual([]);
    expect(estado.eventos.some(e => e.destino?.includes("/object/sign/rh-admissional/"))).toBe(true);
  });
});

it.each(["instagram", "assistente", "template", "crm", "whatsapp"])("%s recusa chave pública antes de agir", async (edge) => {
  expect((await chamar(edge, {}, "anon-teste")).status).toBe(401);
  expect(estado.eventos).toEqual([]);
});
