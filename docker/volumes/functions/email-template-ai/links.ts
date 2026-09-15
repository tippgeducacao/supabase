import { analisarDestinoLinkEmailIA, validarUrlsVerificacaoEmailIA, type ResultadoLinkEmailIA, type RespostaVerificacaoLinksEmailIA } from "../_shared/emailBuilder/aiLinks.ts";
import { ipPublicoMaterialEmailIA, validarUrlMaterialEmailIA } from "../email-importar-material/url.ts";

export interface RedeLinksEmailIA {
  resolver(hostname: string): Promise<string[]>;
  // O transporte deve usar SOMENTE HEAD e conectar ao IP recebido sem novo DNS.
  consultar(url: URL, ip: string, signal: AbortSignal): Promise<{ status: number; headers: Headers }>;
}
export class ErroLinksEmailIA extends Error {
  constructor(public status: number, mensagem: string) { super(mensagem); }
}

/** Reutiliza também a validação do importador HTTPS. Para HTTP, só a validação
 * do nome usa https; a consulta mantém o protocolo original e porta padrão. */
function validarUrlConsulta(valor: string): URL {
  const url = new URL(valor);
  const paraValidar = new URL(url.href);
  paraValidar.protocol = "https:";
  validarUrlMaterialEmailIA(paraValidar.href);
  return url;
}

export async function verificarDestinoEmailIA(original: string, rede: RedeLinksEmailIA, timeoutMs = 6000): Promise<ResultadoLinkEmailIA> {
  const analise = analisarDestinoLinkEmailIA(original);
  if (!analise.verificavel || !analise.urlConsulta) return { url: original, estado: "nao_verificado", mensagem: analise.motivo };
  const base = { url: original, urlConsultada: analise.urlConsulta };
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), timeoutMs);
  const interrompida = new Promise<ResultadoLinkEmailIA>(resolve => controle.signal.addEventListener("abort", () => resolve({ ...base, estado: "nao_verificado", mensagem: "O site demorou para responder. Confira novamente ou revise o endereço no cadastro." }), { once: true }));
  try {
    return await Promise.race([interrompida, (async (): Promise<ResultadoLinkEmailIA> => {
      let url = validarUrlConsulta(analise.urlConsulta!);
      const visitadas = new Set<string>();
      for (let passo = 0; passo < 4; passo++) {
        if (controle.signal.aborted) throw new Error();
        if (visitadas.has(url.href)) return { ...base, estado: "falha", mensagem: "O site entrou em um ciclo de redirecionamentos." };
        visitadas.add(url.href);
        const ips = await rede.resolver(url.hostname);
        if (!ips.length || ips.some(ip => !ipPublicoMaterialEmailIA(ip))) return { ...base, estado: "nao_verificado", mensagem: "O destino não aponta exclusivamente para endereços públicos permitidos." };
        if (controle.signal.aborted) throw new Error();
        const resposta = await rede.consultar(url, ips[0], controle.signal);
        if (controle.signal.aborted) throw new Error();
        if ([301, 302, 303, 307, 308].includes(resposta.status)) {
          const local = resposta.headers.get("location");
          if (!local) return { ...base, estado: "falha", mensagem: "O site retornou um redirecionamento sem destino.", statusHttp: resposta.status };
          const seguinte = new URL(local, url);
          const novaAnalise = analisarDestinoLinkEmailIA(seguinte.href);
          if (!novaAnalise.verificavel || !novaAnalise.urlConsulta) return { ...base, estado: "nao_verificado", mensagem: "O site redireciona para ação, rastreamento ou endereço não permitido. Esse destino não foi acessado.", statusHttp: resposta.status };
          if (url.protocol === "https:" && seguinte.protocol === "http:") return { ...base, estado: "nao_verificado", mensagem: "O site redireciona para uma página sem HTTPS. Confira o destino no cadastro.", statusHttp: resposta.status };
          url = validarUrlConsulta(novaAnalise.urlConsulta);
          continue;
        }
        if (resposta.status >= 200 && resposta.status <= 299) return { ...base, estado: passo ? "redirecionado" : "acessivel", mensagem: passo ? "O endereço redirecionou e a página final respondeu à consulta." : "A página respondeu à consulta.", urlFinal: url.href, statusHttp: resposta.status };
        if ([404, 410].includes(resposta.status)) return { ...base, estado: "falha", mensagem: "A página não foi encontrada. Confira o endereço no cadastro.", urlFinal: url.href, statusHttp: resposta.status };
        if (resposta.status >= 500 && resposta.status !== 501) return { ...base, estado: "falha", mensagem: "O servidor da página apresentou um erro. Confira novamente mais tarde.", urlFinal: url.href, statusHttp: resposta.status };
        return { ...base, estado: "nao_verificado", mensagem: [405, 501].includes(resposta.status) ? "O site não aceita a consulta HEAD. Confira a página manualmente." : "O site restringiu ou não confirmou a consulta. Isso não comprova que o link está quebrado.", urlFinal: url.href, statusHttp: resposta.status };
      }
      return { ...base, estado: "nao_verificado", mensagem: "O site redirecionou mais de três vezes. Confira o endereço final no cadastro." };
    })()]);
  } catch {
    // Não expõe detalhes de DNS/TLS, IPs nem endereços internos em erros.
    return { ...base, estado: "nao_verificado", mensagem: "Não foi possível confirmar o endereço público ou a resposta do site. Confira novamente." };
  } finally { clearTimeout(timer); controle.abort(); }
}

/** Chamado somente DEPOIS da autenticação e do gate admin/diretor do handler.
 * Revalida a conta esperada aqui antes de qualquer DNS; não chama provedor de IA. */
export async function tratarVerificacaoLinksEmailIA(corpo: Record<string, unknown>, deps: { usuarioId: string; rede?: RedeLinksEmailIA }): Promise<RespostaVerificacaoLinksEmailIA> {
  if (corpo.usuario_esperado !== deps.usuarioId) throw new ErroLinksEmailIA(409, "A conta mudou. Reabra o e-mail para continuar.");
  let urls: string[];
  try { urls = validarUrlsVerificacaoEmailIA(corpo.urls); } catch (e) { throw new ErroLinksEmailIA(400, (e as Error).message); }
  if (!deps.rede) throw new ErroLinksEmailIA(503, "A conferência de links aguarda a atualização do serviço.");
  const resultados: ResultadoLinkEmailIA[] = [];
  // No máximo três conexões por vez e quatro grupos: limita custo e duração.
  for (let inicio = 0; inicio < urls.length; inicio += 3) resultados.push(...await Promise.all(urls.slice(inicio, inicio + 3).map(url => verificarDestinoEmailIA(url, deps.rede!))));
  return { versao: 1, verificadoEm: new Date().toISOString(), resultados };
}
