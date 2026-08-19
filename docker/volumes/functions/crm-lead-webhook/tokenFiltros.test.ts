import { describe, expect, it } from 'vitest';
import { aplicarFiltrosToken, capitalizarNome, parseTokenWebhook, primeiroNome } from './tokenFiltros';

/** Espelha o `resolveWebhookVar` do index.ts (o resolvedor real, que depende do Deno). */
function resolve(miolo: string, valor: string): string {
  const { filtros } = parseTokenWebhook(miolo);
  return aplicarFiltrosToken(valor, filtros);
}

describe('token do webhook — chave e filtros', () => {
  it('sem filtro, a chave é o miolo inteiro (comportamento antigo)', () => {
    expect(parseTokenWebhook('dados_completos.full_name')).toEqual({
      chave: 'dados_completos.full_name',
      filtros: [],
    });
  });

  it('separa a chave dos filtros conhecidos', () => {
    expect(parseTokenWebhook('dados_completos.full_name|primeiro_nome|capitalizar')).toEqual({
      chave: 'dados_completos.full_name',
      filtros: [
        { nome: 'primeiro_nome', arg: '' },
        { nome: 'capitalizar', arg: '' },
      ],
    });
  });

  it('chave com "|" LITERAL não vira filtro (zero regressão nos webhooks já salvos)', () => {
    const t = parseTokenWebhook('MBA | Gestão da Pecuária Leiteira');
    expect(t.chave).toBe('MBA | Gestão da Pecuária Leiteira');
    expect(t.filtros).toEqual([]);
  });

  it('um filtro desconhecido no meio invalida TODOS (não recorta a chave por engano)', () => {
    expect(parseTokenWebhook('curso|primeiro_nome|inventado').chave).toBe('curso|primeiro_nome|inventado');
  });
});

describe('primeiro_nome', () => {
  it('manda só a 1ª palavra do nome do formulário do Meta', () => {
    expect(resolve('x|primeiro_nome', 'MARIA APARECIDA DA SILVA')).toBe('MARIA');
    expect(resolve('x|primeiro_nome', 'joão pedro souza')).toBe('joão');
  });

  it('aguenta espaço sobrando, quebra de linha e emoji na frente', () => {
    expect(resolve('x|primeiro_nome', '  \n Ana  Clara ')).toBe('Ana');
    expect(resolve('x|primeiro_nome', '💠 Rafael Lima')).toBe('Rafael');
  });

  it('tira pontuação colada e preserva hífen/apóstrofo do nome', () => {
    expect(primeiroNome('Maria, Fernanda')).toBe('Maria');
    expect(primeiroNome("D'Ávila Souza")).toBe("D'Ávila");
    expect(primeiroNome('Ana-Clara Ribeiro')).toBe('Ana-Clara');
  });

  it('nome vazio ou só símbolos devolve vazio (a rede é o filtro padrao=)', () => {
    expect(primeiroNome('')).toBe('');
    expect(primeiroNome('   ')).toBe('');
    expect(primeiroNome('...')).toBe('');
  });
});

describe('capitalizar', () => {
  it('conserta o CAIXA ALTA que o Meta manda, com partícula em minúscula', () => {
    expect(capitalizarNome('MARIA APARECIDA DA SILVA')).toBe('Maria Aparecida da Silva');
    expect(capitalizarNome('joão dos santos')).toBe('João dos Santos');
  });

  it('capitaliza depois de hífen e apóstrofo', () => {
    expect(capitalizarNome('ana-clara')).toBe('Ana-Clara');
    expect(capitalizarNome("d'ávila")).toBe("D'Ávila");
  });

  it('combinado com primeiro_nome é o caso do template de boas-vindas', () => {
    expect(resolve('x|primeiro_nome|capitalizar', 'MARIA APARECIDA DA SILVA')).toBe('Maria');
  });
});

describe('padrao= (variável vazia derruba o envio inteiro na Meta)', () => {
  it('preenche quando o payload não trouxe o nome', () => {
    expect(resolve('x|primeiro_nome|padrao=tudo bem', '')).toBe('tudo bem');
  });

  it('não atropela o valor quando ele existe', () => {
    expect(resolve('x|primeiro_nome|padrao=tudo bem', 'Carlos Eduardo')).toBe('Carlos');
  });
});

describe('caixa', () => {
  it('maiusculo e minusculo', () => {
    expect(resolve('x|maiusculo', 'Pós Cannabis')).toBe('PÓS CANNABIS');
    expect(resolve('x|minusculo', 'Pós Cannabis')).toBe('pós cannabis');
  });
});
