// Texto do e-mail de reunião para o embaixador. Puro (sem Deno) para rodar no vitest.

export interface AvisoPendente {
  agendamento_id: string;
  embaixador_id: string;
  data_agendamento: string;
  tipo: "marcada" | "remarcada" | "cancelada";
  email: string;
  embaixador: string;
  indicado: string;
  consultor: string;
  pos: string | null;
  link: string | null;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "quinta-feira, 26/11, às 19:00" no horário de Brasília. */
export function quandoPorExtenso(iso: string): string {
  const d = new Date(iso);
  const fuso = "America/Sao_Paulo";
  const dia = new Intl.DateTimeFormat("pt-BR", { timeZone: fuso, weekday: "long", day: "2-digit", month: "2-digit" }).format(d);
  const hora = new Intl.DateTimeFormat("pt-BR", { timeZone: fuso, hour: "2-digit", minute: "2-digit" }).format(d);
  return `${dia}, às ${hora}`;
}

export function emailDeReuniao(a: AvisoPendente, urlDaAgenda: string) {
  const quando = quandoPorExtenso(a.data_agendamento);
  const titulo = { marcada: "Reunião marcada", remarcada: "Reunião remarcada", cancelada: "Reunião cancelada" }[a.tipo];
  const assunto = `${titulo}: ${a.indicado}, ${quando}`;
  const com = a.consultor ? ` com ${a.consultor}` : "";
  const sobre = a.pos ? ` (${a.pos})` : "";
  const frase = a.tipo === "cancelada"
    ? `A reunião de ${a.indicado}${sobre}, que seria ${quando}, foi cancelada.`
    : `A reunião de ${a.indicado}${sobre}${com} ${a.tipo === "remarcada" ? "passou para" : "é"} ${quando} (horário de Brasília).`;
  const participe = a.tipo === "cancelada"
    ? ""
    : "Entre no horário e se apresente ao indicado: com a sua participação, a matrícula vale o dobro. O consultor não espera.";
  const sala = a.tipo !== "cancelada" && a.link ? a.link : null;
  const botao = (href: string, rotulo: string) =>
    `<p style="margin:0 0 14px"><a href="${esc(href)}" style="display:inline-block;padding:10px 18px;background:#7B2D7E;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">${rotulo}</a></p>`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#1f2937;line-height:1.55;max-width:520px">
  <p style="margin:0 0 12px">Olá, ${esc(a.embaixador.split(" ")[0])}.</p>
  <p style="margin:0 0 12px"><strong>${esc(frase)}</strong></p>
  ${participe ? `<p style="margin:0 0 16px">${esc(participe)}</p>` : ""}
  ${sala ? botao(sala, "Entrar na reunião") : a.tipo !== "cancelada" ? `<p style="margin:0 0 12px">O link da sala aparece na sua agenda.</p>` : ""}
  <p style="margin:0 0 12px"><a href="${esc(urlDaAgenda)}" style="color:#7B2D7E">Ver a minha agenda</a></p>
  <p style="margin:0;font-size:12px;color:#6b7280">PPGVET Educação · Programa de Embaixadores</p>
</div>`;
  const texto = [frase, participe, sala ? `Sala: ${sala}` : "", `Agenda: ${urlDaAgenda}`].filter(Boolean).join("\n\n");
  return { assunto, html, texto };
}
