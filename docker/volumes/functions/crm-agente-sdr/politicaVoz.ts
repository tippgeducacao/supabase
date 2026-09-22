import type { Msg } from './historico.ts';

export type OrigemVoz = 'followup' | 'conversa';

export type OpcoesPoliticaVoz = {
  /** O chamador só habilita depois de conferir configuração e canário no servidor. */
  habilitada?: boolean;
  origem: OrigemVoz;
  /** Texto final já aprovado pelas guardas de conteúdo, nunca raciocínio ou tool result. */
  texto: string;
  historico?: readonly Msg[];
  /** Contador persistido confirma o intervalo sorteado de 3 a 5 interações. Ausência conserva texto. */
  cadenciaAtingida?: boolean;
  /** @deprecated A etapa de follow-up não autoriza voz; use cadenciaAtingida. */
  etapaFollowup?: number;
  /** @deprecated A etapa de follow-up não autoriza voz; use cadenciaAtingida. */
  etapasFollowupPermitidas?: readonly number[];
  /** Contadores vêm do envio confirmado, nunca de decisão do modelo. */
  audiosEnviadosNaRodada?: number;
  ultimoEnvioFoiAudio?: boolean;
};

export type MotivoPoliticaVoz =
  | 'voz_desativada'
  | 'texto_curto'
  | 'texto_longo'
  | 'conteudo_para_escrita'
  | 'preferencia_texto'
  | 'limite_rodada'
  | 'audio_consecutivo'
  | 'intervalo_nao_atingido'
  | 'cadencia_atingida';

export type DecisaoPoliticaVoz = { permitido: boolean; motivo: MotivoPoliticaVoz };

type Preferencia = 'audio' | 'texto' | null;

const TAMANHO_MINIMO = 40;
const TAMANHO_MAXIMO = 600;

function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function textoDoLead(mensagem: Msg): string | null {
  if (mensagem?.role !== 'user') return null;
  // O protocolo da Anthropic usa role=user também para ferramentas. Um bloco text
  // auxiliar junto do resultado continua sendo contexto técnico, não consentimento.
  if (Array.isArray(mensagem.content)
    && mensagem.content.some((bloco) => bloco?.type === 'tool_result' || bloco?.type === 'tool_use')) return null;
  let texto = typeof mensagem.content === 'string' ? mensagem.content
    : Array.isArray(mensagem.content) ? mensagem.content
      .filter((bloco) => bloco?.type === 'text' && typeof bloco.text === 'string')
      .map((bloco) => bloco.text).join('\n') : '';
  if (!texto.trim()) return null;
  if (/\[(?:ATENDIMENTO_HUMANO|INTERNAL_|CORRECAO_INTERNA|CONTEXTO DO ATENDIMENTO|MENSAGEM DO LEAD AINDA)/i.test(texto)) return null;
  texto = texto
    .replace(/^\[MENSAGEM_LEAD_PAUSA\][^\n]*\n/i, '')
    .replace(/^\[Transcrição do áudio recebido do lead\]\s*/i, '')
    .replace(/\[Em resposta [^\]]*\]/gi, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/"[^"\n]*"|“[^”]*”|‘[^’]*’|'[^'\n]*'|`[^`]*`/g, ' ')
    .trim();
  return texto;
}

