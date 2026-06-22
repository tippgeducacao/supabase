// ============================================================================
// ppgbet-sync — sincroniza os jogos do Brasil (Copa 2026) para o PPGBET.
// ============================================================================
// O provider externo fica atrás da interface `MatchProvider` (trocável sem
// reescrever o resto). Default: football-data.org (free, inclui a Copa FIFA).
//
// Fluxo: busca jogos do Brasil → upsert em ppgbet_partidas (status + placar).
// Ao virar 'encerrado' com placar, o TRIGGER do banco pontua sozinho
// (ppgbet_pontuar_partida, idempotente) — esta função NÃO calcula pontos.
//
// Secrets (env da edge, NUNCA no front):
//   PPGBET_API_KEY  — chave do provider (football-data.org → header X-Auth-Token)
//   PPGBET_PROVIDER — opcional, default 'football-data'
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — injetados pelo runtime
//
// ⚠️ Simplificação documentada: usamos score.fullTime do provider. Em mata-mata,
// alguns provedores incluem prorrogação no fullTime — a regra do bolão é
// pontuar pelo TEMPO REGULAMENTAR; se o provider não separar, é uma limitação
// conhecida (ajustável trocando o mapeamento de placar abaixo).
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const API_KEY = Deno.env.get('PPGBET_API_KEY') ?? '';
const PROVIDER = Deno.env.get('PPGBET_PROVIDER') ?? 'football-data';

// Status canônico do bolão.
type BetStatus = 'agendado' | 'ao_vivo' | 'encerrado' | 'adiado' | 'cancelado';

interface ProviderMatch {
  providerMatchId: string;
  timeCasa: string;
  timeFora: string;
  dataHora: string;        // ISO
  status: BetStatus;
  placarCasa: number | null;
  placarFora: number | null;
  rodadaNome: string | null;
}

interface MatchProvider {
  readonly nome: string;
  fetchBrazilMatches(): Promise<ProviderMatch[]>;
}

// ---------------------------------------------------------------------------
// football-data.org — Copa do Mundo (competition id 2000), Brasil (team 764)
// ---------------------------------------------------------------------------
const FD_BASE = 'https://api.football-data.org/v4';
const FD_WORLD_CUP = 2000;

function mapFootballDataStatus(s: string): BetStatus {
  switch (s) {
    case 'IN_PLAY':
    case 'PAUSED':
      return 'ao_vivo';
    case 'FINISHED':
    case 'AWARDED':
      return 'encerrado';
    case 'POSTPONED':
      return 'adiado';
    case 'SUSPENDED':
    case 'CANCELLED':
      return 'cancelado';
    default: // SCHEDULED, TIMED
      return 'agendado';
  }
}

function isBrazil(name: string | undefined): boolean {
  const n = (name ?? '').toLowerCase();
  return n.includes('brazil') || n.includes('brasil');
}

class FootballDataProvider implements MatchProvider {
  readonly nome = 'football-data';
  constructor(private apiKey: string) {}

  async fetchBrazilMatches(): Promise<ProviderMatch[]> {
    const res = await fetch(`${FD_BASE}/competitions/${FD_WORLD_CUP}/matches`, {
      headers: { 'X-Auth-Token': this.apiKey },
    });
    if (res.status === 429) throw new Error('rate_limit (football-data 10 req/min)');
    if (!res.ok) throw new Error(`football-data ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const matches: any[] = json.matches ?? [];

    return matches
      .filter((m) => isBrazil(m?.homeTeam?.name) || isBrazil(m?.awayTeam?.name))
      .map((m) => {
        const ft = m?.score?.fullTime ?? {};
        const finished = mapFootballDataStatus(m.status) === 'encerrado';
        const rodadaNome = m.stage && m.stage !== 'GROUP_STAGE'
          ? String(m.stage).replaceAll('_', ' ')
          : (m.matchday ? `Fase de Grupos — Rodada ${m.matchday}` : null);
        return {
          providerMatchId: String(m.id),
          timeCasa: m?.homeTeam?.name ?? '—',
          timeFora: m?.awayTeam?.name ?? '—',
          dataHora: m.utcDate,
          status: mapFootballDataStatus(m.status),
          placarCasa: finished && ft.home != null ? Number(ft.home) : null,
          placarFora: finished && ft.away != null ? Number(ft.away) : null,
          rodadaNome,
        } as ProviderMatch;
      })
      .sort((a, b) => a.dataHora.localeCompare(b.dataHora));
  }
}

function getProvider(): MatchProvider {
  switch (PROVIDER) {
    case 'football-data':
    default:
      return new FootballDataProvider(API_KEY);
  }
}

// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    if (!API_KEY) {
      return new Response(JSON.stringify({ error: 'PPGBET_API_KEY não configurada' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const provider = getProvider();
    const jogos = await provider.fetchBrazilMatches();

    // Próxima rodada a atribuir para partidas novas (mantém as existentes estáveis).
    const { data: maxRow } = await admin
      .from('ppgbet_partidas')
      .select('rodada')
      .order('rodada', { ascending: false })
      .limit(1)
      .maybeSingle();
    let proximaRodada = ((maxRow?.rodada as number) ?? 0) + 1;

    const resultados: any[] = [];
    for (const j of jogos) {
      try {
        const { data: existente } = await admin
          .from('ppgbet_partidas')
          .select('id, rodada')
          .eq('provider', provider.nome)
          .eq('provider_match_id', j.providerMatchId)
          .maybeSingle();

        if (existente) {
          const { error } = await admin
            .from('ppgbet_partidas')
            .update({
              time_casa: j.timeCasa,
              time_fora: j.timeFora,
              data_hora: j.dataHora,
              status: j.status,
              placar_casa: j.placarCasa,
              placar_fora: j.placarFora,
              rodada_nome: j.rodadaNome,
            })
            .eq('id', existente.id);
          if (error) throw error;
          resultados.push({ match: j.providerMatchId, acao: 'atualizado' });
        } else {
          const { error } = await admin
            .from('ppgbet_partidas')
            .insert({
              rodada: proximaRodada++,
              rodada_nome: j.rodadaNome,
              time_casa: j.timeCasa,
              time_fora: j.timeFora,
              data_hora: j.dataHora,
              status: j.status,
              placar_casa: j.placarCasa,
              placar_fora: j.placarFora,
              provider: provider.nome,
              provider_match_id: j.providerMatchId,
            });
          if (error) throw error;
          resultados.push({ match: j.providerMatchId, acao: 'criado' });
        }
      } catch (e) {
        resultados.push({ match: j.providerMatchId, ok: false, erro: (e as Error).message });
      }
    }

    return new Response(JSON.stringify({
      provider: provider.nome,
      jogos_encontrados: jogos.length,
      resultados,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('[ppgbet-sync]', err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
