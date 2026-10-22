// QUANDO cada mensagem da gravação de podcast sai — lógica pura, testada à parte. Quem envia
// é a edge pod-gravacao-lembretes (cron de 15 em 15 min + chamada na hora do clique).
//
// Régua do guia "Automações do Podcast no Sistema PPG" da equipe (22/10/2026; antes, 14/10), sempre
// no horário de Brasília:
//  · nada sai enquanto o agendamento espera a VALIDAÇÃO da equipe (aviso do Calendly);
//  · validado: grav_recebido + host_recebido — na hora (confirmação ao convidado e ao host);
//  · dados confirmados (briefing salvo): os lembretes —
//      convidado: 7 dias e 3 dias antes às 9h, véspera às 10h, no dia às 8h;
//      host: 15, 7 e 3 dias antes às 9h (o de 3 dias leva o briefing), véspera às 10h e no dia às 8h
//      (esses dois levam a sala do Zencastr). O do dia começa com "Bom dia": gravação antes das 9h
//      não recebe — fica só a véspera;
//  · agrad_* — ao marcar "Gravado".
// Lembrete cujo horário já passou quando os dados foram confirmados ⇒ pula. Cada lembrete tem uma
// JANELA até o próximo: cron parado não faz sair, às 23h, o lembrete das 9h.

export type ChaveLembrete =
  | "grav_recebido" | "host_recebido"
  | "host_15d" | "grav_7d" | "host_7d" | "grav_3d" | "host_3d" | "grav_1d" | "host_1d" | "grav_dia" | "host_dia"
  | "grav_5d" // régua de 14/10 a 22/10/2026 — só para mostrar o que já saiu
  | "agrad_convidado" | "agrad_host";

export const LEMBRETES: Record<ChaveLembrete, { uso: string; destino: "convidado" | "host"; rotulo: string }> = {
  grav_recebido: { uso: "podcast_grav_recebido", destino: "convidado", rotulo: "Confirmação" },
  host_recebido: { uso: "podcast_host_recebido", destino: "host", rotulo: "Host · confirmação" },
  host_15d: { uso: "podcast_host_15d", destino: "host", rotulo: "Host · 15 dias" },
  grav_7d: { uso: "podcast_grav_7d", destino: "convidado", rotulo: "7 dias antes" },
  host_7d: { uso: "podcast_host_7d", destino: "host", rotulo: "Host · 7 dias" },
  grav_3d: { uso: "podcast_grav_3d", destino: "convidado", rotulo: "3 dias antes" },
  host_3d: { uso: "podcast_host_3d", destino: "host", rotulo: "Host · 3 dias (briefing)" },
  grav_1d: { uso: "podcast_grav_1d", destino: "convidado", rotulo: "Véspera" },
  host_1d: { uso: "podcast_host_1d", destino: "host", rotulo: "Host · véspera" },
  grav_dia: { uso: "podcast_grav_dia", destino: "convidado", rotulo: "No dia" },
  host_dia: { uso: "podcast_host_dia", destino: "host", rotulo: "Host · no dia" },
  grav_5d: { uso: "podcast_grav_5d", destino: "convidado", rotulo: "5 dias antes (régua antiga)" },
  agrad_convidado: { uso: "podcast_agrad_convidado", destino: "convidado", rotulo: "Agradecimento" },
  agrad_host: { uso: "podcast_agrad_host", destino: "host", rotulo: "Host · agradecimento" },
};

export interface AgendamentoPlano {
  status: string;
  inicio: string;
  agendado_em: string;
  /** a equipe validou (botão Validar); registro à mão já nasce validado */
  validado_em?: string | null;
  /** briefing salvo e dados conferidos: só daqui em diante os lembretes são programados */
  dados_confirmados_em?: string | null;
  gravado_em?: string | null;
  lembretes?: Record<string, any> | null;
}

export interface PassoPlano { chave: ChaveLembrete; acao: "enviar" | "pular"; motivo?: string }

const TZ = "America/Sao_Paulo";

