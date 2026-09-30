// Regras fixas do LOOP do agente (30/09/2026): conjuntos de ferramentas que encerram, instruções e
// correções que o sistema injeta. Saíram de rodadaAgente (index.ts) para o motor por passos do agente
// no n8n (passosRodada.ts) usar o MESMO texto — regra num lugar só.
import { LINK_ESCOLA_GRATUITA } from './escolaGratuita.ts';
import { removerRaciocinioVazado } from './saida.ts';

// Tools que pausam a IA por decisão do PRÓPRIO agente (pausa_ia, e o
// temporizador_proxima_turma, que pausa via RPC). A despedida que acompanha
// essas tools precisa sair MESMO com o flag de pausa já setado: o recheck de
// pausa existe pra honrar pausa de ATENDENTE durante a geração, não pra
// engolir a própria despedida do agente.
// ▸ Regras de encerramento: quais ferramentas terminam o atendimento e qual despedida sai em cada caso.
export const TOOLS_QUE_PAUSAM = new Set(['pausa_ia', 'temporizador_proxima_turma']);
// ⚠️ ENCERRAR ≠ PAUSAR. `agendar_retorno` também termina o atendimento (o lead volta
// perto da formatura / no prazo que pediu) e a despedida vem NA MESMA volta da tool —
// mas ela NÃO pausa a IA, então o recheck de pausa continua valendo pra ela.
// Caso Matheus (2026-08-08): o modelo escreveu a mensagem CERTA ("como ainda falta um
// caminho pra concluir a graduação, no momento não dá pra seguir… vou te procurar mais
// pra frente") e ela foi ENGOLIDA pelo `continue`, porque só as tools de PAUSA tinham
// o envio. O lead ficou com "Show, 10h30 então" como última informação e no dia
// seguinte mandou "Bom dia" esperando a reunião. Medido: 33 de 238 rodadas com
// agendar_retorno (13,9%) terminaram MUDAS em 30 dias.
export const TOOLS_QUE_ENCERRAM = new Set([...TOOLS_QUE_PAUSAM, 'agendar_retorno']);

// Quando a tool de pausa vem SEM texto junto, o loop dá mais uma volta pro modelo
// escrever a despedida — e é EXATAMENTE nessa volta que ele, sem nada a dizer,
// responde ao SISTEMA ("sem nova mensagem do lead", "*sem resposta necessária*").
// Proibir sem dar o que fazer não funciona com LLM, então a instrução chega no
// momento exato, COM a despedida-exemplo. Vai anexada ao contexto temporal (que já
// muda a cada minuto ⇒ não custa cache) e é EFÊMERA: não é gravada no histórico,
// então não polui as rodadas seguintes nem vira turno que o modelo reinterprete.
// ⚠️ A despedida-exemplo daqui carrega o PRESENTE DA ESCOLA (2026-08-05): na telemetria,
// a esmagadora maioria das pausas vem SEM texto junto, então é NESTA volta que a última
// mensagem ao lead nasce — sem o convite aqui, o presente simplesmente não sairia.
// ⚠️ A despedida-exemplo daqui MUDA conforme a pessoa já tenha ou não acesso à Escola:
// pedir "despeça-se COM o presente" a quem já está dentro é instruir o erro na origem, e
// aí nenhuma guarda de saída resolve — ela só apagaria o que o modelo acabou de escrever.
export const instrucaoPosPausa = (estaNaEscola: boolean) => '[SISTEMA — você acabou de encerrar/pausar este atendimento. '
  + 'NÃO relate isso e NÃO descreva o estado do atendimento.]\n'
  + (estaNaEscola
    ? 'Se você ainda NÃO se despediu nesta conversa, escreva SÓ a despedida curta ao lead, '
      + 'por exemplo: "tranquilo, agradeço sua preferência pelo Grupo PPG e fico à disposição '
      + 'se precisar no futuro."\n'
      + '⛔ Esta pessoa JÁ tem acesso à Escola de Especialização — NÃO ofereça a biblioteca '
      + 'gratuita e NÃO mande o link.\n'
    : 'Se você ainda NÃO se despediu nesta conversa, escreva SÓ a despedida curta ao lead, JÁ COM o '
      + 'presente da Escola (a conversa acabou sem reunião), por exemplo: '
      + '"tranquilo, agradeço sua preferência pelo Grupo PPG e fico à disposição se precisar no futuro. '
      + 'antes de te deixar ir: a ppgvet tem uma biblioteca de conteúdo aberta e totalmente gratuita, '
      + 'com mais de 10 cursos, artigos, e-books, aulas abertas de pós e certificados. '
      + 'é um presente da ppgvet educação pra vc, aproveita: ' + LINK_ESCOLA_GRATUITA + '"\n'
      + 'Se você JÁ mandou o convite da Escola nesta conversa, não repita — mande só a despedida.\n')
  + 'Se a despedida já foi enviada, responda com texto vazio.\n'
  + 'NUNCA escreva frases como "sem nova mensagem do lead", "*sem resposta necessária*", '
  + '"atendimento pausado" ou "nenhuma ação necessária": elas são enviadas ao WhatsApp do lead.';
