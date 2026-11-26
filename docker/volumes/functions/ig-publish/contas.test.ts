import { describe, expect, it } from "vitest";
import {
  SUBCODE_CONTA_INACESSIVEL, avisoDeContasDeFora, contasRecusadas, semAsContas, separarContas,
} from "./contas";

// As mensagens abaixo são as que a Meta devolveu de verdade (ig_scheduled_posts.error_message, 23/09 a 26/11/2026).
const RECUSA_ANDER =
  "Não é possível carregar um usuário com um perfil privado ou nome de usuário inválido — Os seguintes usuários não podem ser acessados: ander.bedin12 (subcode 2207018)";
const RECUSA_ANALICE =
  "Não é possível carregar um usuário com um perfil privado ou nome de usuário inválido — Os seguintes usuários não podem ser acessados: analiceftelles (subcode 2207018)";
const RECUSA_PPGVET_PONTO =
  "Carousel item error: Não é possível carregar um usuário com um perfil privado ou nome de usuário inválido — Os seguintes usuários não podem ser acessados: ppgvet.oficial (subcode 2207018)";

describe("separarContas — o texto gravado em Marcar Perfis/Collab", () => {
  it("separa por vírgula, ESPAÇO, ponto e vírgula e quebra de linha, e tira o @", () => {
    // O post das 18:19 de 26/11/2026 tinha "@laura_camilotti @analiceftelles": só com vírgula, virava UM nome.
    expect(separarContas("@laura_camilotti @analiceftelles")).toEqual(["laura_camilotti", "analiceftelles"]);
    expect(separarContas("ander.bedin12, wellinton_molinetti, raafaelcostta"))
      .toEqual(["ander.bedin12", "wellinton_molinetti", "raafaelcostta"]);
    expect(separarContas("@laura_camilotti,  @analiceftelles")).toEqual(["laura_camilotti", "analiceftelles"]);
    expect(separarContas("a;b\nc")).toEqual(["a", "b", "c"]);
  });

  it("vazio ou nulo: nenhuma conta", () => {
    expect(separarContas(null)).toEqual([]);
    expect(separarContas(undefined)).toEqual([]);
    expect(separarContas("  , @ ")).toEqual([]);
  });

  it("não repete a conta, sem olhar maiúscula (vale a 1ª grafia)", () => {
    expect(separarContas("PPGVET_oficial, ppgvet_oficial, @ppgvet_oficial")).toEqual(["PPGVET_oficial"]);
  });
});

describe("contasRecusadas — quem a Meta não deixou marcar", () => {
  it("o subcode é o da recusa de conta (perfil privado ou que não existe)", () => {
    expect(SUBCODE_CONTA_INACESSIVEL).toBe(2207018);
  });

  it("acha SÓ a conta citada na mensagem: as outras seguem marcadas", () => {
    const contas = ["ander.bedin12", "wellinton_molinetti", "raafaelcostta"];
    expect(contasRecusadas(RECUSA_ANDER, contas)).toEqual(["ander.bedin12"]);
    expect(contasRecusadas(RECUSA_ANALICE, ["laura_camilotti", "analiceftelles"])).toEqual(["analiceftelles"]);
    expect(contasRecusadas(RECUSA_PPGVET_PONTO, ["ppgvet.oficial", "amperefutsal"])).toEqual(["ppgvet.oficial"]);
  });

  it("palavra inteira: 'ander.bedin12' não derruba 'ander.bedin123', nem 'ander' sozinho", () => {
    expect(contasRecusadas(RECUSA_ANDER, ["ander.bedin123", "ander", "ander.bedin12"])).toEqual(["ander.bedin12"]);
    // E 'ppgvet' (prefixo de 'ppgvet.oficial') não é a conta recusada.
    expect(contasRecusadas(RECUSA_PPGVET_PONTO, ["ppgvet", "ppgvet.oficial"])).toEqual(["ppgvet.oficial"]);
  });

  it("ponto final de frase e maiúscula não atrapalham", () => {
    expect(contasRecusadas("Users cannot be accessed: Fulano.Tal.", ["fulano.tal", "outra"])).toEqual(["fulano.tal"]);
    expect(contasRecusadas("acessados: a_b, c.d", ["a_b", "c.d", "e"])).toEqual(["a_b", "c.d"]);
  });

  it("nenhuma conta achada no texto: devolve TODAS (melhor sair sem marcação do que não sair)", () => {
    expect(contasRecusadas("Invalid parameter (subcode 2207018)", ["a", "b"])).toEqual(["a", "b"]);
    expect(contasRecusadas("", ["a"])).toEqual(["a"]);
  });
});

describe("semAsContas", () => {
  it("tira sem olhar maiúscula e mantém a ordem do resto", () => {
    expect(semAsContas(["Ander.Bedin12", "wellinton_molinetti", "raafaelcostta"], ["ander.bedin12"]))
      .toEqual(["wellinton_molinetti", "raafaelcostta"]);
    expect(semAsContas([], ["a"])).toEqual([]);
  });
});

describe("avisoDeContasDeFora — o que fica escrito no post e vai ao sino", () => {
  it("saiu completo: sem aviso", () => {
    expect(avisoDeContasDeFora([], ["a"], ["a"])).toBeNull();
  });

  it("a conta estava nos dois campos (o caso de 22/11): diz quem, de onde e o que fazer", () => {
    const todos = ["ander.bedin12", "wellinton_molinetti", "raafaelcostta"];
    expect(avisoDeContasDeFora(["ander.bedin12"], todos, todos)).toBe(
      "Publicado sem @ander.bedin12 nas marcações e no collab: o Instagram não aceita, pela integração, "
      + "perfil privado ou que não existe. Se o perfil existe, dá para marcar à mão no app do Instagram, editando o post.",
    );
  });

  it("só na marcação, só no collab, e mais de uma conta", () => {
    expect(avisoDeContasDeFora(["x"], ["x"], [])).toContain("Publicado sem @x nas marcações:");
    expect(avisoDeContasDeFora(["x"], [], ["x"])).toContain("Publicado sem @x no collab:");
    const varias = avisoDeContasDeFora(["a", "b", "c"], ["a", "b", "c"], []);
    expect(varias).toContain("Publicado sem @a, @b e @c nas marcações:");
    expect(varias).toContain("Se os perfis existem,");
    expect(avisoDeContasDeFora(["a", "b"], ["a"], ["b"])).toContain("Publicado sem @a e @b nas marcações e no collab:");
  });
});
