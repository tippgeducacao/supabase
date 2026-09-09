import { canonicalBrClassificacao, digitsTelefone } from '../_shared/telefone.ts';

type Objeto = Record<string, unknown>;
export type MotivoExclusaoModulosPraticos =
  | 'inscricao_bloqueada'
  | 'nome_bloqueado'
  | 'email_bloqueado'
  | 'telefone_bloqueado'
  | 'cadastro_de_teste';

function objeto(valor: unknown): valor is Objeto {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor);
}

function texto(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() ? valor.trim() : null;
}

function semAcentos(valor: string): string {
  // Mesmo recorte de marcas usado pela função SQL de exclusões.
  return valor.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function chaveNome(valor: string): string | null {
  return semAcentos(valor).replace(/[^\p{L}\p{N}]/gu, '') || null;
}

function chaveTelefone(valor: string): string | null {
  const digitos = digitsTelefone(valor);
  if (!digitos) return null;
  // DDI estrangeiro explícito prevalece sobre o comprimento nacional brasileiro.
  if (/^\+\s*[1-9]/.test(valor) && !digitos.startsWith('55')) return `intl:${digitos}`;
  const nacional = digitos.length === 10 || (digitos.length === 11 && digitos[2] === '9');
  const brasileiro = nacional || (digitos.startsWith('55') && [12, 13].includes(digitos.length));
  if (!brasileiro) return `intl:${digitos}`;
  const canonico = canonicalBrClassificacao(digitos);
  // fn_canon_ddd8 não reconhece DDD com zero; nesse caso a exclusão só pode
  // comparar os dígitos exatos, sem aproximar formatos brasileiros inválidos.
  if (!/^[1-9]{2}$/.test(canonico.slice(2, 4))) return `intl:${digitos}`;
  // Igualdade por DDD + últimos oito, espelhando fn_canon_ddd8 no banco. Assim
  // telefone com/sem o nono dígito casa, preservando o DDD55 de Santa Maria.
  return `br:${canonico.slice(2, 4)}${canonico.slice(-8)}`;
}

function presenteNaLista(valor: string | null, regras: unknown, normalizar: (valor: string) => string | null): boolean {
  if (!valor || !Array.isArray(regras)) return false;
  const chave = normalizar(valor);
  if (!chave) return false;
  return regras.some(regra => {
    const configurado = texto(regra);
    return configurado !== null && normalizar(configurado) === chave;
  });
}

function contemTokenDeTeste(valor: string | null): boolean {
  if (!valor) return false;
  return semAcentos(valor).split(/[^\p{L}\p{N}]+/u)
    .some(token => /^(?:test|teste|testes)[0-9]*$/.test(token));
}

/**
 * Filtro administrativo somente do retroativo, anterior à validação do contato. Não depende de telefone
 * válido para descartar uma inscrição de teste e não gera dados/efeitos colaterais.
 * As regras vêm da integração autenticada, nunca do corpo enviado pelo remetente.
 */
export function obterMotivoExclusaoModulosPraticos(payload: unknown, regras: unknown): MotivoExclusaoModulosPraticos | null {
  if (!objeto(payload) || !objeto(regras)
    || texto(payload.evento) !== 'inscricao.retroativa') return null;

  if (presenteNaLista(texto(payload.inscricao_id), regras.inscricoes_ids, valor => valor)) return 'inscricao_bloqueada';
  const contato = objeto(payload.contato) ? payload.contato : {};
  const nome = texto(contato.nome);
  const email = texto(contato.email);
  if (presenteNaLista(nome, regras.nomes, chaveNome)) return 'nome_bloqueado';
  if (presenteNaLista(email, regras.emails, valor => valor.toLowerCase())) return 'email_bloqueado';
  if (presenteNaLista(texto(contato.telefone), regras.telefones, chaveTelefone)) return 'telefone_bloqueado';

  // Não examina o domínio: pessoa@teste.example pode ser um contato legítimo.
  const localEmail = email?.split('@')[0] ?? null;
  if (regras.ignorar_testes === true && (contemTokenDeTeste(nome) || contemTokenDeTeste(localEmail))) return 'cadastro_de_teste';
  return null;
}
