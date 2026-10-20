// Resumo do lead para o Copiloto de Reunião — réguas PURAS (testadas em resumo.test.ts).
//
// Gerado UMA vez por reunião (ação `preparar`, quando o vendedor escolhe a reunião no app)
// e guardado em `copiloto_reuniao_resumos`. Serve a duas pessoas: o vendedor lê antes de
// entrar, e a IA das perguntas recebe junto com as informações da reunião.

export const PROMPT_RESUMO = `Você prepara um vendedor da PPG Educação (pós-graduações para veterinários e profissionais do agro) para uma reunião de vídeo com um lead que vai começar agora. Você recebe os dados do lead, o que foi registrado ao marcar a reunião, reuniões anteriores e a conversa de WhatsApp do lead com a PPGVET (SDR, a IA de atendimento e mensagens automáticas).

Escreva o resumo que o vendedor lê em 30 segundos antes de entrar. Ele também vai orientar a IA que sugere perguntas durante a reunião, então o que importa é o LEAD: a área dele, como trabalha, o que quer ganhar, o que já disse. Não é um resumo do curso.

Use estas quatro partes, cada uma com o rótulo em negrito e frases curtas:
**Quem é:** formação, onde e como trabalha (autônomo, contratado, servidor, dono do negócio), região.
**O que ele quer:** o objetivo ou a dor. Use as palavras dele entre aspas quando houver.
**O que já foi conversado:** o que ele perguntou, o que foi respondido, objeções ou dúvidas, e o que ficou combinado para a reunião.
**O que ainda não sabemos:** até três lacunas sobre a CARREIRA do lead que o vendedor deve descobrir na reunião: onde ele quer chegar profissionalmente, em que área quer atuar ou crescer, o que hoje o impede de ganhar mais, o que muda na carreira se fizer a pós, por que isso pesa agora. Detalhe de logística ou de atendimento (notificações, aparelho, horário, pagamento) não é lacuna de carreira e fica de fora.

Só o que está nos dados. O que não aparece não se deduz: vai para "O que ainda não sabemos". Mensagem automática só conta se o lead reagiu a ela. Não repita preço, valor nem condição de pagamento: se ele perguntou de valor, diga apenas que perguntou. No máximo 180 palavras, sem título geral e sem comentário fora das quatro partes.`;

export type Mensagem = {
  direcao?: string | null;
  tipo?: string | null;
  conteudo?: string | null;
  template_name?: string | null;
  created_at: string;
  audio?: string | null;
  audio_sdr?: string | null;
};

const MAX_MENSAGEM = 600;
const MAX_TEMPLATE = 200;
export const MAX_MENSAGENS = 250;
const MAX_CONVERSA = 40_000;

const txt = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

function quando(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${v("day")}/${v("month")} ${v("hour")}:${v("minute")}`;
}

/** Uma mensagem do WhatsApp vira uma linha legível; mensagem sem conteúdo útil some. */
export function linhaDaMensagem(m: Mensagem): string | null {
  const doLead = m.direcao === "inbound";
  const quem = doLead ? "Lead" : "PPGVET";
  const tipo = txt(m.tipo);
  let texto = txt(m.conteudo);
  let rotulo = quem;

  if (tipo === "audio") {
    texto = txt(m.audio) || txt(m.audio_sdr);
    rotulo = `${quem} (áudio)`;
  } else if (tipo === "template") {
    rotulo = `PPGVET (mensagem automática${m.template_name ? ` "${txt(m.template_name)}"` : ""})`;
    if (texto.length > MAX_TEMPLATE) texto = `${texto.slice(0, MAX_TEMPLATE)}…`;
  } else if (tipo === "button") {
    rotulo = `${quem} (clicou num botão)`;
  } else if (tipo && tipo !== "text") {
    // figurinha, documento, imagem: só registra que aconteceu
    return `[${quando(m.created_at)}] ${quem} enviou ${tipo}`;
  }
  if (!texto) return null;
  if (texto.length > MAX_MENSAGEM) texto = `${texto.slice(0, MAX_MENSAGEM)}…`;
  return `[${quando(m.created_at)}] ${rotulo}: ${texto.replace(/\s+/g, " ")}`;
}

/** A conversa em ordem cronológica, cortando o COMEÇO se passar do teto (o fim importa mais). */
export function montarConversa(mensagens: Mensagem[]): string {
  const linhas = [...mensagens]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map(linhaDaMensagem)
    .filter((l): l is string => !!l);
  const fim: string[] = [];
  let total = 0;
  for (let i = linhas.length - 1; i >= 0; i--) {
    total += linhas[i].length + 1;
    if (total > MAX_CONVERSA) {
      fim.unshift("(mensagens mais antigas omitidas)");
      break;
    }
    fim.unshift(linhas[i]);
  }
  return fim.join("\n");
}

/** O texto que vai para o modelo gerar o resumo. */
export function montarEntradaResumo(partes: {
  contexto: string; // o mesmo bloco de informações que a IA das perguntas recebe (montarContexto)
  analisePreReuniao?: string | null;
  mensagens: Mensagem[];
}): string {
  const blocos = [partes.contexto];
  const analise = txt(partes.analisePreReuniao);
  if (analise) blocos.push(`## Análise pré-reunião já feita pela Mimosa\n${analise.slice(0, 4000)}`);
  const conversa = montarConversa(partes.mensagens);
  blocos.push(conversa ? `## Conversa de WhatsApp (mais antiga primeiro)\n${conversa}` : "## Conversa de WhatsApp\n(nenhuma mensagem registrada)");
  return blocos.join("\n\n");
}
