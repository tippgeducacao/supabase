import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const json = (valor: unknown, status = 200) => new Response(JSON.stringify(valor), {
  status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

type Dependencias = {
  admin: SupabaseClient;
  autenticar: (authorization: string) => Promise<{ id: string } | null>;
  iniciarSync: (caixaId: string) => void;
};

/** O cliente de serviço só grava depois de conferir sessão, dono, pasta e OAuth. */
export function criarHandlerConectarCaixa({ admin, autenticar, iniciarSync }: Dependencias) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json({ success: false, error: 'Método não permitido.' }, 405);
    try {
      const auth = req.headers.get('Authorization');
      if (!auth) throw new Error('not_authenticated');
      const user = await autenticar(auth);
      if (!user) throw new Error('not_authenticated');

      const corpo = await req.json();
      if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) throw new Error('Pedido de cadastro inválido.');
      const { account_email, departamento_id, nome_exibicao, extra_roles, privado, pasta_id, responsavel_user_id } = corpo;
      if (typeof account_email !== 'string' || !account_email.trim() || typeof nome_exibicao !== 'string' || !nome_exibicao.trim()) {
        throw new Error('campos obrigatórios: account_email, nome_exibicao');
      }
      for (const [campo, valor] of Object.entries({ pasta_id, responsavel_user_id })) {
        if (valor != null && (typeof valor !== 'string' || !UUID.test(valor))) throw new Error(`${campo} inválido.`);
      }
      if (privado != null && typeof privado !== 'boolean') throw new Error('privado deve ser verdadeiro ou falso.');
      if (extra_roles != null && (!Array.isArray(extra_roles) || extra_roles.some((r: unknown) => typeof r !== 'string'))) {
        throw new Error('extra_roles deve ser uma lista de cargos.');
      }
      const email = account_email.trim().toLowerCase();
      const { data: roles, error: erroRoles } = await admin.from('user_roles').select('role').eq('user_id', user.id);
      if (erroRoles) throw new Error('Não foi possível conferir suas permissões.');
      const isAdmin = (roles || []).some((r: { role: string }) => r.role === 'admin' || r.role === 'diretor');
      const { data: solicitante, error: erroSolicitante } = await admin.from('profiles').select('ativo, departamento_id').eq('id', user.id).maybeSingle();
      if (erroSolicitante || solicitante?.ativo !== true) throw new Error('Somente usuários ativos podem conectar caixas.');
      if (responsavel_user_id && responsavel_user_id !== user.id && !isAdmin) {
        throw new Error('Somente admin ou diretor pode cadastrar uma caixa para outro usuário.');
      }

      // Uma conexão ativa não é tomada pelo novo cadastro. Nem a gestão pode
      // reabrir uma caixa privada alheia ou trocar seu proprietário neste fluxo.
      const { data: existente, error: erroExistente } = await admin.from('email_caixas_conectadas')
        .select('id, ativo, created_by, privado, pasta_id').eq('email_caixa', email).maybeSingle();
      if (erroExistente) throw new Error('Não foi possível conferir se a caixa já está cadastrada.');
      if (existente?.ativo) throw new Error('Esta caixa já está conectada.');
      if (existente && existente.created_by !== user.id && (existente.privado || !isAdmin)) {
        throw new Error(existente.privado
          ? 'Somente o proprietário pode reconectar esta caixa privada.'
          : 'Esta caixa já foi cadastrada por outra pessoa. Peça a ela (ou a um admin) para reconectar em Configurações → E-mails.');
      }
      if (existente && responsavel_user_id && responsavel_user_id !== existente.created_by) {
        throw new Error('A reconexão preserva o responsável original da caixa.');
      }
      if (existente && existente.created_by !== user.id && typeof privado === 'boolean' && privado !== existente.privado) {
        throw new Error('Somente o proprietário pode alterar a privacidade da caixa.');
      }

      const responsavelId = existente?.created_by ?? responsavel_user_id ?? user.id;
      const perfilResponsavel = responsavelId === user.id ? solicitante : await (async () => {
        const { data, error } = await admin.from('profiles').select('ativo, departamento_id').eq('id', responsavelId).maybeSingle();
        if (error) throw new Error('Não foi possível conferir o responsável da caixa.');
        return data;
      })();
      if (perfilResponsavel?.ativo !== true) throw new Error('O responsável da caixa precisa ser um usuário ativo.');

      const pastaId = pasta_id === undefined ? existente?.pasta_id ?? null : pasta_id;
      const privada = typeof privado === 'boolean' ? privado : existente?.privado === true;
      if (pastaId) {
        if (privada) throw new Error('Uma caixa privada não pode fazer parte de uma pasta compartilhada.');
        if (extra_roles?.length) throw new Error('Caixas em pastas são compartilhadas pela equipe. Remova as permissões extras por cargo.');
        const { data: pasta, error: erroPasta } = await admin.from('email_caixa_pastas')
          .select('id, departamento_id').eq('id', pastaId).maybeSingle();
        if (erroPasta || !pasta) throw new Error('Pasta de e-mail não encontrada.');
        if (!isAdmin) {
          const { data: visivel, error: erroVisivel } = await admin.rpc('email_pasta_visible', { _pasta_id: pastaId, _user_id: user.id });
          if (erroVisivel || visivel !== true) throw new Error('Você não tem acesso a esta pasta de e-mail.');
        }
        if (!pasta.departamento_id || perfilResponsavel.departamento_id !== pasta.departamento_id) {
          throw new Error('O responsável precisa pertencer à mesma equipe da pasta.');
        }
      }

      // Mantém a autorização Google anterior: gestão pode usar qualquer conexão
      // autorizada; demais usuários somente a própria integração pessoal.
      const { data: integrations, error: erroIntegracoes } = await admin.from('calendar_integrations')
        .select('id, scopes, oauth_refresh_token, is_active, created_at, scope, owner_user_id')
        .eq('account_email', email).eq('is_active', true).order('created_at', { ascending: false });
      if (erroIntegracoes) throw new Error('Não foi possível conferir a autorização Google.');
      if (!integrations?.length) throw new Error('Conta não autorizada. Use "Conectar nova conta Gmail" antes de cadastrar a caixa.');
      const permitidas = isAdmin ? integrations : integrations.filter((i: { scope: string; owner_user_id: string }) => i.scope === 'personal' && i.owner_user_id === user.id);
      if (!permitidas.length) {
        throw new Error('Você só pode conectar uma conta Google autorizada por você mesmo. Autorize sua conta na seção E-mail (Gestor de Tarefas) e tente de novo.');
      }
      const temGmail = (i: { scopes: unknown }) => typeof i.scopes === 'string' && i.scopes.includes('gmail.');
      const integ = permitidas.find((i: { oauth_refresh_token: string; scopes: unknown }) => i.oauth_refresh_token && temGmail(i))
        || permitidas.find((i: { oauth_refresh_token: string }) => i.oauth_refresh_token);
      if (!integ) throw new Error('Integração sem refresh token. Reautorize a conta antes de continuar.');
      if (!temGmail(integ)) throw new Error('Conta sem permissão de Gmail. Reautorize escolhendo "Conectar Gmail".');

      let caixa;
      if (existente) {
        const { data, error } = await admin.from('email_caixas_conectadas').update({
          ativo: true, nome_exibicao: nome_exibicao.trim(), calendar_integration_id: integ.id,
          pasta_id: pastaId, ...(typeof privado === 'boolean' ? { privado } : {}),
        }).eq('id', existente.id).eq('ativo', false).eq('created_by', existente.created_by)
          .eq('privado', existente.privado).select().maybeSingle();
        if (error) throw error;
        if (!data) throw new Error('A caixa foi alterada durante o cadastro. Atualize a lista antes de continuar.');
        caixa = data;
      } else {
        const { data, error } = await admin.from('email_caixas_conectadas').insert({
          calendar_integration_id: integ.id, email_caixa: email, nome_exibicao: nome_exibicao.trim(),
          departamento_id: pastaId ? null : departamento_id || null, pasta_id: pastaId,
          created_by: responsavelId, privado: privada,
        }).select().single();
        if (error) throw error;
        caixa = data;
      }
      let aviso: string | undefined;
      if (extra_roles?.length) {
        const { error } = await admin.from('email_caixa_permissoes').insert(extra_roles.map((role: string) => ({ caixa_id: caixa.id, role })));
        if (error) aviso = 'A caixa foi conectada, mas não foi possível salvar os cargos adicionais. Revise o compartilhamento.';
      }
      iniciarSync(caixa.id);
      return json({ success: true, caixa, ...(aviso ? { aviso } : {}) });
    } catch (e) {
      // Preserva o contrato dos consumidores existentes: erro funcional em JSON.
      return json({ success: false, error: e instanceof Error ? e.message : 'Não foi possível cadastrar a caixa.' });
    }
  };
}
