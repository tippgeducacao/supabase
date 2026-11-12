import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { exigirAcesso, respostaAcessoNegado } from '../_shared/acesso.ts';
import { getSegredo } from '../_shared/segredos.ts';

/**
 * A ponte entre a PÁGINA PÚBLICA de indicação de colaboradores (projeto Lovable, um link por
 * colaborador: indicar.ppgvet.com.br/<codigo>) e o funil RH E CONTRATAÇÃO.
 *
 * Quem chama é o SERVIDOR da página (server function), nunca o navegador do visitante: a
 * chave `x-indicacao-chave` fica no servidor da Lovable e aqui em `app_secrets`
 * (RH_INDICACAO_PAGINA_CHAVE). O banco só deixa `service_role` executar as duas funções.
 *
 * Ações:
 *   colaborador { codigo }                           -> nome, primeiro nome, foto, setor e a
 *                                                       lista de setores do formulário
 *   cadastrar   { codigo, nome, telefone, ddi, setor } -> indicação em nome do dono do link
 *
 * A resposta é ENXUTA de propósito: a página é pública. Nada de nome do contato que já
 * existia no CRM, de "já estava em processo" ou de texto de erro do banco, que contariam a
 * um estranho quem está na base digitando telefones.
 *
 * Mapa: docs/RH — Processo Seletivo.md › "Indicação de colaboradores".
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  ...corsHeaders,
  'Access-Control-Allow-Headers': `${corsHeaders['Access-Control-Allow-Headers']}, x-indicacao-chave`,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

const texto = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const CODIGO = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** O que a página pode saber de cada recusa do banco. */
const MOTIVOS_PUBLICOS = new Set(['link', 'nome', 'telefone', 'setor', 'limite']);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, motivo: 'metodo' }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  try {
    await exigirAcesso(req, {
      segredo: { cabecalho: 'x-indicacao-chave', valor: await getSegredo(admin, 'RH_INDICACAO_PAGINA_CHAVE') },
    });
  } catch (e) {
    return respostaAcessoNegado(e, cors);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const acao = texto(body?.acao, 20);
    const codigo = texto(body?.codigo, 60).toLowerCase();
    if (!CODIGO.test(codigo)) return json({ ok: false, motivo: 'link' });

    if (acao === 'colaborador') {
      const { data, error } = await admin.rpc('rh_indicacao_pagina_publica', { p_codigo: codigo });
      if (error) throw error;
      if (!data?.ok) return json({ ok: false, motivo: 'link' });
      return json({
        ok: true,
        nome: data.nome,
        primeiro_nome: data.primeiro_nome,
        foto: data.foto ?? null,
        departamento: data.departamento ?? null,
        setores: Array.isArray(data.setores) ? data.setores : [],
      });
    }

    if (acao === 'cadastrar') {
      const nome = texto(body?.nome, 120);
      const telefone = texto(body?.telefone, 30);
      const ddi = texto(body?.ddi, 4).replace(/\D/g, '') || '55';
      const setor = texto(body?.setor, 80) || null;
      if (nome.length < 2) return json({ ok: false, motivo: 'nome' });
      if (telefone.replace(/\D/g, '').length < 8) return json({ ok: false, motivo: 'telefone' });

      const { data, error } = await admin.rpc('rh_indicacao_pagina_cadastrar', {
        p_codigo: codigo,
        p_nome: nome,
        p_telefone: telefone,
        p_ddi: ddi,
        p_setor: setor,
      });
      if (error) throw error;
      // "Repetida" é sucesso para quem está na página: a indicação já existe e vale.
      if (data?.ok || data?.motivo === 'repetida') return json({ ok: true });
      const motivo = String(data?.motivo ?? 'falhou');
      return json({ ok: false, motivo: MOTIVOS_PUBLICOS.has(motivo) ? motivo : 'falhou' });
    }

    return json({ ok: false, motivo: 'acao' }, 400);
  } catch (e) {
    console.error('[rh-indicacao-publica]', e instanceof Error ? e.message : e);
    return json({ ok: false, motivo: 'falhou' }, 500);
  }
});
