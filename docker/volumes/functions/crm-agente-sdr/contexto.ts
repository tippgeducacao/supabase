// Port fiel do code node "normalizador de Curso e Contexto Temporal DIAS NORMAIS"
// do n8n (fonte: scripts/teste-agente/n8n-export/). Três responsabilidades:
//   1. normalização da formação acadêmica do lead;
//   2. contexto temporal (Brasília) com janelas de atendimento e períodos ofertáveis;
//   3. pergunta_formacao pronta + render dos placeholders {{ $json.* }} dos prompts.
//
// ⚠️ O contexto temporal carrega TAMBÉM a data-limite de elegibilidade do estudante que
// ainda cursa a graduação (elegibilidadeFormatura.ts) — pelo mesmo motivo do calendário
// dos próximos dias: o modelo erra conta de calendário, então recebe a data pronta.
import { blocoElegibilidadeFormatura } from './elegibilidadeFormatura.ts';
// Reexportado por conveniência: quem monta contexto quer o lembrete de nome junto.
export { notaDoNome } from './nomeDoLead.ts';

export function extrairPrimeiroNome(nomeCompleto: string | null | undefined): string {
  if (!nomeCompleto) return '';
  return nomeCompleto.trim().split(' ')[0];
}

const FORMACOES_OFICIAIS = [
  'Medicina Veterinária', 'Agronomia', 'Zootecnia', 'Biologia',
  'Engenharia de Alimentos', 'Engenharia de Produção', 'Administração',
  'Direito', 'Estudante', 'Outra área', 'Sem formação superior',
];

const MAPEAMENTOS_DIRETOS: Record<string, string> = {
  // Médico Veterinário
  'medico veterinario (a) formado (a)': 'Medicina Veterinária',
  'medico veterinario a formado a': 'Medicina Veterinária',
  'medico veterinario (a)': 'Medicina Veterinária',
  'medico veterinario a': 'Medicina Veterinária',
  'medico veterinario': 'Medicina Veterinária',
  'medico veterinaria': 'Medicina Veterinária',
  'medicina veterinaria': 'Medicina Veterinária',
  'med vet': 'Medicina Veterinária',
  'veterinaria': 'Medicina Veterinária',
  'veterinario': 'Medicina Veterinária',
  'mvz': 'Medicina Veterinária',
  'dvm': 'Medicina Veterinária',
  // Engenheiro Agrônomo
  'engenheiro agronomo': 'Agronomia',
  'engenheiro agronomo (a)': 'Agronomia',
  'engenheiro agronomo a': 'Agronomia',
  'eng agronomo': 'Agronomia',
  'agronomia': 'Agronomia',
  'agronomo': 'Agronomia',
  // Zootecnista
  'zootecnista': 'Zootecnia',
  'zootecnista (a)': 'Zootecnia',
  'zootecnista a': 'Zootecnia',
  'zootecnia': 'Zootecnia',
  // Biólogo
  'biologo': 'Biologia',
  'biologo (a)': 'Biologia',
  'biologo a': 'Biologia',
  'biologa': 'Biologia',
  'biologia': 'Biologia',
  // Engenheiro de Alimentos
  'engenheiro de alimentos': 'Engenharia de Alimentos',
  'engenheiro de alimentos (a)': 'Engenharia de Alimentos',
  'engenheiro de alimentos a': 'Engenharia de Alimentos',
  'eng alimentos': 'Engenharia de Alimentos',
  'engenharia alimentos': 'Engenharia de Alimentos',
  'engenharia de alimentos': 'Engenharia de Alimentos',
  // Engenheiro de Produção
  'engenheiro de producao': 'Engenharia de Produção',
  'engenheiro de producao (a)': 'Engenharia de Produção',
  'engenheiro de producao a': 'Engenharia de Produção',
  'eng producao': 'Engenharia de Produção',
  'engenharia producao': 'Engenharia de Produção',
  'engenharia de producao': 'Engenharia de Produção',
  // Administrador / Contador
  'administrador / contador': 'Administração',
  'administrador/contador': 'Administração',
  'administrador contador': 'Administração',
  'administracao/contabilidade': 'Administração',
  'administracao contabilidade': 'Administração',
  'administrador': 'Administração',
  'administrador (a)': 'Administração',
  'administrador a': 'Administração',
  'administradora': 'Administração',
  'contador': 'Administração',
  'contador (a)': 'Administração',
  'contador a': 'Administração',
  'contadora': 'Administração',
  'administracao': 'Administração',
  'contabilidade': 'Administração',
  // Advogado
  'advogado (a)': 'Direito',
  'advogado a': 'Direito',
  'advogado': 'Direito',
  'advogada': 'Direito',
  'direito': 'Direito',
  // Estudante
  'estudante da area': 'Estudante',
  'estudante': 'Estudante',
  // Outra área
  'sou formado em outra area': 'Outra área',
  'formado em outra area': 'Outra área',
  'outra area': 'Outra área',
  'outra formacao': 'Outra área',
  // Sem formação
  'nao possuo formacao': 'Sem formação superior',
  'sem formacao': 'Sem formação superior',
  'sem formacao superior': 'Sem formação superior',
};

