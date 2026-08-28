// FONTE ÚNICA da janela de elegibilidade do ESTUDANTE que ainda cursa a graduação.
//
// Régua (decisão do usuário 2026-08-06, ampliada em 2026-08-28): elegível quem conclui a
// graduação
//   • nos próximos 3 meses, **OU**
//   • até 31/01 do ano SEGUINTE
// — o que for MAIOR. Ou seja, "quem se forma em dezembro **ou em janeiro** já pode conhecer
// a pós".
//
// ⚠️ 2026-08-28: a âncora era 31/12 do ano CORRENTE e recusava a turma de JANEIRO — que é a
// mesma turma de dezembro, só com a colação de grau caindo do outro lado da virada do ano.
// Caso real (lead Milena, 27/08): "Em janeiro finalizo" → REPROVADO_PRAZO e recontato
// agendado pra 25/01/2027, por 31 dias de diferença. A âncora virou 31/01 do ano SEGUINTE;
// o resto da régua (o piso de 3 meses, e o código ter a palavra final) não mudou.
//
// Antes era um teto fixo de 90 dias, e ele recusava justamente quem se forma no fim do
// ano: em 21 dias o agente reprovou 434 pessoas por prazo (contra 604 aprovadas no fluxo
// normal), e a faixa "conclui em 4-6 meses" — dezembro/janeiro — era a mais populosa entre
// as que informaram a data.
//
// ⚠️ O PISO DE 3 MESES NÃO É DETALHE: sem ele, a régua ancorada no fim da turma ficaria
// mais RESTRITIVA que a antiga na virada do ano (em 20/01 sobrariam 11 dias, e quem se
// forma em abril passaria a ser recusado — uma regressão silenciosa a cada dezembro). Com
// o piso, a janela nunca encolhe abaixo do que já valia.
//
// ⚠️ A DATA É CALCULADA EM CÓDIGO e entregue pronta ao modelo dentro do contexto temporal
// (contexto.ts → montarContextoTemporal). O LLM erra conta de calendário — foi o caso de
// 2026-07-04, em que ele achou que 07/07 era segunda. Ele só compara a data que o lead
// disse com a data-limite que já recebeu mastigada.
//
// ⚠️ Espelhos: a régua aparece nos prompts das 4 personas, na tool-description do parâmetro
// `contexto_qualificacao` (banco, `lista_tools_claude`) e na rubrica de teste. Mudou aqui →
// reflita lá. Quem REPROVA continua sendo o código (tools.ts, ramo REPROVADO_PRAZO); esta
// função só diz até quando o lead é considerado apto.
//
// ⚠️ 2026-08-13, caso Edinara: a régua acima estava certa e mesmo assim uma estudante do
// 1º ANO foi agendada. O João perguntou "quando fica pronta essa conclusão", ouviu
// **"2 semestre"** e mandou `contexto_qualificacao: "estudante_apto"` — leu a resposta como
// "segundo semestre DE 2026" (dentro do limite) em vez de "estou no 2º semestre do curso"
// (conclusão em ~2029). A matriz aprovou pela ÁREA, que é o único julgamento dela, e a
// reunião foi criada. Ou seja: a decisão de PRAZO estava na mão do modelo, e um número de
// semestre não é uma data — é uma POSIÇÃO NO CURSO, e as duas leituras são legítimas.
// Daí `lerConclusao`/`avaliarConclusao`: quem decide o prazo passa a ser o CÓDIGO, e
// resposta ambígua não vira aprovação — vira uma pergunta de mês/ano ao lead.

const MESES_MINIMOS = 3;

/** Data-limite de conclusão da graduação para o lead ser elegível AGORA. */
export function limiteFormatura(agora: Date = new Date()): Date {
  // Brasília = UTC-3 fixo (mesma convenção de agoraBrasilia em contexto.ts).
  const br = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
  const ano = br.getUTCFullYear();

  // Âncora: 31/01 do ano SEGUINTE (último instante) — a turma que termina neste ano,
  // incluindo quem só cola grau depois da virada.
  const fimDaTurma = new Date(Date.UTC(ano + 1, 0, 31, 23, 59, 59));

  // Piso: hoje + 3 meses. setUTCMonth normaliza a virada de ano sozinho (out+3 = jan).
  const piso = new Date(br.getTime());
  piso.setUTCMonth(piso.getUTCMonth() + MESES_MINIMOS);

  return piso > fimDaTurma ? piso : fimDaTurma;
}

