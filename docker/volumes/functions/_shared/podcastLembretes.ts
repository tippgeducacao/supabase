// QUANDO cada mensagem da gravação de podcast sai — lógica pura, testada à parte. Quem envia
// é a edge pod-gravacao-lembretes (cron de 15 em 15 min + chamada na hora do clique).
//
// Régua (decisão de 14/10/2026), sempre no horário de Brasília:
//  · grav_recebido   — na hora do agendamento (convidado)
//  · grav_5d         — 5 dias antes, 9h (convidado)
//  · grav_1d/host_1d — véspera, 10h (convidado e host)
//  · grav_dia/host_dia — no dia, 8h (convidado e host); o texto começa com "Bom dia", então
//    gravação antes das 9h não recebe — fica só a véspera
//  · agrad_*         — ao marcar "Gravado"; o do host diz "o episódio de hoje", então só sai
//    se marcado no mesmo dia da gravação
// Marcou com menos antecedência que o lembrete (agendado DEPOIS do horário dele) ⇒ pula.
// Cada lembrete tem uma JANELA até o próximo: cron parado não faz sair, às 23h, o lembrete
// das 9h.

export type ChaveLembrete =
  | "grav_recebido" | "grav_5d" | "grav_1d" | "grav_dia" | "host_1d" | "host_dia"
  | "agrad_convidado" | "agrad_host";

export const LEMBRETES: Record<ChaveLembrete, { uso: string; destino: "convidado" | "host"; rotulo: string }> = {
  grav_recebido: { uso: "podcast_grav_recebido", destino: "convidado", rotulo: "Confirmação" },
  grav_5d: { uso: "podcast_grav_5d", destino: "convidado", rotulo: "5 dias antes" },
  grav_1d: { uso: "podcast_grav_1d", destino: "convidado", rotulo: "Véspera" },
  grav_dia: { uso: "podcast_grav_dia", destino: "convidado", rotulo: "No dia" },
  host_1d: { uso: "podcast_host_1d", destino: "host", rotulo: "Host · véspera" },
  host_dia: { uso: "podcast_host_dia", destino: "host", rotulo: "Host · no dia" },
  agrad_convidado: { uso: "podcast_agrad_convidado", destino: "convidado", rotulo: "Agradecimento" },
  agrad_host: { uso: "podcast_agrad_host", destino: "host", rotulo: "Host · agradecimento" },
};

export interface AgendamentoPlano {
  status: string;
  inicio: string;
  agendado_em: string;
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
    add("grav_recebido", "enviar");

    const agendado = new Date(a.agendado_em);
    const datados: Array<[ChaveLembrete, Date, Date]> = [
      ["grav_5d", emBR(dia, 9, 5), emBR(dia, 10, 1)],
      ["grav_1d", emBR(dia, 10, 1), emBR(dia, 8, 0)],
      ["host_1d", emBR(dia, 10, 1), emBR(dia, 8, 0)],
      ["grav_dia", emBR(dia, 8, 0), inicio],
      ["host_dia", emBR(dia, 8, 0), inicio],
    ];
    for (const [chave, quando, ate] of datados) {
      if ((chave === "grav_dia" || chave === "host_dia") && inicio < emBR(dia, 9, 0)) {
        add(chave, "pular", "gravação antes das 9h");
      } else if (agendado > quando) {
        add(chave, "pular", "marcada depois do horário deste lembrete");
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
    if (diaBR(new Date(a.gravado_em)) === dia) add("agrad_host", "enviar");
    else add("agrad_host", "pular", "marcado como gravado em outro dia (o texto diz \"hoje\")");
  }
  return passos;
}