function normalizarTexto(texto: string | null | undefined): string {
  if (!texto) return '';
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function calcularSimilaridade(str1: string, str2: string): number {
  const palavras1 = str1.split(' ').filter((p) => p.length > 1);
  const palavras2 = str2.split(' ').filter((p) => p.length > 1);
  if (palavras1.length === 0 || palavras2.length === 0) return 0;
  let matches = 0;
  for (const p1 of palavras1) {
    for (const p2 of palavras2) {
      if (p1 === p2) { matches += 1; break; }
      if (p1.includes(p2) || p2.includes(p1)) { matches += 0.8; break; }
    }
  }
  return matches / Math.max(palavras1.length, palavras2.length);
}

export function encontrarFormacao(inputFormacao: string | null | undefined): string {
  if (!inputFormacao) return inputFormacao ?? '';
  const inputNorm = normalizarTexto(inputFormacao);

  for (const oficial of FORMACOES_OFICIAIS) {
    if (normalizarTexto(oficial) === inputNorm) return oficial;
  }
  for (const [chave, valor] of Object.entries(MAPEAMENTOS_DIRETOS)) {
    if (normalizarTexto(chave) === inputNorm) return valor;
  }

  let melhorMatch: string | null = null;
  let melhorSimilaridade = 0;
  for (const [chave, valor] of Object.entries(MAPEAMENTOS_DIRETOS)) {
    const s = calcularSimilaridade(inputNorm, normalizarTexto(chave));
    if (s > melhorSimilaridade) { melhorSimilaridade = s; melhorMatch = valor; }
  }
  for (const oficial of FORMACOES_OFICIAIS) {
    const s = calcularSimilaridade(inputNorm, normalizarTexto(oficial));
    if (s > melhorSimilaridade) { melhorSimilaridade = s; melhorMatch = oficial; }
  }
  return melhorSimilaridade >= 0.5 && melhorMatch ? melhorMatch : inputFormacao;
}

// ── Contexto temporal (Brasília, UTC-3 fixo desde 2019) ─────────────────────

const DIAS_SEMANA: Record<number, string> = {
  0: 'Domingo', 1: 'Segunda-feira', 2: 'Terça-feira', 3: 'Quarta-feira',
  4: 'Quinta-feira', 5: 'Sexta-feira', 6: 'Sábado',
};

type Janela = { inicio: { h: number; m: number }; fim: { h: number; m: number } };

// Horários de funcionamento JÁ com buffer de 30 minutos (idem n8n).
const HORARIOS: Record<number, Janela[] | null> = {
  0: null,
  1: [{ inicio: { h: 9, m: 30 }, fim: { h: 11, m: 30 } }, { inicio: { h: 14, m: 30 }, fim: { h: 20, m: 30 } }],
  2: [{ inicio: { h: 9, m: 30 }, fim: { h: 11, m: 30 } }, { inicio: { h: 14, m: 30 }, fim: { h: 20, m: 30 } }],
  3: [{ inicio: { h: 9, m: 30 }, fim: { h: 11, m: 30 } }, { inicio: { h: 14, m: 30 }, fim: { h: 19, m: 30 } }],
  4: [{ inicio: { h: 9, m: 30 }, fim: { h: 11, m: 30 } }, { inicio: { h: 14, m: 30 }, fim: { h: 18, m: 30 } }],
  5: [{ inicio: { h: 9, m: 30 }, fim: { h: 11, m: 30 } }, { inicio: { h: 13, m: 30 }, fim: { h: 17, m: 30 } }],
  6: [{ inicio: { h: 8, m: 30 }, fim: { h: 11, m: 30 } }],
};

const fmt = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

const NOME_DIA: Record<number, string> = {
  0: 'domingo', 1: 'segunda-feira', 2: 'terça-feira', 3: 'quarta-feira',
  4: 'quinta-feira', 5: 'sexta-feira', 6: 'sábado',
};

// Próximo dia COM atendimento a partir de amanhã (pula domingo/qualquer dia sem janela em
// HORARIOS). Evita o "amanhã" fixo apontar pra um dia fechado (ex.: sábado pós-horário → domingo).
function proximoDiaAtendimento(diaSemana: number): string {
  for (let i = 1; i <= 7; i++) {
    const d = (diaSemana + i) % 7;
    const janelas = HORARIOS[d];
    if (janelas && janelas.length) {
      const ini = fmt(janelas[0].inicio.h, janelas[0].inicio.m);
      return i === 1
        ? `amanhã (${NOME_DIA[d]}) a partir das ${ini}`
        : `${NOME_DIA[d]} a partir das ${ini}`;
    }
  }
  return 'no próximo dia útil';
}

function verificarDisponibilidade(diaSemana: number, hora: number, minuto: number) {
  if (diaSemana === 0) {
    return { disponivel: false, mensagem: `⚠️ HOJE É DOMINGO - Não atendemos aos domingos. Próximo atendimento: ${proximoDiaAtendimento(diaSemana)}.` };
  }
  const periodos = HORARIOS[diaSemana]!;
  const minutoAtual = hora * 60 + minuto;

  for (let i = 0; i < periodos.length; i++) {
    const p = periodos[i];
    const ini = p.inicio.h * 60 + p.inicio.m;
    const fim = p.fim.h * 60 + p.fim.m;

    if (minutoAtual >= ini && minutoAtual < fim) {
      const horarioFim = fmt(p.fim.h, p.fim.m);
      if (i < periodos.length - 1) {
        const prox = periodos[i + 1];
        const periodoAtual = hora < 12 ? 'Pela manhã' : 'No período atual';
        const proximoPer = prox.inicio.h < 12 ? 'pela manhã' : 'à tarde/noite';
        return {
          disponivel: true,
          mensagem: `✅ ${periodoAtual} ainda atendemos hoje até ${horarioFim} e ${proximoPer} das ${fmt(prox.inicio.h, prox.inicio.m)} às ${fmt(prox.fim.h, prox.fim.m)}.`,
        };
      }
      return { disponivel: true, mensagem: `✅ Ainda temos atendimento hoje até ${horarioFim}.` };
    }

    if (minutoAtual < ini) {
      return {
        disponivel: false,
        mensagem: `⏰ Estamos em intervalo. Próximo atendimento hoje: ${fmt(p.inicio.h, p.inicio.m)} às ${fmt(p.fim.h, p.fim.m)}.`,
      };
    }
  }

  const ultimo = periodos[periodos.length - 1];
  return {
    disponivel: false,
    mensagem: `⚠️ ATENÇÃO: Já passou do último horário de hoje (${fmt(ultimo.fim.h, ultimo.fim.m)}). Próximo disponível: ${proximoDiaAtendimento(diaSemana)}.`,
  };
}

// Períodos ofertáveis hoje a partir de agora (noite só seg/ter, idem n8n).
function periodosDisponiveisHoje(diaSemana: number, hora: number, minuto: number) {
  const min = hora * 60 + minuto;
  const blocks = HORARIOS[diaSemana] ?? [];
  const set = new Set<string>();
  for (const b of blocks) {
    const ini = b.inicio.h * 60 + b.inicio.m;
    const fim = b.fim.h * 60 + b.fim.m;
    if (min >= fim) continue;
    const start = Math.max(min, ini);
    if (start < 720) set.add('manhã');
    if (start < 1140 && fim > 720) set.add('tarde');
    if (fim > 1140 && (diaSemana === 1 || diaSemana === 2)) set.add('noite');
  }
  const lista = ['manhã', 'tarde', 'noite'].filter((p) => set.has(p));
  let frase: string;
  if (lista.length === 0) frase = '';
  else if (lista.length === 1) frase = lista[0] === 'manhã' ? 'só de manhã' : `só a ${lista[0]}`;
  else frase = lista.slice(0, -1).join(', ') + ' ou ' + lista[lista.length - 1];
  return { lista, frase };
}

function agoraBrasilia(): { dia: number; hora: number; minuto: number; dataFormatada: string } {
  // Brasília = UTC-3 fixo (sem horário de verão desde 2019).
  const br = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    dia: br.getUTCDay(),
    hora: br.getUTCHours(),
    minuto: br.getUTCMinutes(),
    dataFormatada: `${pad(br.getUTCDate())}/${pad(br.getUTCMonth() + 1)}/${br.getUTCFullYear()}`,
  };
}