function preferenciaExplicita(texto: string): Preferencia {
  const frases = texto.split(/[.!?;\n,]+/).map(normalizar).filter(Boolean);
  // Lista curta de pedidos próprios. Não tenta classificar intenção comercial nem
  // deduzir preferência de um áudio recebido, de "sim" ou da fala de um vendedor.
  const prefereTexto = frases.some((frase) =>
    /\b(?:nao|nunca) (?:me )?(?:mande|manda|envie|envia)(?: mais| nenhum| outro| um| por| em)? (?:audio|audios|mensagem de voz)\b/.test(frase)
    || /\bnao (?:quero|gosto|aceito|posso|consigo|preciso|precisa|ouco|escuto)\b.{0,45}\b(?:audio|audios|voz|ouvir|escutar)\b/.test(frase)
    || /\bsem (?:mandar |enviar )?(?:audio|audios|mensagem de voz)\b/.test(frase)
    || /\b(?:prefiro|quero|gostaria|preciso)\b.{0,35}\b(?:texto|escrito|escrita|ler)\b/.test(frase)
    || /\b(?:so|somente|apenas) (?:receber |por )?(?:texto|escrito|mensagem escrita)\b/.test(frase)
    || /^(?:(?:voce )?pode |(?:me )?(?:manda|mande|envia|envie) )(?:me )?(?:mandar |enviar |responder |explicar )?(?:por escrito|em texto|por texto)(?: por favor)?$/.test(frase)
    || /^(?:prefiro ler|(?:so|somente|apenas) por mensagem|(?:pode |consegue )?(?:me )?escrever)(?: por favor)?$/.test(frase));
  if (prefereTexto) return 'texto'; // sinais conflitantes na mesma mensagem conservam texto

  // Pedido condicionado ou para depois não é autorização para a resposta atual.
  // Esta trava é só para autorizar áudio; nunca apaga preferência anterior por texto.
  if (/\b(?:se|quando|caso|amanha|depois)\b/.test(normalizar(texto))) return null;

  const pedeAudio = frases.some((frase) => {
    const pedido = frase.replace(/^(?:por favor |agora )/, '').replace(/ (?:por favor|pfv|agora)$/, '');
    // Âncoras completas evitam autorizar "se puder", "ela pediu", "vou mandar",
    // "não precisa mandar" ou uma pergunta sobre o áudio que o próprio lead enviou.
    return /^(?:(?:voce |vc )?(?:pode|poderia|consegue) (?:me )?(?:mandar|enviar|responder|explicar)|(?:me )?(?:manda|mande|envia|envie|responda|explica|explique)) (?:isso |a resposta )?(?:(?:por|em) )?(?:uma? )?(?:audio|mensagem de voz)$/.test(pedido)
      || /^(?:(?:eu )?(?:quero|prefiro) (?:receber )?)(?:(?:por|em) )?(?:uma? )?(?:audio|mensagem de voz)$/.test(pedido);
  });
  return pedeAudio ? 'audio' : null;
}

function preferenciaDoLead(historico: readonly Msg[]): Preferencia {
  let vigente: Preferencia = null;
  for (const mensagem of historico) {
    const texto = textoDoLead(mensagem);
    if (texto === null) continue;
    const ultimaPreferencia = preferenciaExplicita(texto);
    if (ultimaPreferencia) vigente = ultimaPreferencia;
  }
  return vigente;
}

function precisaEscrita(texto: string): boolean {
  const normalizado = normalizar(texto);
  // Dados copiáveis ficam disponíveis por escrito mesmo que o lead peça áudio.
  // No piloto, qualquer dígito também conserva texto: cobre horas, datas, telefone,
  // códigos, valores e quantidades sem tentar adivinhar qual deles é dispensável.
  return /\d|https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(texto)
    || /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|com\.br|org|net|edu|br|io|app)(?:\b|\/)/i.test(texto)
    || /[$€£¥%]|\b(?:brl|usd|eur|reais|real|dolares|euros|pix|cpf|cnpj|cep|senha|codigo|protocolo|endereco|e-mail|email)\b/.test(normalizado)
    || /\b(?:as|a partir das|ate as) (?:uma|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|catorze|quatorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte)\b/.test(normalizado)
    || /\b(?:meio[- ]dia|meia[- ]noite)\b/.test(normalizado);
}

/** Só decide modalidade; configuração, janela, pausa e aceite continuam no chamador. */
export function avaliarPoliticaVoz(opcoes: OpcoesPoliticaVoz): DecisaoPoliticaVoz {
  const negar = (motivo: MotivoPoliticaVoz): DecisaoPoliticaVoz => ({ permitido: false, motivo });
  if (opcoes.habilitada !== true) return negar('voz_desativada');
  const texto = opcoes.texto.trim();
  const tamanho = Array.from(texto).length;
  if (tamanho < TAMANHO_MINIMO) return negar('texto_curto');
  if (tamanho > TAMANHO_MAXIMO) return negar('texto_longo');
  if (precisaEscrita(texto)) return negar('conteudo_para_escrita');
  const preferencia = preferenciaDoLead(opcoes.historico ?? []);
  if (preferencia === 'texto') return negar('preferencia_texto');
  const enviados = opcoes.audiosEnviadosNaRodada ?? 0;
  if (!Number.isInteger(enviados) || enviados < 0 || enviados >= 1) return negar('limite_rodada');
  if (opcoes.ultimoEnvioFoiAudio === true) return negar('audio_consecutivo');
  // 22/09/2026: conversa e follow-up compartilham o intervalo de 3 a 5 interações,
  // sorteado e contado pelo chamador no banco. Pedido explícito só pode desfazer
  // preferência por texto; não antecipa a cadência nem cria um novo disparo.
  if (opcoes.cadenciaAtingida !== true) return negar('intervalo_nao_atingido');
  return { permitido: true, motivo: 'cadencia_atingida' };
}
