// imap-connect-caixa: cadastra (ou testa) uma caixa IMAP/SMTP genérica.
//
// Qualquer usuário autenticado pode conectar a própria caixa (decisão do usuário em
// 2026-08-21). Diferente do Gmail, onde o Google guarda a senha e o sistema só recebe
// um token revogável, aqui a senha é armazenada cifrada. A autoria continua gravada em
// `created_by`, e a visibilidade segue a regra de caixa compartilhada/privada.
//
// `dry_run: true` só testa e devolve o diagnóstico — é o "Testar conexão" da tela.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { cifrar, chaveDoAmbiente } from '../_shared/imap/cripto.ts';
import { abrirImap } from '../_shared/imap/conexao.ts';
import {
  acharPastaEspecial,
  PASTAS_ARQUIVO,
  PASTAS_ENVIADOS,
  PASTAS_LIXEIRA,
  PASTAS_SPAM,
} from '../_shared/imap/client.ts';
import { abrirSmtp, classificarErro } from '../_shared/imap/caixa.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const responder = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const auth = req.headers.get('Authorization');
    if (!auth) throw new Error('not_authenticated');
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) throw new Error('not_authenticated');

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const body = await req.json();
    const email_caixa = String(body.email_caixa || '').trim().toLowerCase();
    const nome_exibicao = String(body.nome_exibicao || '').trim();
    const senha = String(body.senha || '');
    const usuario = String(body.usuario || email_caixa).trim();
    const imap_host = String(body.imap_host || '').trim();
    const smtp_host = String(body.smtp_host || '').trim();
    const imap_port = Number(body.imap_port || 993);
    const smtp_port = Number(body.smtp_port || 465);
    const imap_tls = body.imap_tls === 'starttls' ? 'starttls' : 'ssl';
    const smtp_tls = body.smtp_tls === 'starttls' ? 'starttls' : 'ssl';
    const dryRun = body.dry_run === true;

    if (!email_caixa || !imap_host || !smtp_host || !senha) {
      throw new Error('Campos obrigatórios: email_caixa, imap_host, smtp_host, senha.');
    }
    if (!dryRun && !nome_exibicao) throw new Error('Informe o nome de exibição da caixa.');

    // Caixa já existe? Repetir o UNIQUE em erro de banco daria uma mensagem feia.
    const { data: existente } = await admin
      .from('email_caixas_conectadas')
      .select('id, ativo, provider')
      .eq('email_caixa', email_caixa)
      .maybeSingle();
    if (existente && existente.ativo && !dryRun) {
      throw new Error('Esta caixa já está conectada.');
    }

    // ── 1) IMAP: login, pastas, INBOX ──────────────────────────────────────
    const sessao = await abrirImap({ host: imap_host, port: imap_port, tls: imap_tls }, usuario, senha);
    let pastas: { nome: string; flags: string[] }[] = [];
    let estado: { uidValidity: number; uidNext: number; total: number };
    try {
      pastas = await sessao.cliente.listarPastas();
      estado = await sessao.cliente.selecionar('INBOX');
    } finally {
      await sessao.fechar();
    }

    const pastaEnviados = String(body.pasta_enviados || '').trim()
      || acharPastaEspecial(pastas, '\\Sent', PASTAS_ENVIADOS);
    const pastaArquivo = String(body.pasta_arquivo || '').trim()
      || acharPastaEspecial(pastas, '\\Archive', PASTAS_ARQUIVO);
    // Lixeira e Spam são pastas PRÓPRIAS: sem elas, excluir viraria arquivar.
    const pastaLixeira = String(body.pasta_lixeira || '').trim()
      || acharPastaEspecial(pastas, '\\Trash', PASTAS_LIXEIRA);
    const pastaSpam = String(body.pasta_spam || '').trim()
      || acharPastaEspecial(pastas, '\\Junk', PASTAS_SPAM);

    // ── 2) SMTP: autenticar AGORA, não na primeira resposta ────────────────
    // Senha de SMTP errada só apareceria quando alguém tentasse responder — e aí
    // o erro chega como "não consegui enviar", longe da tela de cadastro.
    const smtp = await abrirSmtp({ smtp_host, smtp_port, smtp_tls, usuario }, senha);
    await smtp.fechar();

    const diagnostico = {
      ok: true,
      pastas: pastas.map((p) => p.nome),
      pasta_enviados: pastaEnviados,
      pasta_arquivo: pastaArquivo,
      pasta_lixeira: pastaLixeira,
      pasta_spam: pastaSpam,
      uid_validity: estado.uidValidity,
      mensagens_na_inbox: estado.total,
      aviso: pastaEnviados
        ? null
        : 'Não achei a pasta de Enviados nesse servidor. O envio vai funcionar, mas não ficará registrado nos Enviados do webmail.',
    };

    if (dryRun) return responder(diagnostico);

    // ── 3) Grava ───────────────────────────────────────────────────────────
    const senhaCifrada = await cifrar(senha, await chaveDoAmbiente());

    let caixaId: string;
    if (existente) {
      // Reconecta a que estava desativada em vez de duplicar — mesmo espírito do Gmail.
      const { error } = await admin
        .from('email_caixas_conectadas')
        .update({
          ativo: true,
          nome_exibicao,
          provider: 'imap',
          // Caixa que ERA Gmail e virou IMAP carrega o vínculo antigo com o Google.
          // Deixá-lo preenchido faz o `gmail-sync-inbox` continuar varrendo esta
          // caixa e errar a cada 2 minutos, além de gastar rodada de cron à toa.
          calendar_integration_id: null,
          departamento_id: body.departamento_id ?? null,
          privado: body.privado === true,
          last_sync_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existente.id);
      if (error) throw new Error(error.message);
      caixaId = existente.id;
    } else {
      const { data, error } = await admin
        .from('email_caixas_conectadas')
        .insert({
          email_caixa,
          nome_exibicao,
          provider: 'imap',
          calendar_integration_id: null,
          departamento_id: body.departamento_id ?? null,
          privado: body.privado === true,
          created_by: user.id,
        })
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      caixaId = data.id;
    }

    // Reconectando uma caixa que já tinha config: se o servidor renumerou a INBOX,
    // o ponteiro guardado passou a apontar para OUTRAS mensagens. Gravar o
    // UIDVALIDITY novo por cima e manter o `ultimo_uid` velho desarmaria justamente
    // a trava que o sync usa para perceber isso — e o sync nunca mais compararia,
    // porque os dois números já chegariam iguais.
    const { data: configAnterior } = await admin
      .from('email_caixa_imap_config')
      .select('uid_validity, pasta_enviados')
      .eq('caixa_id', caixaId)
      .maybeSingle();

    const renumerou = !!configAnterior
      && Number(configAnterior.uid_validity ?? 0) !== Number(estado.uidValidity);
    const mudouEnviados = !!configAnterior && (configAnterior.pasta_enviados ?? null) !== (pastaEnviados ?? null);

    const { error: erroConfig } = await admin
      .from('email_caixa_imap_config')
      .upsert({
        caixa_id: caixaId,
        imap_host, imap_port, imap_tls,
        smtp_host, smtp_port, smtp_tls,
        usuario,
        senha_cifrada: senhaCifrada,
        pasta_enviados: pastaEnviados,
        pasta_arquivo: pastaArquivo,
        pasta_lixeira: pastaLixeira,
        pasta_spam: pastaSpam,
        uid_validity: estado.uidValidity,
        ...(renumerou ? { ultimo_uid: 0 } : {}),
        ...(renumerou || mudouEnviados ? { ultimo_uid_enviados: 0, uid_validity_enviados: null } : {}),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'caixa_id' });
    if (erroConfig) throw new Error(erroConfig.message);

    // Sync inicial em segundo plano — a tela não espera por ele.
    fetch(`${SUPABASE_URL}/functions/v1/imap-sync-inbox`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ caixa_id: caixaId, inicial: true }),
    }).catch(() => { /* o cron pega no próximo ciclo */ });

    return responder({ ...diagnostico, caixa_id: caixaId });
  } catch (e) {
    const { estado, recado } = classificarErro(e);
    return responder({ ok: false, estado, error: recado || (e as Error).message }, 200);
  }
});
