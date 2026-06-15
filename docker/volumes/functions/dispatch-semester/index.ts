import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { areas, modo, mes_inicio, mes_fim } = await req.json();

    if (!Array.isArray(areas) || !mes_inicio || !mes_fim) {
      return new Response(JSON.stringify({ ok: false, error: 'parametros invalidos' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Query aulas no periodo, opcionalmente filtradas por areas
    let q = supabase
      .from('ped_aulas')
      .select('id, professor_id, data, titulo, pos_graduacao_id, ped_pos_graduacoes!inner(area_id)')
      .gte('data', mes_inicio)
      .lte('data', mes_fim)
      .not('professor_id', 'is', null);

    if (areas.length > 0) {
      // @ts-ignore filter on related
      q = q.in('ped_pos_graduacoes.area_id', areas);
    }

    const { data: aulas, error } = await q;
    if (error) throw error;

    // Agrupar por professor
    const porProf = new Map<string, any[]>();
    (aulas ?? []).forEach((a: any) => {
      const arr = porProf.get(a.professor_id) ?? [];
      arr.push(a);
      porProf.set(a.professor_id, arr);
    });

    const profsProcessados = porProf.size;
    const pdfsGerados = porProf.size; // STUB
    const tasksCriadas = porProf.size; // STUB
    const disparosAgendados = (aulas?.length ?? 0) * 5; // 5 estagios por aula

    return new Response(
      JSON.stringify({
        ok: true,
        stub: true,
        modo,
        relatorio: {
          profs_processados: profsProcessados,
          pdfs_gerados: pdfsGerados,
          tasks_criadas: tasksCriadas,
          disparos_agendados: disparosAgendados,
        },
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error';
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
