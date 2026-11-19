// Quais avisos de teste A/B vão para o sino hoje (pedido do usuário, 19/11/2026). Função pura: a edge busca os
// números, monta o detalhe com a MESMA conta da tela (`_shared/testeAbDetalhe.ts`) e só grava o que sai daqui.
// Não repetir é do banco: `mkt_testes_ab_avisar` grava (chave, tipo, assinatura) e ignora o que já avisou.

import { ROTULO_SITUACAO, type DetalheAb, type Situacao, type TesteAb } from "../_shared/testeAbDetalhe.ts";

export type TipoAviso = "leitura" | "terminou" | "problema" | "resumo";

export interface Aviso {
  chave: string;
  tipo: TipoAviso;
  /** O que torna o aviso único: mudou a assinatura, é aviso novo. */
  assinatura: string;
  titulo: string;
  corpo: string;
  link: string;
}

const TERMINOU: Partial<Record<Situacao, string>> = { "b-ganha": "B ganhou", "b-perde": "B perdeu", inconclusivo: "inconclusivo" };

const pct = (v: number | null) =>
  v === null ? "—" : (100 * v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";
const num = (v: number) => Math.trunc(v).toLocaleString("pt-BR");

export const linkDoTeste = (chave: string) => `/portal-marketing/analytics?aba=ab&teste=${encodeURIComponent(chave)}`;

/** Os problemas que a tela mostra em vermelho, cada um com uma chave que não muda de um dia para o outro. */
function problemas(d: DetalheAb): { assinatura: string; texto: string }[] {
  const out: { assinatura: string; texto: string }[] = [];
  const ch = d.checagens;
  const torta = d.avisos.find((x) => x.startsWith("Divisão torta"));
  if (!ch.divisao.ok && torta) out.push({ assinatura: `divisao:${ch.divisao.desde ?? "total"}`, texto: torta });
  const guarda = d.avisos.find((x) => x.startsWith("Lead qualificado piorou"));
  if (guarda) out.push({ assinatura: "guarda", texto: guarda });
  const recomecou = d.avisos.find((x) => x.startsWith("A leitura recomeçou"));
  if (recomecou && d.leitura?.recomecou) out.push({ assinatura: `recomecou:${d.leitura.recomecou}`, texto: recomecou });
  const sv = d.saude.semVersao;
  if (sv && sv.sem > 0) {
    out.push({
      assinatura: "sem-versao",
      texto: `Leads sem versão: ${pct(sv.leads ? sv.sem / sv.leads : 0)} (${num(sv.sem)} de ${num(sv.leads)}). Não leia o resultado até achar a causa.`,
    });
  }
  // "Versão sem ninguém hoje" fica de fora: às 8h o dia mal começou, e a divisão dia a dia já pega no dia seguinte.
  return out;
}

/** `resumo` = é segunda (ou pedido à mão): um resumo por teste rodando. */
export function avisosDoDia(testes: TesteAb[], detalhes: Map<string, DetalheAb>, resumo: boolean, hoje: string): Aviso[] {
  const out: Aviso[] = [];
  for (const t of testes) {
    const d = detalhes.get(t.chave);
    if (!d || t.situacao !== "rodando") continue;
    const base = { chave: t.chave, link: linkDoTeste(t.chave) };
    const nome = `Teste A/B "${t.nome}"`;

    for (const p of problemas(d)) {
      out.push({ ...base, tipo: "problema", assinatura: p.assinatura, titulo: `${nome} com problema nos dados`, corpo: p.texto });
    }
    const fim = TERMINOU[d.situacao];
    if (fim) {
      const rel = d.leitura ? `${d.leitura.rel > 0 ? "+" : ""}${pct(d.leitura.rel)}` : "—";
      out.push({
        ...base, tipo: "terminou", assinatura: d.situacao, titulo: `${nome} terminou: ${fim}`,
        corpo: `Certeza ${pct(d.certeza)}, efeito ${rel}. Abra o teste e escolha qual versão fica.`,
      });
    } else if (d.situacao === "sem-resposta" && d.certeza !== null) {
      out.push({
        ...base, tipo: "leitura", assinatura: "leitura", titulo: `${nome} já pode ser lido`,
        corpo: `Completou 7 dias e o mínimo de pessoas e leads. Certeza agora: ${pct(d.certeza)}.`,
      });
    }
    if (resumo) {
      const [a, b] = d.versoes;
      const minimo = Math.min(a?.pessoas ?? 0, b?.pessoas ?? 0);
      const plano = t.plano?.pessoas ? ` (${pct(minimo / t.plano.pessoas)} do plano)` : "";
      const certeza = d.certeza === null ? "" : ` · certeza ${pct(d.certeza)}`;
      out.push({
        ...base, tipo: "resumo", assinatura: hoje, titulo: `${nome}: resumo da semana`,
        corpo: `${num(a?.pessoas ?? 0)} × ${num(b?.pessoas ?? 0)} pessoas por versão${plano}${certeza} · ${ROTULO_SITUACAO[d.situacao]}.`,
      });
    }
  }
  return out;
}