// Retorno agendado por FORMATURA: o lead segue interessado e volta a ser elegível quando
// se formar — a despedida é OUTRA (não é "agradeço a preferência"), e precisa dizer POR QUE
// não dá agora. Sem isso o lead não entende que a pós exige graduação concluída e, se um
// horário chegou a ser oferecido, fica esperando a reunião (caso Matheus).
export const INSTRUCAO_POS_RETORNO = '[SISTEMA — você acabou de agendar o retorno deste lead pra perto '
  + 'da formatura dele. NÃO relate isso e NÃO descreva o estado do atendimento.]\n'
  + 'Escreva SÓ a mensagem ao lead, deixando DUAS coisas claras com as suas palavras: '
  + '(1) a pós é lato sensu e a matrícula exige a GRADUAÇÃO CONCLUÍDA, então agora ainda não dá; '
  + '(2) vc vai procurá-lo quando ele estiver terminando o curso.\n'
  + 'Se vc ofereceu ou combinou algum HORÁRIO de reunião nesta conversa, desfaça de forma '
  + 'explícita ("não vou marcar aquele horário que falei") — senão ele fica esperando uma '
  + 'reunião que não vai acontecer.\n'
  + 'Feche com o presente da Escola (a conversa acabou sem reunião), a menos que vc já tenha '
  + 'mandado o convite nesta conversa.\n'
  + 'Nunca mencione a data-limite, "prazo" ou "elegibilidade". Se a mensagem já foi enviada, '
  + 'responda com texto vazio.';

// ── LEVA SÓ DE REAÇÃO (2026-08-06, caso Peterson) ─────────────────────────
// O lead reage com 👍 e não escreve nada. O agente acorda, não tem o que dizer
// e RELATA ao sistema ("nenhuma resposta necessária, o lead apenas reagiu com
// um emoji") — 35 balões desses em 15 dias, 6 dos 8 últimos com reação como
// gatilho. Não adianta proibir: LLM não produz vazio de forma confiável, ele
// PREENCHE. Então a instrução dá um ALVO CURTO pra ele acertar, no momento exato
// (mesmo padrão da INSTRUCAO_POS_PAUSA — efêmera, anexada ao contexto temporal,
// fora do prefixo cacheado, nunca gravada no histórico).
// ⚠️ Reação NÃO é sempre "nada a dizer": quando responde uma PERGUNTA nossa
// (o caso Peterson era 👍 em "passando só pra confirmar nossa reunião às 17h"),
// ela é um SIM e o fluxo tem que seguir. Por isso a instrução ramifica.
// ⚠️ SEM emoji nos exemplos: o prompt do João proíbe emoji fora da confirmação
// final — sugerir "👍" aqui brigaria com a régua de voz dele.
const RE_SO_REACAO = /^\[reacao\]/;
export const ehLevaSoReacao = (conteudo: string) => conteudo.trim().length > 0
  && conteudo.split('\n').map((l) => l.trim()).filter(Boolean).every((l) => RE_SO_REACAO.test(l));
