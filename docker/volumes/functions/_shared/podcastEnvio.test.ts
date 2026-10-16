import { describe, expect, it } from "vitest";
import { linkAgendaDoCandidato, parametrosDoModelo, renderModelo, resolverVarPodcast, usosDoAgendamento } from "./podcastEnvio";

describe("usosDoAgendamento", () => {
  it("com link: texto novo primeiro, antigo de reserva; sem link: só o antigo", () => {
    expect(usosDoAgendamento(1, "https://calendly.com/x")).toEqual(["podcast_agenda_1_link", "podcast_agenda_1"]);
    expect(usosDoAgendamento(2, null)).toEqual(["podcast_agenda_2"]);
    expect(usosDoAgendamento(3, "")).toEqual(["podcast_agenda_3"]);
  });
});

// O sorteio do host mora na RPC; aqui só se protege a leitura do retorno: a linha vem em array
// (RETURNS TABLE), sem linha = sem link, e erro da RPC não derruba o envio (vira "sem link").
describe("linkAgendaDoCandidato", () => {
  const admin = (data: unknown, error: unknown = null) => ({
    rpc: async (nome: string, args: unknown) => {
      expect(nome).toBe("pod_link_agenda_do_candidato");
      expect(args).toEqual({ p_candidato_id: "c1" });
      return { data, error };
    },
  });
  it("devolve o link e o host sorteado", async () => {
    const r = await linkAgendaDoCandidato(admin([{ link: " https://calendly.com/h/petfood ", host_id: "h1" }]), "c1");
    expect(r).toEqual({ link: "https://calendly.com/h/petfood", hostId: "h1" });
  });
  it("link único do podcast vem sem host", async () => {
    expect(await linkAgendaDoCandidato(admin([{ link: "https://calendly.com/p", host_id: null }]), "c1"))
      .toEqual({ link: "https://calendly.com/p", hostId: null });
  });
  it("sem linha ou com erro: null", async () => {
    expect(await linkAgendaDoCandidato(admin([]), "c1")).toBeNull();
    expect(await linkAgendaDoCandidato(admin(null, { message: "boom" }), "c1")).toBeNull();
  });
});

/**
 * O resolvedor decide por PEDAÇO do nome da variável. O que se protege:
 *  · os mapeamentos reais dos modelos de podcast (banco, 14/10/2026) saem com o valor certo;
 *  · `nome_podcast` cai em podcast, não em nome (a ordem dos testes no resolvedor);
 *  · variável sem valor é DENUNCIADA em `vazios` — a Meta recusa o modelo inteiro com um
 *    parâmetro vazio, e o link da agenda é o caso em que isso acontece (podcast sem link).
 */
const ctx = {
  nome: "Maria",
  podcast: "Suinocast",
  youtube: "https://youtube.com/@suinocast",
  linkAgenda: "https://calendly.com/suinocast/gravacao",
  plataforma: "Zencastr",
};

describe("resolverVarPodcast", () => {
  it("resolve os nomes usados nos modelos", () => {
    expect(resolverVarPodcast("nome_convidado", ctx)).toBe("Maria");
    expect(resolverVarPodcast("nome_podcast", ctx)).toBe("Suinocast");
    expect(resolverVarPodcast("youtube_url", ctx)).toBe("https://youtube.com/@suinocast");
    expect(resolverVarPodcast("link_agenda", ctx)).toBe("https://calendly.com/suinocast/gravacao");
    expect(resolverVarPodcast("plataforma_gravacao", ctx)).toBe("Zencastr");
  });

  it("desconhecido sai vazio, sem chutar", () => {
    expect(resolverVarPodcast("link_acesso", ctx)).toBe("");
    expect(resolverVarPodcast("", ctx)).toBe("");
  });
});

describe("parametrosDoModelo", () => {
  it("podcast_agenda_1_v2: {{3}} no meio do texto, parâmetros na ordem do número", () => {
    const r = parametrosDoModelo({ "1": "nome_convidado", "2": "nome_podcast", "3": "link_agenda" }, ctx);
    expect(r.params.map((p) => p.text)).toEqual(["Maria", "Suinocast", "https://calendly.com/suinocast/gravacao"]);
    expect(r.vazios).toEqual([]);
    const corpo = "Olá {{1}}!\n\n🔗 Agenda: {{3}}\n\nsua gravação no {{2}} Podcast";
    expect(renderModelo(corpo, r.params)).toBe(
      "Olá Maria!\n\n🔗 Agenda: https://calendly.com/suinocast/gravacao\n\nsua gravação no Suinocast Podcast",
    );
  });

  it("podcast sem link: denuncia a variável vazia", () => {
    const r = parametrosDoModelo({ "1": "nome_convidado", "2": "nome_podcast", "3": "link_agenda" }, { ...ctx, linkAgenda: null });
    expect(r.vazios).toEqual(["link_agenda"]);
  });

  it("mapping ausente cai no padrão nome + podcast (como o motor sempre fez)", () => {
    expect(parametrosDoModelo(null, ctx).params.map((p) => p.text)).toEqual(["Maria", "Suinocast"]);
  });

  it("parâmetro com quebra de linha é achatado (a Meta recusa \\n em parâmetro)", () => {
    const r = parametrosDoModelo({ "1": "nome_convidado" }, { ...ctx, nome: "Maria\nJosé" });
    expect(r.params[0].text).toBe("Maria José");
  });
});