// Calendário dos próximos 7 dias, computado em CÓDIGO — o LLM erra conta de
// calendário (caso real 2026-07-04: achou que 07/07 era segunda, sendo terça, e
// confirmou a reunião com o dia da semana errado pro lead). Com o mapa pronto no
// contexto, o modelo nunca precisa derivar data↔dia-da-semana sozinho.
function calendarioProximosDias(): string {
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const linhas: string[] = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(Date.now() - 3 * 60 * 60 * 1000 + i * 24 * 60 * 60 * 1000);
    const data = `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
    const iso = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    linhas.push(`• ${data} (${iso}) = ${DIAS_SEMANA[d.getUTCDay()]}`);
  }
  return linhas.join('\n');
}

export function montarContextoTemporal(): string {
  const { dia, hora, minuto, dataFormatada } = agoraBrasilia();
  const status = verificarDisponibilidade(dia, hora, minuto);
  const periodos = periodosDisponiveisHoje(dia, hora, minuto);

  return `**AGORA: ${dataFormatada} às ${fmt(hora, minuto)}**
**DIA DA SEMANA: ${DIAS_SEMANA[dia]}**
${status.mensagem}

**PRÓXIMOS DIAS (data = dia da semana — use ESTA tabela, NUNCA calcule de cabeça):**
${calendarioProximosDias()}

**HORÁRIOS DE ATENDIMENTO DA SEMANA:**
• Segunda-feira: 09:30-11:30 e 14:30-20:30
• Terça-feira: 09:30-11:30 e 14:30-20:30
• Quarta-feira: 09:30-11:30 e 14:30-19:30
• Quinta-feira: 09:30-11:30 e 14:30-18:30
• Sexta-feira: 09:30-11:30 e 13:30-17:30
• Sábado: 08:30-11:30
• Domingo: Não atendemos

**PERÍODO QUE VOCÊ PODE OFERECER HOJE: ${periodos.frase || 'nenhum — ofereça o próximo dia útil'}**

${blocoElegibilidadeFormatura()}`;
}

// ── pergunta_formacao + render de placeholders dos prompts ──────────────────

const FORMACOES_VAGAS = ['Estudante', 'Outra área', 'Sem formação superior'];

export function montarPerguntaFormacao(formacaoNormalizada: string): string {
  // Só usa a forma de CONFIRMAÇÃO ("vc é formado em X, né?") quando X é uma
  // formação RECONHECIDA (lista oficial, não-vaga). Se o campo trouxer texto
  // livre/não mapeado (ex.: "Na faculdade entre o 9º e 10º Período"), cai na
  // pergunta ABERTA — senão sai "vc é formado em Na faculdade entre o 9º..., né?".
  const reconhecida = !!formacaoNormalizada
    && FORMACOES_OFICIAIS.includes(formacaoNormalizada)
    && !FORMACOES_VAGAS.includes(formacaoNormalizada);
  if (!reconhecida) {
    return 'só antes de eu fechar esse horário me confirma: qual é o seu curso de graduação? e o que te levou a buscar a pós agora?';
  }
  return `só antes de eu fechar esse horário me confirma: vc é formado em ${formacaoNormalizada}, né? e o que te levou a buscar a pós agora?`;
}

// Substitui os placeholders n8n mantidos nos prompts ({{ $json.nome }} etc.).
export function renderPrompt(prompt: string, vars: Record<string, string>): string {
  return prompt.replace(/\{\{\s*\$json\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, chave) => vars[chave] ?? m);
}

