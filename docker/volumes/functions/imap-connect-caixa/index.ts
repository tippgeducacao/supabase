// imap-connect-caixa: cadastra (ou testa) uma caixa IMAP/SMTP genérica.
//
// Qualquer usuário autenticado pode conectar a própria caixa (decisão do usuário em
// 2026-08-21). Diferente do Gmail, onde o Google guarda a senha e o sistema só recebe
// um token revogável, aqui a senha é armazenada cifrada. A autoria continua gravada em
// `created_by`, e a visibilidade segue a regra de caixa compartilhada/privada.
//
// `dry_run: true` só testa e devolve o diagnóstico — é o "Testar conexão" da tela.
//
// `caixa_id` = EDITAR a conexão de uma caixa que já existe (28/09/2026, depois da migração
// de cPanel que deixou as caixas lendo o servidor antigo). Só quem GERE a caixa
// (`email_caixa_can_manage`) edita; senha em branco reaproveita a guardada; nome,
// privacidade e setor não mudam por aqui.
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
import { abrirSmtp, carregarConfig, classificarErro, senhaDaConfig } from '../_shared/imap/caixa.ts';
import { resolvedorDaPlataforma, verificarServidorDoDominio } from '../_shared/imap/servidorDoDominio.ts';

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

    // ── Edição: a caixa manda, não o corpo do pedido ─────────────────────────
    const caixaIdEdicao = body.caixa_id ? String(body.caixa_id) : null;
    let caixaEdicao: { id: string; email_caixa: string; created_by: string | null } | null = null;
    let configEdicao: Awaited<ReturnType<typeof carregarConfig>> | null = null;
    if (caixaIdEdicao) {
      const { data: c } = await admin
        .from('email_caixas_conectadas')
        .select('id, email_caixa, provider, created_by')
        .eq('id', caixaIdEdicao)
        .maybeSingle();
      if (!c || c.provider !== 'imap') throw new Error('Caixa IMAP não encontrada.');
      // Mesma régua da RLS: em caixa privada só o dono; nas compartilhadas, dono,
      // admin/diretor e chefe do setor. A tela esconde o botão, mas quem decide é aqui.
      const { data: pode, error: erroPode } = await admin.rpc('email_caixa_can_manage', {
        _caixa_id: c.id, _user_id: user.id,
      });
      if (erroPode || pode !== true) throw new Error('Você não pode editar a conexão desta caixa.');
      caixaEdicao = c;
      configEdicao = await carregarConfig(admin, c.id);
    }

    const email_caixa = caixaEdicao
      ? String(caixaEdicao.email_caixa).trim().toLowerCase()
      : String(body.email_caixa || '').trim().toLowerCase();
    const nome_exibicao = String(body.nome_exibicao || '').trim();
    const usuario = String(body.usuario || email_caixa).trim();
    const imap_host = String(body.imap_host || '').trim();
    const smtp_host = String(body.smtp_host || '').trim();
    // Senha em branco na edição = a que já está guardada (quem só troca o servidor não
    // precisa redigitar — e muitas vezes nem sabe de cabeça).
    // ⚠️ SÓ para o DONO, ou sem trocar de servidor. A senha guardada é enviada ao host
    // informado aqui: se admin/chefe de setor (que gerem caixas compartilhadas alheias)
    // pudesse apontar o host para uma máquina própria com a senha em branco, o sistema
    // entregaria a senha de outra pessoa. O dono já sabe a própria senha.
    const mesmosServidores = !!configEdicao
      && configEdicao.imap_host.trim().toLowerCase() === imap_host.toLowerCase()
      && configEdicao.smtp_host.trim().toLowerCase() === smtp_host.toLowerCase();
    const podeReusarSenha = !!configEdicao && (caixaEdicao?.created_by === user.id || mesmosServidores);
    let senha = String(body.senha || '');
    if (!senha && configEdicao) {
      if (!podeReusarSenha) {
        throw new Error('Para trocar o servidor de uma caixa que não é sua, digite a senha da caixa.');
      }
      senha = await senhaDaConfig(configEdicao);
    }
    const imap_port = Number(body.imap_port || 993);
    const smtp_port = Number(body.smtp_port || 465);
    const imap_tls = body.imap_tls === 'starttls' ? 'starttls' : 'ssl';
    const smtp_tls = body.smtp_tls === 'starttls' ? 'starttls' : 'ssl';
    const dryRun = body.dry_run === true;

    if (!email_caixa || !imap_host || !smtp_host || !senha) {
      throw new Error('Campos obrigatórios: email_caixa, imap_host, smtp_host, senha.');
    }
    if (!dryRun && !caixaEdicao && !nome_exibicao) throw new Error('Informe o nome de exibição da caixa.');

    // Caixa já existe? Repetir o UNIQUE em erro de banco daria uma mensagem feia.
    const { data: existente } = await admin
      .from('email_caixas_conectadas')
      .select('id, ativo, provider')
      .eq('email_caixa', email_caixa)
      .maybeSingle();
    if (existente && existente.ativo && !dryRun && !caixaEdicao) {
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

    // Numeração guardada × a do servidor que respondeu agora. Só informa a tela: quem
    // AGE sobre isso é o sync (ver o bloco de gravação abaixo).
    const { data: configAnterior } = existente
      ? await admin
        .from('email_caixa_imap_config')
        .select('uid_validity')
        .eq('caixa_id', existente.id)
        .maybeSingle()
      : { data: null };
    const servidorRenumerou = !!configAnterior?.uid_validity
      && Number(configAnterior.uid_validity) !== Number(estado.uidValidity);

    // O domínio entrega e-mail no servidor que está sendo cadastrado? Foi o que
    // faltou perceber na migração de cPanel de 28/09/2026.
    const alertaServidor = await verificarServidorDoDominio(email_caixa, imap_host, resolvedorDaPlataforma());

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
      servidor_renumerou: servidorRenumerou,
      alerta_servidor: alertaServidor,
    };

    if (dryRun) return responder(diagnostico);

    // ── 3) Grava ───────────────────────────────────────────────────────────
    const senhaCifrada = await cifrar(senha, await chaveDoAmbiente());

    let caixaId: string;
    if (caixaEdicao) {
      // Editar a conexão não mexe em nome, privacidade nem setor — só zera o estado de
      // saúde para o próximo sync reavaliar do zero.
      const { error } = await admin
        .from('email_caixas_conectadas')
        .update({
          last_sync_error: null,
          alerta_conexao: alertaServidor,
          alerta_verificado_em: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', caixaEdicao.id);
      if (error) throw new Error(error.message);
      caixaId = caixaEdicao.id;
    } else if (existente) {
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
          alerta_conexao: alertaServidor,
          alerta_verificado_em: new Date().toISOString(),
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
          alerta_conexao: alertaServidor,
          alerta_verificado_em: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      caixaId = data.id;
    }

    // ⚠️ Caixa que JÁ tinha config (reconectar ou editar): a numeração guardada
    // (`uid_validity`, `uid_validity_enviados`) NÃO é sobrescrita aqui. É ela que o sync
    // compara com a do servidor na próxima rodada: se mudou, ele aposenta as chaves da
    // numeração antiga (`email_imap_aposentar_chaves`) e ressincroniza do topo. Gravar o
    // número novo aqui desarmaria essa trava — e o sync passaria a pular todo e-mail novo
    // cujo UID coincidisse com o de uma mensagem antiga (a chave `imap:<caixa>:<pasta>:<uid>`
    // já existiria). Foi o que a troca de servidor da migração de cPanel teria causado.
    // Pasta de Enviados que mudou de nome cai na mesma régua: a numeração da pasta nova
    // não bate com a guardada.
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
        ...(configAnterior ? {} : { uid_validity: estado.uidValidity }),
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