export const INSTRUCAO_REACAO = '[SISTEMA — o lead NÃO escreveu nada: ele apenas REAGIU com um emoji '
  + 'à sua última mensagem. Isso é o "ok" dele.]\n'
  + 'Se a sua última mensagem tinha uma PERGUNTA ou pedia confirmação, trate a reação como um SIM '
  + 'e siga o fluxo normalmente (confirme e siga adiante).\n'
  + 'Se NÃO havia pergunta pendente, mande SÓ uma confirmação curtíssima e informal, no seu tom: '
  + '"beleza", "é nois", "combinado", "show", "tmj". No máximo 3 palavras, sem pergunta nova, '
  + 'sem recomeçar assunto e sem repetir o que já foi combinado.\n'
  + 'NUNCA descreva a situação ("o lead apenas reagiu", "nenhuma resposta necessária", '
  + '"sem ação necessária"): esse texto é enviado ao WhatsApp dele.';

// SILÊNCIO INDEVIDO (21/09/2026, teste do usuário): o lead perguntou "mais cedo?", o modelo consultou
// a agenda duas vezes e fechou a volta com responder_ao_cliente VAZIO — a conversa travou sem erro
// nenhum. Silêncio só é resposta válida quando a rodada encerrou por tool (a despedida já saiu) ou
// quando o lote era só reação. Fora disso, a fala é pedida de novo, uma vez.
export const CORRECAO_SILENCIO =
  '[CORRECAO_INTERNA_AUTO_IGNORE] Você encerrou esta volta SEM mandar mensagem, mas o lead acabou de escrever e ' +
  'está esperando resposta. Silêncio aqui trava a conversa. Responda agora à última mensagem dele, na voz do João, ' +
  'usando os resultados das ferramentas que você já tem nesta conversa (se consultou a agenda, ofereça os horários ' +
  'que ela devolveu; se não há o que ele pediu, diga isso em uma frase e ofereça o mais próximo). ' +
  'Não mencione esta correção ao lead.';

// ── SILÊNCIO NÃO É RESPOSTA (2026-08-12, medido no harness) ─────────────────
// Quando a limpeza de saída derruba a mensagem INTEIRA (era só narração), o
// agente ficava mudo — em 2 de 50 rodadas do cenário Carolina a última fala do
// lead ficou sem resposta. Calar é melhor que vazar, mas é o pior dos dois
// resultados aceitáveis: o lead falou e ninguém respondeu. Agora pedimos a
// mensagem DE NOVO, uma vez, dizendo o que estava errado — mesma mecânica da
// trava de horário inventado. Se a segunda também vier só de bastidor, aí sim
// silêncio (a rodada fica no Debug do Agente com `resposta_vazia_reinstruida`).
export const CORRECAO_VAZIO =
  '[CORRECAO_INTERNA_AUTO_IGNORE] Sua última mensagem NÃO foi enviada: ela era inteiramente ' +
  'raciocínio/relatório de bastidor, e depois da limpeza não sobrou NADA para o lead ler. ' +
  'O texto barrado foi:\n"""\n%TEXTO%\n"""\n' +
  'Escreva agora a mensagem que o lead vai LER, na voz do João, começando direto na primeira ' +
  'palavra dela. Nada de comentar a conversa, o roteiro, as tentativas de contorno, o que você ' +
  'decidiu ou o que vai fazer; nada de falar do lead na terceira pessoa ("ele", "ela", "o lead") ' +
  '— fale COM a pessoa. Se o certo aqui é se despedir, mande só a despedida. ' +
  'Não mencione esta correção ao lead.';

// Oferta de retenção ("te chamo quando abrir a próxima turma"): o porquê está em rodadaAgente (index.ts).
export const RE_RETENCAO = /(te cham\w*|te avis\w*)[^.?!]{0,40}pr[óo]xima turma/i;

// Raciocínio simulado em <thinking>…</thinking> DENTRO do bloco de texto não pode
// ficar no histórico: o modelo lê o próprio turno anterior e repete o padrão na volta
// seguinte (auto-reforço). O envio já é protegido em saida.ts; aqui é a 2ª camada.
// ⚠️ Só troca o texto quando sobra conteúdo — bloco `text` VAZIO no histórico é 400 na
// Anthropic, então turno que era só raciocínio é gravado como veio (fiel, e nunca sai).
export function semRaciocinioNoTexto(content: any): any {
  if (!Array.isArray(content)) return content;
  return content.map((b: any) => {
    if (b?.type !== 'text' || typeof b.text !== 'string') return b;
    const limpo = removerRaciocinioVazado(b.text);
    return limpo && limpo !== b.text ? { ...b, text: limpo } : b;
  });
}
