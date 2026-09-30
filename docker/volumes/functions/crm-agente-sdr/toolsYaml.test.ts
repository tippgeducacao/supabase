import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { documentoYaml, edicoesDoYaml } from '../../../scripts/sdr/toolsYaml';
import { AGENTES_TOOLS, type DadosToolsLuna } from '../../../scripts/sdr/toolsLuna';
import { FERRAMENTAS, FERRAMENTAS_POR_AGENTE } from './tools-luna';

const dados = () => structuredClone({ ferramentas: FERRAMENTAS, porAgente: FERRAMENTAS_POR_AGENTE }) as DadosToolsLuna;

describe('ferramentas da Luna em YAML', () => {
  it('ida e volta sem perda, em todos os agentes, com linhas curtas', () => {
    for (const agente of AGENTES_TOOLS) {
      const texto = documentoYaml(dados(), agente, 'v');
      expect(edicoesDoYaml(texto, dados(), agente)).toEqual([]);
      expect(Math.max(...texto.split('\n').map((l) => l.length))).toBeLessThan(140);
    }
  });

  it('edição de texto vira edição; mudar o contrato é recusado', () => {
    const doc: any = yaml.load(documentoYaml(dados(), 'agente_aula', 'v'));
    doc.ferramentas[0].description = 'Busca os horários livres do monitor.';
    doc.ferramentas[0].parameters.properties.data_desejada.description = 'Data AAAA-MM-DD.';
    const edicoes = edicoesDoYaml(yaml.dump(doc), dados(), 'agente_aula');
    expect(edicoes.map((e) => [e.apelido, e.campo, e.depois])).toEqual([
      ['consulta_disponibilidade__aula', 'description', 'Busca os horários livres do monitor.'],
      ['consulta_disponibilidade__aula', 'param:data_desejada', 'Data AAAA-MM-DD.'],
    ]);
    doc.ferramentas[0].parameters.required = [];
    expect(() => edicoesDoYaml(yaml.dump(doc), dados(), 'agente_aula')).toThrow(/Só os textos/);
    const semUma: any = yaml.load(documentoYaml(dados(), 'agente_aula', 'v'));
    semUma.ferramentas.pop();
    expect(() => edicoesDoYaml(yaml.dump(semUma), dados(), 'agente_aula')).toThrow(/lista de ferramentas mudou/);
  });
});
