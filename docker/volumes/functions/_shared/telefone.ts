// Classificação de telefone — fonte ÚNICA da regra "esse número pode existir?".
//
// POR QUÊ (2026-08-18)
// A LP da Escola prefixa "55" mesmo quando o valor já tem DDI e trunca em 13 chars,
// perdendo os 2 últimos dígitos: nasce um número que PARECE celular BR mas nunca
// existiu. A Meta só recusa isso com 131026 ("Message undeliverable") DEPOIS de
// queimar o template. Entre 12/08 e 18/08/2026 a defesa foi jogar o número fora no
// intake (`crm-lead-webhook`) — o contato ficava sem telefone nenhum e o SDR nem
// sabia que tinha havido um número. Agora o número é SEMPRE gravado (o SDR vê o que
// a pessoa digitou, com um ícone de alerta ao lado) e o bloqueio mora onde o
// prejuízo acontece: no ENVIO (`crm-whatsapp-send`).
//
// ⚠️ ESPELHO NO FRONT: `src/components/crm-comercial/components/contato/contatoFormat.ts`
// (`telefoneImplausivelBR`) repete esta régua pro ícone da UI. Mudou aqui, muda lá.

/** Só os dígitos, sem o "0" de operadora antiga que algumas LPs ainda mandam ("+016997722712"). */
export function digitsTelefone(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "").replace(/^0+/, "");
}

/**
 * Tira o "0" de tronco (prefixo antigo de operadora) da frente do DDD. Nenhum DDD
 * brasileiro começa com 0, então esse zero nunca faz parte do número — e ele é comum
 * em quem digita "(0xx) …" no formulário: 176 contatos na base em 18/08/2026, dos
 * quais 167 viram números perfeitamente válidos só com essa remoção.
 *
 * ⚠️ Só tira quando o que SOBRA é um número nacional inteiro (10 ou 11 dígitos).
 * Sem essa condição, "5500999000000" (lixo digitado) viraria "999000000" e passaria
 * como telefone estrangeiro plausível.
 */
function semZeroDeTronco(nacional: string): string {
  const semZero = nacional.replace(/^0+/, "");
  return semZero.length === 10 || semZero.length === 11 ? semZero : nacional;
}

/**
 * Canonicaliza para 13 dígitos (55 + DDD + 9 + 8) A FIM DE JULGAR o número.
 *
 * ⚠️ NÃO é a chave de dedup. A chave segue sendo `canonicalBrPhone` dentro de
 * `crm-lead-webhook`/`crm-whatsapp-send`, que corta o "55" da frente sem olhar o
 * tamanho. Aqui o corte é CONDICIONADO ao comprimento porque DDD 55 existe (Santa
 * Maria/RS — 323 leads na base em 18/08/2026): em "5599912345" o "55" é DDD, não
 * DDI, e cortá-lo transformaria um número legítimo em impossível. Trocar a régua de
 * dedup por esta é melhoria separada (mexe em match de conversa já gravada).
 */
export function canonicalBrClassificacao(raw: string): string {
  let d = digitsTelefone(raw);
  // Só é DDI quando sobra um número nacional inteiro depois dele (10 ou 11 dígitos).
  if (d.length >= 12 && d.startsWith("55")) d = semZeroDeTronco(d.slice(2));
  if (d.length === 10 && ["6", "7", "8", "9"].includes(d[2])) {
    d = d.slice(0, 2) + "9" + d.slice(2); // insere o 9º dígito (só celular)
  }
  return `55${d}`;
}

/**
 * Dígitos que devem IR PRA META, dado o valor guardado no cadastro. Faz uma correção
 * só — o zero de tronco —, porque é a única que não muda a identidade do número.
 *
 * ⚠️ NÃO insere o 9º dígito de propósito: a Meta e a Uazapi tratam o 9 do celular BR
 * de formas diferentes no inbound (é por isso que existe `phoneVariants`), e mexer
 * nisso aqui mudaria o destino de mensagens que hoje funcionam.
 */
export function digitosParaEnvio(raw: string | null | undefined): string | null {
  const d = digitsTelefone(raw);
  if (!d) return null;
  const corrigido = d.startsWith("55") && d.length >= 12 ? `55${semZeroDeTronco(d.slice(2))}` : d;
  return corrigido.startsWith("55") ? corrigido : `55${corrigido}`;
}

/**
 * Telefone BR plausível: 55 + DDD (2 dígitos, nenhum começa com 0) + celular (9 + 8
 * dígitos) OU fixo (8 dígitos começando 2-5). Roda sobre o valor JÁ canonicalizado.
 * NÃO valida o DDD contra a lista real de 67 códigos — só descarta o que é
 * estruturalmente impossível.
 */
export function isTelefoneBrPlausivel(canon55: string): boolean {
  return /^55[1-9][1-9](?:9\d{8}|[2-5]\d{7})$/.test(canon55);
}

export type ClasseTelefone =
  /** Vazio — nada a dizer. */
  | "vazio"
  /** Número BR que pode existir. */
  | "br"
  /** Tem DDI estrangeiro / formato de fora — passa reto, não cabe a nós julgar. */
  | "internacional"
  /** Preenchido, mas estruturalmente impossível (o caso da LP truncada). */
  | "impossivel";

/**
 * Decide como tratar o número. A ordem importa:
 *
 * 1. FORMATO NACIONAL primeiro (10 dígitos, ou 11 com o 9 no 3º lugar) — assim
 *    "5599912345" é lido como DDD 55, não como DDI + número quebrado. Espelha a
 *    régua de `src/lib/sac/phone.ts` (normalizePhone).
 * 2. Depois DDI 55 + nacional (12–13 dígitos).
 * 3. Quem ANUNCIA DDI 55 e não cabe em 12–13 dígitos é impossível, nunca
 *    "internacional" — é o "+55+55 11 …" da LP que duplicou o DDI.
 * 4. O resto com 8–15 dígitos é estrangeiro legítimo (E.164) e passa: contato de
 *    fora não pode ser condenado por não caber numa régua brasileira.
 */
export function classificaTelefone(raw: string | null | undefined): ClasseTelefone {
  const bruto = (raw ?? "").trim();
  if (!bruto) return "vazio";
  const d = digitsTelefone(bruto);
  // Preenchido mas sem dígito nenhum ("Adão Vital Maciel Junior" no campo telefone —
  // 27 casos na base em 18/08/2026) é lixo, não é vazio: merece o alerta.
  if (!d) return "impossivel";

  const nacional = d.length === 10 || (d.length === 11 && d[2] === "9");
  // 14 dígitos entram aqui quando o extra é o zero de tronco ("55" + "0" + 11 díg.).
  const comDdi55 = d.startsWith("55") &&
    (d.length === 12 || d.length === 13 || (d.length === 14 && d[2] === "0"));
  if (nacional || comDdi55) {
    return isTelefoneBrPlausivel(canonicalBrClassificacao(d)) ? "br" : "impossivel";
  }
  if (d.startsWith("55")) return "impossivel";
  return d.length >= 8 && d.length <= 15 ? "internacional" : "impossivel";
}

/** Atalho do caminho de ENVIO: só barra o que é impossível; internacional segue. */
export function telefoneEnviavel(raw: string | null | undefined): boolean {
  const c = classificaTelefone(raw);
  return c === "br" || c === "internacional";
}
