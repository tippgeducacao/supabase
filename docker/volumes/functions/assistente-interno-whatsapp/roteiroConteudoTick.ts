// Tick do roteiro de conteúdo (cron `assistente-roteiro-tick`, a cada 5 min, `?cron=roteiro`).
// A régua mora em roteiroConteudo.ts; aqui só banco, IA e envio.
//
// Quem recebe = assistente_roteiro_config (ativo); a grade = assistente_roteiro_semanal; o que o
// marketing planejou = marketing_posts do perfil (profile_key OU collab) no dia; a aula = ped_aulas
// das pós da config. Mudar grade, perfil ou pós é UPDATE, sem deploy.
//
// `?previa=AAAA-MM-DD` monta a mensagem daquele dia (IA incluída) e devolve no JSON, sem enviar e
// sem travar — é como se confere o texto de um dia sem esperar as 7h.
import { carregarLinha } from "./wa.ts";
import { addDiasYmd } from "./datas.ts";
import { getAnthropicKey, chamarOpus } from "./anthropic.ts";
import { avisarUmaVez, type DonoAgenda } from "./entrevistas.ts";
import {
  aulasDaNoite, chaveAoVivo, chaveRoteiro, diaDaSemana, escolherTopicos, itensDoDia, limparIdeias,
  naJanelaAoVivo, naJanelaRoteiro, promptIdeias, textoAoVivo, textoRoteiro,
  type AulaDoDia, type CardPlanner, type DadosRoteiro, type ItemGrade,
} from "./roteiroConteudo.ts";

/** A IA tem 60 s. Passou disso, a mensagem sai sem as ideias (a grade não espera). */
const TETO_IA_MS = 60_000;

interface DonoRoteiro extends DonoAgenda { perfil_key: string; pos_ids: string[] }

const spShift = (t: number) => new Date(t - 3 * 3600 * 1000); // Brasília = UTC-3, sem DST desde 2019

async function donosDoRoteiro(admin: any): Promise<DonoRoteiro[]> {
  const { data: cfg, error } = await admin.from("assistente_roteiro_config")
    .select("canon, perfil_key, pos_graduacao_ids").eq("ativo", true);
  if (error) throw new Error(`assistente_roteiro_config: ${error.message}`);
  if (!cfg?.length) return [];
  const { data: donos, error: e2 } = await admin.from("assistente_donos")
    .select("canon, nome, apelido").eq("ativo", true).in("canon", cfg.map((c: any) => c.canon));
  if (e2) throw new Error(`assistente_donos: ${e2.message}`);
  const porCanon = new Map(((donos ?? []) as DonoAgenda[]).map((d) => [d.canon, d]));
  return (cfg as any[]).filter((c) => porCanon.has(c.canon)).map((c) => ({
    ...porCanon.get(c.canon)!, perfil_key: c.perfil_key, pos_ids: c.pos_graduacao_ids ?? [],
  }));
}

async function gradeDoDia(admin: any, canon: string, ymd: string): Promise<ItemGrade[]> {
  const { data, error } = await admin.from("assistente_roteiro_semanal")
    .select("dia_semana, ordem, quando, o_que, formato, quem")
    .eq("canon", canon).eq("ativo", true).eq("dia_semana", diaDaSemana(ymd));
  if (error) throw new Error(`assistente_roteiro_semanal: ${error.message}`);
  return itensDoDia((data ?? []) as ItemGrade[], ymd);
}

/** Cards do Planner no dia: do perfil OU com o perfil em collab. */
async function cardsDoDia(admin: any, perfil: string, ymd: string): Promise<CardPlanner[]> {
  const { data, error } = await admin.from("marketing_posts")
    .select("title, format, status")
    .eq("ativo", true).eq("day_date", ymd)
    .or(`profile_key.eq.${perfil},collaborator_keys.cs.{${perfil}}`)
    .order("created_at").limit(20);
  if (error) throw new Error(`marketing_posts: ${error.message}`);
  return (data ?? []) as CardPlanner[];
}

