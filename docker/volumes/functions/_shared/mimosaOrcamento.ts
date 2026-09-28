/**
 * Calculadora de orçamento da Mimosa de Vendas.
 *
 * A IA não faz conta: "12.730,00 com 20% de bolsa em 24x, matrícula 492,50 com 60%"
 * chega aqui e volta pronto. É o pedido mais comum dos vendedores no copiloto (medido
 * em set/2026) e conta de cabeça de modelo de linguagem erra centavo.
 *
 * Mesma régua da Proposta Formalizada (`src/lib/propostaFormal/calculos.ts`):
 *   - valor final = integral × (1 − bolsa%), em centavos;
 *   - a ENTRADA sai do valor antes de dividir (parcelar o cheio e ainda cobrar entrada
 *     faz a condição somar mais do que o combinado);
 *   - parcela = (final − entrada) ÷ parcelas, arredondada no centavo.
 * E uma regra a mais, porque aqui o número vai direto para o lead: se as N parcelas
 * iguais não fecham o valor por causa do centavo, o resultado DIZ a diferença e quanto
 * ficaria a última parcela — nunca esconde (regra de ouro 5: nada arredondado calado).
 *
 * Tudo em centavos inteiros: 27429 × 0,9 = 24686,100000000002 em ponto flutuante.
 */

export interface EntradaOrcamento {
  valor_integral: number;
  desconto_percentual?: number | null;
  valor_final?: number | null;
  parcelas?: number | null;
  entrada?: number | null;
  matricula?: number | null;
  desconto_matricula_percentual?: number | null;
  primeiro_vencimento?: string | null;
}

export interface ResultadoOrcamento {
  valor_integral: string;
  desconto_percentual: string | null;
  desconto_em_reais: string | null;
  valor_final: string;
  entrada: string | null;
  parcelas: number;
  valor_parcela: string;
  ultima_parcela: string | null;
  soma_das_parcelas: string;
  matricula: string | null;
  desconto_matricula_percentual: string | null;
  matricula_final: string | null;
  total_com_matricula: string;
  primeiro_vencimento: string | null;
  ultimo_vencimento: string | null;
  resumo: string;
  avisos: string[];
}

export class ErroOrcamento extends Error {}

const LIMITE = 99_999_999.99;

function centavos(valor: number): number {
  return Math.round(valor * 100);
}