/** Dia (AAAA-MM-DD) no horário de Brasília. */
export function diaBR(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Instante "dia − diasAntes, às hora:00" em Brasília. -03:00 fixo: o Brasil não tem horário de verão desde 2019. */
export function emBR(dia: string, hora: number, diasAntes = 0): Date {
  const base = new Date(`${dia}T12:00:00-03:00`);
  base.setUTCDate(base.getUTCDate() - diasAntes);
  const d = diaBR(base);
  return new Date(`${d}T${String(hora).padStart(2, "0")}:00:00-03:00`);
}

/** "quarta-feira, 21 de outubro" */
export function dataBR(d: Date): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }).format(d);
}

/** "14h" ou "14h30" */
export function horaBR(d: Date): string {
  const p = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const h = String(Number(p.find((x) => x.type === "hour")?.value ?? "0"));
  const m = p.find((x) => x.type === "minute")?.value ?? "00";
  return m === "00" ? `${h}h` : `${h}h${m}`;
}

function encerrado(l: any): boolean {
  if (!l) return false;
  if (l.status === "enviado" || l.status === "pulado") return true;
  return l.status === "falhou" && Number(l.tentativas ?? 0) >= 3;
}

export function planoDeLembretes(a: AgendamentoPlano, agora: Date): PassoPlano[] {
  const feitos = a.lembretes ?? {};
  const passos: PassoPlano[] = [];
  const add = (chave: ChaveLembrete, acao: "enviar" | "pular", motivo?: string) => {
    if (!encerrado(feitos[chave])) passos.push({ chave, acao, motivo });
  };

  const inicio = new Date(a.inicio);
  const dia = diaBR(inicio);

  if (a.status === "agendado") {
    if (agora >= inicio) return passos; // já começou: nada antes da gravação faz sentido
    if (!a.validado_em) return passos;  // ainda espera a validação da equipe
    add("grav_recebido", "enviar");
    add("host_recebido", "enviar");
    if (!a.dados_confirmados_em) return passos; // os lembretes só depois dos dados confirmados

    const base = new Date(a.dados_confirmados_em);
    const datados: Array<[ChaveLembrete, Date, Date]> = [
      ["host_15d", emBR(dia, 9, 15), emBR(dia, 9, 7)],
      ["grav_7d", emBR(dia, 9, 7), emBR(dia, 9, 3)],
      ["host_7d", emBR(dia, 9, 7), emBR(dia, 9, 3)],
      ["grav_3d", emBR(dia, 9, 3), emBR(dia, 10, 1)],
      ["host_3d", emBR(dia, 9, 3), emBR(dia, 10, 1)],
      ["grav_1d", emBR(dia, 10, 1), emBR(dia, 8, 0)],
      ["host_1d", emBR(dia, 10, 1), emBR(dia, 8, 0)],
      ["grav_dia", emBR(dia, 8, 0), inicio],
      ["host_dia", emBR(dia, 8, 0), inicio],
    ];
    for (const [chave, quando, ate] of datados) {
      if ((chave === "grav_dia" || chave === "host_dia") && inicio < emBR(dia, 9, 0)) {
        add(chave, "pular", "gravação antes das 9h");
      } else if (base > quando) {
        add(chave, "pular", "os dados foram confirmados depois do horário deste lembrete");
      } else if (agora >= ate) {
        add(chave, "pular", "o horário passou");
      } else if (agora >= quando) {
        add(chave, "enviar");
      }
    }
    return passos;
  }

  if (a.status === "gravado" && a.gravado_em) {
    add("agrad_convidado", "enviar");
    add("agrad_host", "enviar"); // a regra do "hoje" do texto antigo fica com agradHostPula (sabe o modelo)
  }
  return passos;
}

/**
 * O agradecimento ao host antigo (`agrad_host_podcast`) diz "o episódio de hoje": marcado "Gravado" em
 * outro dia, ele não sai. O do guia (`agrad_host_podcast_v2`, "o episódio com <convidado>") sai sempre.
 */
export function agradHostPula(nomeModelo: string | null | undefined, inicio: string, gravadoEm: string | null | undefined): boolean {
  if (nomeModelo !== "agrad_host_podcast") return false;
  return !gravadoEm || diaBR(new Date(gravadoEm)) !== diaBR(new Date(inicio));
}