/**
 * Aulas das pós da config no dia, menos as canceladas e o módulo prático (evento de dia inteiro
 * no campo, outra rotina). Aula de módulo compartilhado aparece 1 vez por pós: dedup por
 * título + horário + professor.
 */
async function aulasDoDia(admin: any, posIds: string[], ymd: string): Promise<AulaDoDia[]> {
  if (!posIds.length) return [];
  const { data, error } = await admin.from("ped_aulas")
    .select("id, horario, titulo, tipo_aula, cancelada, ementa, pos_graduacao_id, professor_id, professor_nome_manual")
    .in("pos_graduacao_id", posIds).eq("data", ymd);
  if (error) throw new Error(`ped_aulas: ${error.message}`);
  const aulas = ((data ?? []) as any[]).filter((a) => a.cancelada !== true && a.tipo_aula !== "pratico" && a.titulo);
  if (!aulas.length) return [];

  const profIds = [...new Set(aulas.map((a) => a.professor_id).filter(Boolean))];
  const profs = new Map<string, any>();
  if (profIds.length) {
    const { data: ps, error: e2 } = await admin.from("ped_professores")
      .select("id, nome, titulacao, curriculo_topicos").in("id", profIds);
    if (e2) throw new Error(`ped_professores: ${e2.message}`);
    for (const p of (ps ?? []) as any[]) profs.set(p.id, p);
  }
  const { data: cursos, error: e3 } = await admin.from("ped_pos_graduacoes")
    .select("id, nome").in("id", [...new Set(aulas.map((a) => a.pos_graduacao_id))]);
  if (e3) throw new Error(`ped_pos_graduacoes: ${e3.message}`);
  const nomeCurso = new Map(((cursos ?? []) as any[]).map((c) => [c.id, c.nome]));

  const vistos = new Set<string>();
  const saida: AulaDoDia[] = [];
  for (const a of aulas.sort((x, y) => String(x.horario ?? "").localeCompare(String(y.horario ?? "")))) {
    const p = a.professor_id ? profs.get(a.professor_id) : null;
    const professor = p?.nome ?? a.professor_nome_manual ?? null;
    const chave = `${String(a.titulo).trim().toLowerCase()}|${a.horario ?? ""}|${professor ?? ""}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push({
      id: a.id,
      titulo: String(a.titulo).trim(),
      horario: a.horario ?? null,
      curso: nomeCurso.get(a.pos_graduacao_id) ?? "pós",
      professor,
      titulacao: p?.titulacao ?? null,
      topicos: escolherTopicos(p?.curriculo_topicos),
      ementa: a.ementa ?? null,
    });
  }
  return saida;
}

async function montarDados(admin: any, dono: DonoRoteiro, ymd: string): Promise<DadosRoteiro> {
  const quarta = diaDaSemana(ymd) === 3;
  const [itens, cards, aulasHoje, aulasOntem] = await Promise.all([
    gradeDoDia(admin, dono.canon, ymd),
    cardsDoDia(admin, dono.perfil_key, ymd),
    aulasDoDia(admin, dono.pos_ids, ymd),
    quarta ? aulasDoDia(admin, dono.pos_ids, addDiasYmd(ymd, -1)) : Promise.resolve([]),
  ]);
  const apelido = (dono.apelido || (dono.nome || "").split(" ")[0] || "").trim();
  return { apelido, ymd, itens, cards, acompanhaAulas: dono.pos_ids.length > 0, aulasHoje, aulasOntem };
}

/** As 3 ideias da IA. Qualquer falha (sem chave, erro, recusa, teto de 60 s) = null, nunca lança. */
async function escreverIdeias(admin: any, d: DadosRoteiro): Promise<{ ideias: string | null; erro?: string }> {
  try {
    const key = await getAnthropicKey(admin);
    if (!key) return { ideias: null, erro: "sem chave anthropic" };
    const { system, user } = promptIdeias(d);
    const chamada = chamarOpus(key, { max_tokens: 2000, system, messages: [{ role: "user", content: user }] });
    const teto = new Promise<null>((r) => setTimeout(() => r(null), TETO_IA_MS));
    const resp: any = await Promise.race([chamada, teto]);
    if (!resp) return { ideias: null, erro: "ia passou de 60s" };
    if (resp.stop_reason === "refusal") return { ideias: null, erro: "ia recusou" };
    const txt = ((resp.content ?? []) as any[]).filter((b) => b?.type === "text").map((b) => b.text).join("\n");
    const ideias = limparIdeias(txt);
    return ideias ? { ideias } : { ideias: null, erro: "ia sem texto" };
  } catch (e) {
    return { ideias: null, erro: (e as Error).message.slice(0, 200) };
  }
}

async function jaAvisado(admin: any, chave: string): Promise<boolean> {
  const { data } = await admin.from("assistente_avisos").select("chave").eq("chave", chave).maybeSingle();
  return !!data;
}

export async function processarRoteiroConteudo(
  admin: any, opts: { previa?: string | null } = {},
): Promise<Record<string, unknown>> {
  // Prévia: o texto de um dia, sem enviar e sem travar.
  if (opts.previa) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.previa)) return { erro: "previa precisa ser AAAA-MM-DD" };
    const [dono] = await donosDoRoteiro(admin);
    if (!dono) return { erro: "nenhum dono em assistente_roteiro_config" };
    const dados = await montarDados(admin, dono, opts.previa);
    const { ideias, erro } = await escreverIdeias(admin, dados);
    const noite = aulasDaNoite(dados.aulasHoje)[0];
    return {
      previa: textoRoteiro(dados, ideias),
      ao_vivo: noite ? textoAoVivo(dados.apelido, noite) : null,
      ...(erro ? { erro_ia: erro } : {}),
    };
  }

  const sp = spShift(Date.now());
  const minuto = sp.getUTCHours() * 60 + sp.getUTCMinutes();
  const manha = naJanelaRoteiro(minuto);
  const noite = naJanelaAoVivo(minuto);
  if (!manha && !noite) return { roteiros: 0, ao_vivo: 0 }; // fora das janelas: nem consulta o banco

  const hoje = sp.toISOString().slice(0, 10);
  const donos = await donosDoRoteiro(admin);
  if (!donos.length) return { roteiros: 0, ao_vivo: 0 };
  const linha = await carregarLinha(admin);
  if (!linha) return { roteiros: 0, ao_vivo: 0, erros: ["sem linha WhatsApp ativa"] };

  let roteiros = 0, aoVivo = 0;
  const erros: string[] = [];
  for (const dono of donos) {
    try {
      if (manha && !(await jaAvisado(admin, chaveRoteiro(dono.canon, hoje)))) {
        const dados = await montarDados(admin, dono, hoje);
        const { ideias, erro } = await escreverIdeias(admin, dados);
        if (erro) erros.push(`ideias ${dono.canon}: ${erro}`);
        if (await avisarUmaVez(admin, linha, dono, chaveRoteiro(dono.canon, hoje), "roteiro_conteudo", textoRoteiro(dados, ideias))) roteiros++;
      }
      if (noite && dono.pos_ids.length && !(await jaAvisado(admin, chaveAoVivo(dono.canon, hoje)))) {
        const aula = aulasDaNoite(await aulasDoDia(admin, dono.pos_ids, hoje))[0];
        const apelido = (dono.apelido || (dono.nome || "").split(" ")[0] || "").trim();
        if (aula && await avisarUmaVez(admin, linha, dono, chaveAoVivo(dono.canon, hoje), "roteiro_ao_vivo", textoAoVivo(apelido, aula))) aoVivo++;
      }
    } catch (e) {
      erros.push(`${dono.canon}: ${(e as Error).message}`);
    }
  }
  return { roteiros, ao_vivo: aoVivo, ...(erros.length ? { erros } : {}) };
}