/** "31/01/2027" — formato que o lead e o modelo leem. */
export function limiteFormaturaFormatado(agora: Date = new Date()): string {
  const d = limiteFormatura(agora);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

// ── Leitura da resposta do lead sobre QUANDO ele conclui ────────────────────

export type LeituraConclusao =
  /** Deu pra cravar um instante-limite de conclusão (fim do mês/semestre/ano citado). */
  | { tipo: 'data'; data: Date; via: string }
  /** Disse em que ponto do curso está ("2 semestre", "no 5º período") — NÃO é data. */
  | { tipo: 'posicao_no_curso'; via: string }
  /** Não deu pra entender ("ano que vem", "logo", vazio). */
  | { tipo: 'ilegivel' };

const MESES_PT = [
  'janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];
const NUMERO_PT: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5,
  seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
};
const ORDINAL_PT = 'primeir|segund|terceir|quart|quint|sext|setim|oitav|non|decim|ultim|penultim';

/** Último instante do mês (1-12) — a conclusão pode cair em qualquer dia dele. */
function fimDoMes(ano: number, mes1a12: number): Date {
  return new Date(Date.UTC(ano, mes1a12, 0, 23, 59, 59));
}

/** Minúsculas, sem acento — "2º Semestre" e "2o semestre" viram a mesma string. */
function normalizar(v: unknown): string {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Interpreta o que o lead respondeu sobre a conclusão da graduação.
 *
 * A ORDEM É A REGRA DE NEGÓCIO, não estilo:
 *   1. tem ANO explícito → é data ("12/2026", "2027.1", "dez/2026", "2028");
 *   2. tem marcador de DURAÇÃO → é data relativa ("conclui em 2 anos", "faltam 6 meses");
 *   3. número + semestre/período/ano/fase SEM ano nem marcador → POSIÇÃO NO CURSO
 *      ("2 semestre", "tô no 5º período", "último ano") → ambíguo, não vira data;
 *   4. mês solto ("dezembro") → esse mês, neste ano ou no próximo se já passou;
 *   5. resto → ilegível.
 *
 * O passo 3 é o caso Edinara e o motivo desta função existir. "2 semestre" tanto pode ser
 * "segundo semestre deste ano" quanto "estou no 2º semestre do curso", e nenhuma das duas
 * leituras é obviamente a certa — então não se escolhe uma: pergunta-se o mês e o ano.
 */
export function lerConclusao(bruto: unknown, agora: Date = new Date()): LeituraConclusao {
  const t = normalizar(bruto);
  if (!t) return { tipo: 'ilegivel' };

  const br = new Date(agora.getTime() - 3 * 60 * 60 * 1000); // Brasília = UTC-3
  const anoAtual = br.getUTCFullYear();

  // 1a. Semestre letivo com ano: "2027.1", "2027/2", "1º semestre de 2027".
  const letivo = t.match(/\b(20\d{2})\s*[./-]\s*([12])\b/)
    ?? t.match(/\b([12])\s*[ºoª°]?\s*(?:semestre|sem)\b[^0-9]{0,12}\b(20\d{2})\b/);
  if (letivo) {
    const [ano, sem] = /^20/.test(letivo[1])
      ? [Number(letivo[1]), Number(letivo[2])]
      : [Number(letivo[2]), Number(letivo[1])];
    return { tipo: 'data', data: fimDoMes(ano, sem === 1 ? 6 : 12), via: 'semestre letivo' };
  }

  // 1b. Mês + ano: "12/2026", "2026-12", "dez/2026", "dezembro de 2026".
  const numerico = t.match(/\b(0?[1-9]|1[0-2])\s*[/-]\s*(20\d{2})\b/)
    ?? t.match(/\b(20\d{2})\s*[/-]\s*(0?[1-9]|1[0-2])\b/);
  if (numerico) {
    const [ano, mes] = /^20/.test(numerico[1])
      ? [Number(numerico[1]), Number(numerico[2])]
      : [Number(numerico[2]), Number(numerico[1])];
    return { tipo: 'data', data: fimDoMes(ano, mes), via: 'mes/ano' };
  }
  const nomeMesAno = t.match(
    new RegExp(`\\b(${MESES_PT.map((m) => m.slice(0, 3)).join('|')})[a-z]*\\b[^0-9]{0,12}\\b(20\\d{2})\\b`),
  );
  if (nomeMesAno) {
    const mes = MESES_PT.findIndex((m) => m.startsWith(nomeMesAno[1])) + 1;
    return { tipo: 'data', data: fimDoMes(Number(nomeMesAno[2]), mes), via: 'mes por extenso' };
  }

  // 1c. Só o ano: "2028", "em 2027".
  const soAno = t.match(/\b(20\d{2})\b/);
  if (soAno) return { tipo: 'data', data: fimDoMes(Number(soAno[1]), 12), via: 'ano' };

  // 2. Duração até concluir — só com marcador explícito, senão "2 semestre" viraria
  //    "faltam 2 semestres" e a ambiguidade voltaria disfarçada de data.
  const dur = t.match(new RegExp(
    `\\b(?:em|daqui|dentro de|falta|faltam|faltando|mais)\\s+(?:mais\\s+)?` +
    `(?:cerca de\\s+|aproximadamente\\s+|uns?\\s+|umas?\\s+)?` +
    `(\\d{1,2}|${Object.keys(NUMERO_PT).join('|')})\\s*(mes|meses|ano|anos|semestre|semestres)\\b`,
  ));
  if (dur) {
    const n = /^\d/.test(dur[1]) ? Number(dur[1]) : NUMERO_PT[dur[1]];
    const meses = dur[2].startsWith('ano') ? n * 12 : dur[2].startsWith('semestre') ? n * 6 : n;
    const d = new Date(br.getTime());
    d.setUTCMonth(d.getUTCMonth() + meses);
    return { tipo: 'data', data: fimDoMes(d.getUTCFullYear(), d.getUTCMonth() + 1), via: 'duracao' };
  }

  /*
    2b. POSIÇÃO **E** CONCLUSÃO na mesma resposta: "10 período, finalizo em novembro".

    Precisa vir ANTES da regra de posição. Sem isto o "10 período" curto-circuitava tudo e a
    data que o lead deu na MESMA frase era jogada fora: o João perguntava o mês/ano de novo,
    e de novo. Caso real de 22/08 — a lead respondeu quatro vezes, escreveu "Já respondi", e
    a conversa só destravou quando o modelo repetiu a data noutro formato.

    ⚠️ Exige um VERBO DE CONCLUSÃO perto do mês. Mês solto ao lado da posição pode ser outra
    coisa ("tô no 3º período, comecei em janeiro"), e aí a regra de posição continua valendo —
    que é o que protege do caso Edinara.
  */
  const conclusaoComMes = t.match(new RegExp(
    `\\b(?:finaliz|termin|conclu|form|colo|colar)[a-z]*\\b[^.;]{0,30}?`
    + `\\b(${MESES_PT.map((m) => m.slice(0, 3)).join('|')})[a-z]*\\b`,
  ));
  if (conclusaoComMes) {
    const mes = MESES_PT.findIndex((m) => m.startsWith(conclusaoComMes[1])) + 1;
    const ano = mes < br.getUTCMonth() + 1 ? anoAtual + 1 : anoAtual;
    return { tipo: 'data', data: fimDoMes(ano, mes), via: 'conclusao com mes' };
  }

  // 3. Posição no curso — o caso Edinara.
  if (new RegExp(`\\b(?:\\d{1,2}|${ORDINAL_PT})[a-z]*\\s*[ºoª°]?\\s*(?:semestre|periodo|ano|fase|etapa)s?\\b`).test(t)) {
    return { tipo: 'posicao_no_curso', via: 'numero de semestre/periodo' };
  }

  // 4. Mês solto: "dezembro", "em julho" — esse mês, neste ano ou no próximo se já passou.
  const soMes = t.match(new RegExp(`\\b(${MESES_PT.map((m) => m.slice(0, 3)).join('|')})[a-z]*\\b`));
  if (soMes) {
    const mes = MESES_PT.findIndex((m) => m.startsWith(soMes[1])) + 1;
    const ano = mes < br.getUTCMonth() + 1 ? anoAtual + 1 : anoAtual;
    return { tipo: 'data', data: fimDoMes(ano, mes), via: 'mes sem ano' };
  }

  return { tipo: 'ilegivel' };
}

export type VereditoConclusao = 'apto' | 'fora_do_prazo' | 'indeterminado';

/**
 * Veredito de PRAZO do estudante, decidido em código.
 *
 * @param bruto        o que o lead respondeu, literal ("2 semestre", "termino em 2028")
 * @param normalizado  o MM/AAAA que o modelo entendeu (só é usado se o bruto não fechar)
 *
 * Regra da ambiguidade: se o BRUTO é posição no curso, o veredito é `indeterminado`
 * mesmo com um `normalizado` bonito — foi exatamente assim que a Edinara passou (o modelo
 * converteu "2 semestre" numa data plausível por conta própria).
 */
export function avaliarConclusao(
  bruto: unknown,
  normalizado: unknown,
  agora: Date = new Date(),
): { veredito: VereditoConclusao; leitura: LeituraConclusao; limite: Date } {
  const limite = limiteFormatura(agora);
  const doLead = lerConclusao(bruto, agora);
  if (doLead.tipo === 'posicao_no_curso') return { veredito: 'indeterminado', leitura: doLead, limite };

  const leitura = doLead.tipo === 'data' ? doLead : lerConclusao(normalizado, agora);
  if (leitura.tipo !== 'data') return { veredito: 'indeterminado', leitura, limite };
  return { veredito: leitura.data <= limite ? 'apto' : 'fora_do_prazo', leitura, limite };
}

export type DecisaoPrazo =
  /** Não é estudante, ou conclui dentro da janela: a matriz roda normalmente. */
  | { acao: 'segue' }
  /** Conclui fora da janela: REPROVADO_PRAZO, a matriz nem roda. */
  | { acao: 'reprova' }
  /** Ainda não dá pra saber quando conclui: o João pergunta o mês/ano antes de tudo. */
  | { acao: 'pergunta_data'; porque: 'posicao_no_curso' | 'sem_data' };

/**
 * A decisão de PRAZO inteira, a partir do input cru da tool. Pura de propósito: é ela que o
 * executor real (tools.ts) e o mock do harness (crm-agente-sdr-simular) chamam, para que
 * seja IMPOSSÍVEL um decidir diferente do outro.
 *
 * ⚠️ Essa divergência já aconteceu 4 vezes (consulta_pos_disponiveis, o prazo em 2026-07-16,
 * os slots vencidos, o sábado sem horário) e o padrão é sempre o mesmo: o mock aprova algo
 * que a produção reprova, o teste passa, e o bug vai pro ar com o harness verde.
 *
 * Assimetria proposital: **reprovar nunca exige a data**. Se o modelo já concluiu que o lead
 * está fora do prazo, aceita-se — exigir prova pra recusar só abriria um buraco novo. O que
 * passa a exigir data legível é APROVAR, que é onde o erro custa uma reunião marcada.
 */
export function decidirPrazoEstudante(input: {
  contexto_qualificacao?: unknown;
  conclusao_graduacao?: unknown;
  conclusao_graduacao_bruta?: unknown;
}, agora: Date = new Date()): DecisaoPrazo {
  const ctx = input?.contexto_qualificacao;
  if (ctx !== 'estudante_apto' && ctx !== 'estudante_fora_do_prazo') return { acao: 'segue' };

  const { veredito, leitura } = avaliarConclusao(
    input?.conclusao_graduacao_bruta, input?.conclusao_graduacao, agora,
  );
  if (veredito === 'fora_do_prazo') return { acao: 'reprova' };
  if (veredito === 'apto') return { acao: 'segue' };
  // indeterminado
  if (ctx === 'estudante_fora_do_prazo') return { acao: 'reprova' };
  return {
    acao: 'pergunta_data',
    porque: leitura.tipo === 'posicao_no_curso' ? 'posicao_no_curso' : 'sem_data',
  };
}

/** Texto do tool_result quando falta a data — idêntico no executor e no harness. */
export function instrucaoPerguntarConclusao(porque: 'posicao_no_curso' | 'sem_data'): string {
  return 'A checagem NÃO rodou: ainda não dá pra saber quando este lead conclui a graduação. '
    + (porque === 'posicao_no_curso'
      ? 'Ele disse em que ponto do curso está ("2º semestre", "5º período"), e isso NÃO é uma '
        + 'data de conclusão — pode faltar anos. NÃO deduza. '
      : '')
    + 'Pergunte agora, curto e no seu tom, o MÊS e o ANO em que ele cola grau '
    + '("e em que mês e ano vc cola grau, mais ou menos?") e só chame esta função de novo '
    + 'quando ele responder. Até lá é PROIBIDO oferecer horário, tratar o lead como apto ou '
    + 'dizer que a formação dele atende. Nunca cite "prazo", "elegibilidade" ou data-limite.';
}

/** Bloco injetado no contexto temporal das 4 personas (e do webchat). */
export function blocoElegibilidadeFormatura(agora: Date = new Date()): string {
  return `**ELEGIBILIDADE DE QUEM AINDA CURSA A GRADUAÇÃO (régua interna, NUNCA cite ao lead):**
Estudante que conclui a graduação **até ${limiteFormaturaFormatado(agora)}** (incluindo TCC) é ELEGÍVEL:
trate como apto (\`contexto_qualificacao\` = "estudante_apto"), siga o fluxo normal e pode agendar.
Quem conclui DEPOIS dessa data ainda não pode — encerre pelo caminho do retorno na formatura.
Use ESTA data, não calcule prazo de cabeça.
⚠️ A data-limite **pode cair no ANO QUE VEM** — e quando cai, quem conclui até ela é APTO do
mesmo jeito. "É do ano que vem" NÃO reprova ninguém: o que reprova é concluir DEPOIS da data.
Ex.: com a data-limite em 31/01/2027, "finalizo em janeiro" é APTO; "finalizo em 2027.1", não.

⚠️ **SEMESTRE/PERÍODO NÃO É DATA.** Se vc perguntar quando ele conclui e a resposta for a
POSIÇÃO dele no curso — "2 semestre", "tô no 5º período", "primeiro ano", "última fase" —, vc
AINDA NÃO SABE quando ele termina, e é PROIBIDO deduzir. "2 semestre" pode ser "segundo
semestre deste ano" ou "estou no 2º semestre da faculdade" (ou seja, faltam anos), e as duas
leituras são possíveis. Nesse caso, pergunte o **mês e o ano** antes de decidir qualquer coisa:
> "e em que mês e ano vc cola grau, mais ou menos?"
Só conta como data uma resposta com ANO ("2027.1", "dezembro de 2026", "12/2026", "só me formo
em 2028") ou com prazo explícito ("conclui em uns 2 anos", "faltam 6 meses"). Enquanto vc não
tiver isso, NÃO ofereça horário e NÃO trate o lead como apto.

⛔ APROVOU? NÃO COMENTE — vale para QUALQUER lead, formado ou ainda cursando. A checagem roda
em segundo plano: é PROIBIDO dizer ao lead que a formação dele "atende", que ele "pode fazer",
que "dezembro está dentro do prazo" ou qualquer variação — inclusive quando ele mesmo puxa o
assunto ("posso mesmo ainda cursando?") e inclusive logo depois de ele informar a graduação
("sou médica veterinária formada" → NÃO responda "boa, sua formação atende"). Responda
o que ele perguntou em meia frase, sem laudo ("tranquilo, dá pra seguir"), e emende no próximo
passo (a condição especial e a conversa no meet).
> ERRADO: "show, sua formação atende sim, dezembro tá dentro do prazo certinho."
> Certo: "tranquilo, dá pra seguir normal. a secretaria liberou uma condição especial…"`;
}
