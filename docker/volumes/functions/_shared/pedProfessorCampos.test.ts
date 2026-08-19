import { describe, expect, it } from "vitest";

import { documentoPagamentoTexto, resolverCampoProfessor } from "./pedProfessorCampos";
import { resolverCampoProfessor as resolverNoApp } from "../../../src/components/pedagogico-v2/utils/waTemplateCampos";

/**
 * O {{4}} do template `pos_aula_status_v2_v2` ("Envie sua {{4}} por aqui") tem
 * duas travas que já quebraram em produção:
 *
 *  1. NUNCA pode conter "recibo" — a PPG aceita só nota fiscal, e a mensagem
 *     automática contradizia a cobrança manual no mesmo chat (2026-08-19);
 *  2. NUNCA pode ser vazio — parâmetro vazio faz a Meta recusar o template
 *     inteiro (erro 131008) e o professor não recebe nada.
 *
 * E o resolvedor vive em DOIS lugares (edge da cadência + envio manual no SAC):
 * o teste cobre os dois juntos para o espelho não voltar a divergir.
 */

// Tudo que existe hoje em ped_professores.forma_pagamento + variações do campo livre.
const FORMAS = [
  null,
  undefined,
  "",
  "   ",
  "NOTA FISCAL",
  "NF",
  "nota fiscal",
  "RECIBO",
  "recibo assinado",
  "NOTAS FISCAIS OU RECIBO",
  "PIX",
  "NÃO SE APLICA",
];

describe("documento de pagamento do professor ({{4}} do pós-aula)", () => {
  it.each(FORMAS)("nunca diz 'recibo' — forma_pagamento=%p", (forma) => {
    const texto = documentoPagamentoTexto(forma);
    expect(texto.toLowerCase()).not.toContain("recibo");
    expect(texto).toBe("nota fiscal");
  });

  it.each(FORMAS)("nunca é vazio (Meta 131008) — forma_pagamento=%p", (forma) => {
    expect(documentoPagamentoTexto(forma).trim()).not.toBe("");
  });

  it.each(FORMAS)("edge e app dão a MESMA frase — forma_pagamento=%p", (forma) => {
    const prof = { forma_pagamento: forma };
    expect(resolverNoApp("professor.documento_pagamento", prof)).toBe(
      resolverCampoProfessor("professor.documento_pagamento", prof),
    );
  });
});
