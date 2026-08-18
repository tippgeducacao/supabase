// Régua de classificação de telefone. Os casos "impossível" e "internacional" saíram
// da BASE REAL (consulta em 18/08/2026: 3.242 de 96.930 leads com número fora da
// régua) — não são hipóteses. O que este teste protege: (a) o número truncado da LP
// nunca mais ser aceito no envio, (b) contato estrangeiro legítimo NÃO ser barrado
// junto, (c) fixo e celular antigo sem o 9 seguirem válidos.
import { describe, expect, it } from 'vitest';

const { classificaTelefone, telefoneEnviavel, canonicalBrClassificacao, digitosParaEnvio } =
  await import('./telefone.ts');

describe('classificaTelefone', () => {
  it('aceita celular BR com e sem DDI', () => {
    expect(classificaTelefone('5546999746930')).toBe('br');
    expect(classificaTelefone('+55 (46) 99974-6930')).toBe('br');
    expect(classificaTelefone('46999746930')).toBe('br');
  });

  it('aceita fixo e celular antigo sem o 9º dígito', () => {
    expect(classificaTelefone('554632251234')).toBe('br');   // fixo (46) 3225-1234
    expect(classificaTelefone('4699974693')).toBe('br');      // celular sem o 9 → canoniza
  });

  it('recupera número BR com o "0" de operadora na frente', () => {
    expect(classificaTelefone('+016997722712')).toBe('br');
    expect(canonicalBrClassificacao('+016997722712')).toBe('5516997722712');
  });

  it('condena o número truncado pela LP (o caso que queimava template)', () => {
    expect(classificaTelefone('5553474634534')).toBe('impossivel');
    expect(classificaTelefone('5555119876543')).toBe('impossivel'); // "55"+55+DDD+7 díg.
    expect(classificaTelefone('+55+55 11 95087-6718')).toBe('impossivel');
  });

  it('condena lixo digitado no campo de telefone', () => {
    expect(classificaTelefone('Adão Vital Maciel Junior')).toBe('impossivel');
    expect(classificaTelefone('123456')).toBe('impossivel');
    expect(classificaTelefone('00000000')).toBe('impossivel');
    expect(classificaTelefone('+5562852710926285271092')).toBe('impossivel'); // colado 2x
  });

  it('deixa passar número estrangeiro em vez de julgá-lo pela régua BR', () => {
    expect(classificaTelefone('+1 631 578 2741')).toBe('internacional');
    expect(classificaTelefone('+351 912 345 678')).toBe('internacional');
  });

  it('trata vazio como vazio, não como erro', () => {
    expect(classificaTelefone('')).toBe('vazio');
    expect(classificaTelefone(null)).toBe('vazio');
    expect(classificaTelefone('   ')).toBe('vazio');
  });
});

describe('telefoneEnviavel', () => {
  it('barra só o impossível — BR e internacional seguem', () => {
    expect(telefoneEnviavel('5546999746930')).toBe(true);
    expect(telefoneEnviavel('+1 631 578 2741')).toBe(true);
    expect(telefoneEnviavel('5553474634534')).toBe(false);
    expect(telefoneEnviavel('')).toBe(false);
  });
});

// DDD 55 (Santa Maria/RS) é a armadilha desta régua: 323 leads na base guardam o
// número SEM DDI, e a canonicalização de dedup — que corta "55" da frente sem olhar
// o tamanho — os transformaria em impossíveis. Aqui eles têm que passar.
describe('DDD 55 não pode ser confundido com DDI', () => {
  it('lê o 55 da frente como DDD quando o número é nacional', () => {
    expect(classificaTelefone('55999123456')).toBe('br');   // (55) 99912-3456
    expect(classificaTelefone('5599912345')).toBe('br');    // (55) 9991-2345 antigo
    expect(canonicalBrClassificacao('55999123456')).toBe('5555999123456');
  });

  it('e como DDI quando vem o número inteiro atrás dele', () => {
    expect(canonicalBrClassificacao('5546999746930')).toBe('5546999746930');
  });
});

// "0" de tronco: 176 contatos na base digitaram "(0xx) …". 167 deles são números
// perfeitamente válidos — condená-los seria bloquear cliente real; aceitá-los sem
// corrigir o que SAI seria queimar template num número que a Meta recusa.
describe('zero de tronco', () => {
  it('recupera o número quando o que sobra é nacional inteiro', () => {
    expect(classificaTelefone('5501499668988')).toBe('br');
    expect(canonicalBrClassificacao('5501499668988')).toBe('5514999668988');
    expect(digitosParaEnvio('5501499668988')).toBe('551499668988');
  });

  it('não usa o zero para salvar o que continua impossível', () => {
    // 00 + 999000000: sobra um número de 9 dígitos, que não é nacional inteiro — o
    // zero fica onde está e o DDD "00" reprova.
    expect(classificaTelefone('+5500999000000')).toBe('impossivel');
  });

  it('LIMITE CONHECIDO: a régua responde "pode existir?", não "parece de verdade?"', () => {
    // "00" + 1122334455 vira (11) 2233-4455 — um fixo de SP estruturalmente válido,
    // ainda que a sequência tenha cara de teclado batido. Detectar número FALSO é
    // outra heurística (dígitos repetidos/sequenciais) e não entra aqui: um falso
    // positivo bloquearia envio para cliente real, que é o dano mais caro.
    expect(classificaTelefone('+55001122334455')).toBe('br');
  });

  it('não insere o 9º dígito no que vai pra Meta (isso é papel do phoneVariants)', () => {
    expect(digitosParaEnvio('554699974693')).toBe('554699974693');
    expect(digitosParaEnvio('46999746930')).toBe('5546999746930');
  });
});