/** 1234567 centavos → "R$ 12.345,67". Manual para não depender do ICU do runtime. */
export function formatarBRL(emCentavos: number): string {
  const negativo = emCentavos < 0;
  const abs = Math.abs(Math.round(emCentavos));
  const inteiro = Math.floor(abs / 100).toString();
  const decimais = (abs % 100).toString().padStart(2, "0");
  const milhares = inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negativo ? "-" : ""}R$ ${milhares},${decimais}`;
}

/** 20 → "20,00%"; 12.5 → "12,50%". Sempre 2 casas. */
function formatarPercentual(p: number): string {
  return `${formatarBRL(Math.round(p * 100)).replace("R$ ", "")}%`;
}

function numeroOpcional(valor: unknown, campo: string): number | null {
  if (valor == null || valor === "") return null;
  const n = typeof valor === "number" ? valor : Number(String(valor).replace(",", "."));
  if (!Number.isFinite(n)) throw new ErroOrcamento(`${campo}: informe um número.`);
  return n;
}

/** "2026-10-25" + 23 meses, segurando o dia no fim do mês (31/01 → 28/02). */
export function somarMeses(iso: string, meses: number): string {
  const [a, m, d] = iso.split("-").map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + meses, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimoDia));
  return alvo.toISOString().slice(0, 10);
}

function dataBR(iso: string): string {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

function dataValida(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const dt = new Date(`${iso}T12:00:00Z`);
  return Number.isFinite(dt.getTime()) && dt.toISOString().slice(0, 10) === iso;
}

export function calcularOrcamento(entrada: EntradaOrcamento): ResultadoOrcamento {
  const avisos: string[] = [];

  const integral = numeroOpcional(entrada.valor_integral, "valor_integral");
  if (integral == null || integral <= 0 || integral > LIMITE) {
    throw new ErroOrcamento("valor_integral: informe o valor integral do curso (maior que zero).");
  }
  const pct = numeroOpcional(entrada.desconto_percentual, "desconto_percentual");
  if (pct != null && (pct < 0 || pct > 100)) {
    throw new ErroOrcamento("desconto_percentual: use um número entre 0 e 100.");
  }
  const finalInformado = numeroOpcional(entrada.valor_final, "valor_final");
  if (finalInformado != null && (finalInformado <= 0 || finalInformado > LIMITE)) {
    throw new ErroOrcamento("valor_final: informe um valor maior que zero.");
  }
  const parcelasBrutas = numeroOpcional(entrada.parcelas, "parcelas") ?? 1;
  if (!Number.isInteger(parcelasBrutas) || parcelasBrutas < 1 || parcelasBrutas > 48) {
    throw new ErroOrcamento("parcelas: use um número inteiro de 1 a 48.");
  }
  const parcelas = parcelasBrutas;
  const entradaValor = numeroOpcional(entrada.entrada, "entrada");
  if (entradaValor != null && entradaValor < 0) throw new ErroOrcamento("entrada: não pode ser negativa.");
  const matricula = numeroOpcional(entrada.matricula, "matricula");
  if (matricula != null && (matricula < 0 || matricula > LIMITE)) {
    throw new ErroOrcamento("matricula: informe um valor válido.");
  }
  const pctMat = numeroOpcional(entrada.desconto_matricula_percentual, "desconto_matricula_percentual");
  if (pctMat != null && (pctMat < 0 || pctMat > 100)) {
    throw new ErroOrcamento("desconto_matricula_percentual: use um número entre 0 e 100.");
  }
  const primeiro = entrada.primeiro_vencimento ? String(entrada.primeiro_vencimento).slice(0, 10) : null;
  if (primeiro && !dataValida(primeiro)) {
    throw new ErroOrcamento("primeiro_vencimento: use a data no formato AAAA-MM-DD.");
  }

  const integralC = centavos(integral);
  // Valor fechado na negociação manda; a bolsa só SUGERE (mesma régua da proposta).
  const finalC = finalInformado != null
    ? centavos(finalInformado)
    : Math.round((integralC * (100 - (pct ?? 0))) / 100);

  if (finalInformado != null && pct != null) {
    const esperadoC = Math.round((integralC * (100 - pct)) / 100);
    if (Math.abs(esperadoC - finalC) > 100) {
      avisos.push(
        `Com ${formatarPercentual(pct)} de bolsa o valor daria ${formatarBRL(esperadoC)}; foi usado o valor final informado, ${formatarBRL(finalC)}.`,
      );
    }
  }
  if (finalC > integralC) avisos.push("O valor final ficou MAIOR que o integral — confira a condição.");

  const descontoC = integralC - finalC;
  const entradaC = entradaValor != null ? centavos(entradaValor) : 0;
  if (entradaC >= finalC) throw new ErroOrcamento("entrada: precisa ser menor que o valor final.");

  const baseC = finalC - entradaC;
  const parcelaC = Math.round(baseC / parcelas);
  const somaC = parcelaC * parcelas;
  const diferencaC = baseC - somaC;
  const ultimaC = parcelaC + diferencaC;
  if (diferencaC !== 0) {
    avisos.push(
      `${parcelas} parcelas de ${formatarBRL(parcelaC)} somam ${formatarBRL(somaC)}: ${diferencaC > 0 ? "faltam" : "sobram"} ${formatarBRL(Math.abs(diferencaC))} de arredondamento. Para fechar exato, a última parcela seria ${formatarBRL(ultimaC)}.`,
    );
  }

  const matriculaC = matricula != null ? centavos(matricula) : null;
  const matriculaFinalC = matriculaC != null ? Math.round((matriculaC * (100 - (pctMat ?? 0))) / 100) : null;
  const totalC = finalC + (matriculaFinalC ?? 0);

  const ultimoVenc = primeiro && parcelas > 1 ? somarMeses(primeiro, parcelas - 1) : primeiro;

  const partes: string[] = [`Valor integral ${formatarBRL(integralC)}`];
  if (descontoC > 0) {
    const pctEfetivo = (descontoC / integralC) * 100;
    partes.push(`bolsa de ${formatarPercentual(pct ?? pctEfetivo)} (${formatarBRL(descontoC)})`);
  }
  partes.push(`valor final ${formatarBRL(finalC)}`);
  if (entradaC > 0) partes.push(`entrada de ${formatarBRL(entradaC)}`);
  partes.push(parcelas === 1 ? "à vista" : `${parcelas}x de ${formatarBRL(parcelaC)}`);
  if (matriculaFinalC != null) {
    partes.push(
      pctMat ? `matrícula ${formatarBRL(matriculaFinalC)} (de ${formatarBRL(matriculaC!)}, ${formatarPercentual(pctMat)} off)` : `matrícula ${formatarBRL(matriculaFinalC)}`,
    );
  }
  if (primeiro) {
    partes.push(parcelas > 1 ? `vencimentos de ${dataBR(primeiro)} a ${dataBR(ultimoVenc!)}` : `vencimento ${dataBR(primeiro)}`);
  }

  return {
    valor_integral: formatarBRL(integralC),
    desconto_percentual: pct != null ? formatarPercentual(pct) : descontoC > 0 ? formatarPercentual((descontoC / integralC) * 100) : null,
    desconto_em_reais: descontoC > 0 ? formatarBRL(descontoC) : null,
    valor_final: formatarBRL(finalC),
    entrada: entradaC > 0 ? formatarBRL(entradaC) : null,
    parcelas,
    valor_parcela: formatarBRL(parcelaC),
    ultima_parcela: diferencaC !== 0 ? formatarBRL(ultimaC) : null,
    soma_das_parcelas: formatarBRL(somaC),
    matricula: matriculaC != null ? formatarBRL(matriculaC) : null,
    desconto_matricula_percentual: pctMat ? formatarPercentual(pctMat) : null,
    matricula_final: matriculaFinalC != null ? formatarBRL(matriculaFinalC) : null,
    total_com_matricula: formatarBRL(totalC),
    primeiro_vencimento: primeiro ? dataBR(primeiro) : null,
    ultimo_vencimento: ultimoVenc ? dataBR(ultimoVenc) : null,
    resumo: `${partes.join(" · ")}.`,
    avisos,
  };
}
