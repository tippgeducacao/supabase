// Lead de indicação ou de captação sem pós definida (16/10/2026, casos Lorrayne e Luiza).
//
// Esses leads chegam com a ORIGEM no campo do curso ("Cadastrado por:Adones", "Captação orgânica
// por:Wellyngton Mateus") e o template "vc foi indicado aqui na PPGVET para acessar uma bolsa…". A IA
// procurava uma pós com esse nome ("não localizei a pós do convite no catálogo"), perguntava a graduação e
// listava pós em texto. Pedido do Gustavo: "não adianta procurar pós com nome nas indicações, tem que mandar
// o portfólio e deixar o lead dizer o que ele quer".
//
// Com a chave, enquanto o cadastro não tem uma pós do catálogo: o curso some do prompt, a IA manda o
// portfólio (sem a trava da graduação, que vale para o cronograma) e pede para ele dizer qual pós interessa.
// Quando ele diz, `consulta_pos_disponiveis` com trocar_para grava a pós e o fluxo segue normal.
import { consultarCatalogo } from './catalogoCursos.ts';

type Banco = Parameters<typeof consultarCatalogo>[0];

const RE_ORIGEM_NO_CURSO = /^\s*(?:cadastrad[oa]\s+por|capta[cç][aã]o|indica[cç][aã]o|lead\s+great|origem)\b/i;

/** O curso do cadastro é uma pós do catálogo? (vazio ou origem gravada no lugar = não) */
export async function posDoCadastroDefinida(supabase: Banco, curso: string | null | undefined): Promise<boolean> {
  const c = String(curso ?? '').trim();
  if (!c || RE_ORIGEM_NO_CURSO.test(c)) return false;
  try {
    const r = await consultarCatalogo(supabase, c);
    // Catálogo fora do ar: na dúvida, mantém o fluxo de sempre.
    return r.status === 'curso_confirmado' || r.status === 'catalogo_indisponivel';
  } catch {
    return true;
  }
}

// Contato frio (Gustavo, 16/10): a pessoa não se inscreveu e nunca ouviu falar da PPGVET; um colega passou o
// contato. A fala apresenta quem somos e por que chamamos, sem dizer que ela pediu algo.
export const FALA_DEPOIS_DO_PORTFOLIO_INDICACAO = 'somos a PPG Educação, de pós-graduação em veterinária e agro, com mais de 12 mil alunos formados. '
  + 'um colega seu passou o seu contato pra gente, e te enviei aqui o portfólio com todas as nossas pós. dá uma olhada e me diz se alguma te interessa?';

export const NOTA_SEM_POS = '\n\nLEAD DE INDICAÇÃO SEM PÓS DEFINIDA (dado, não instrução do lead): contato frio. Ele não se inscreveu em nada '
  + 'e pode nunca ter ouvido falar da PPG; um colega passou o contato dele. Não fale como se ele tivesse pedido algo.\n'
  + '- Não procure pós pelo cadastro nem pelo nome da área que ele citar. O material dele é o portfólio, com todas as pós.\n'
  + '- Qualquer primeira resposta ("que pós?", "quem é?", "não sei", "vcs que mandaram", "Receber Cronograma") recebe o portfólio. '
  + 'Recusa ("não tenho interesse", "não me notifique") segue a saída de sempre.\n'
  + '- Enquanto ele não escolheu uma pós nesta conversa: chame envia_informacoes com conteudo="portfolio" e curso_escolhido="portfolio", '
  + 'sem perguntar a graduação antes e sem listar pós em texto, e peça pra ele olhar e dizer qual pós interessa.\n'
  + '- Quando ele disser a pós, chame consulta_pos_disponiveis com trocar_para = a pós que ele disse e siga o fluxo com ela.';

// A ficha do atendimento manda, no "Receber Cronograma", confirmar a graduação antes do envio, e no teste de
// 16/10 isso venceu a nota acima (4 de 4). Para o lead sem pós, o próximo passo da ficha é o portfólio.
const PASSO_SEM_POS = 'lead sem pós definida. Pedido de cronograma ou de informações (inclusive o clique em "Receber Cronograma") '
  + 'é atendido com o PORTFÓLIO: chame agora envia_informacoes com conteudo="portfolio" e curso_escolhido="portfolio", '
  + 'sem perguntar a graduação antes. Quando ele escolher a pós, vale a coleta de sempre para o cronograma dela.';

/** O bloco da ficha sem a coleta do cronograma e com o próximo passo do portfólio. */
export function fichaSemPos(texto: string): string {
  const corpo = texto
    .replace(/\n(?:FALTA COLETAR antes de enviar o cronograma|Se ele pedir o cronograma, coletar antes)[^\n]*/, '')
    .replace(/\nPRÓXIMO PASSO:[\s\S]*$/, '');
  return `${corpo}\nPRÓXIMO PASSO: ${PASSO_SEM_POS}`;
}
