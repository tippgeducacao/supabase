import { describe, expect, it } from 'vitest';
import { declaracaoDeConclusao } from './fichaAtendimento';
import { declaracaoProfissionalDeConclusao } from './formacaoProfissional';

describe('formação reconhecida nas demais áreas', () => {
  it.each([
    'Sou agrônomo', 'sou engenheira agrônoma', 'Sou engenheiro de alimentos',
    'Sou bióloga', 'Sou advogado', 'Sou dentista', 'Sou nutricionista',
    'Sou farmacêutica', 'Sou biomédico', 'Sou médica', 'Sou enfermeira',
    'Sou fisioterapeuta', 'Sou psicóloga', 'Sou contador', 'Sou pedagoga',
    'Trabalho como nutricionista numa clínica', 'Atuo como advogada',
    'Sou médica veterinária e auxiliar de zootecnista', 'Zootecnista',
    'Minha formação é med vet e já atuo em clínica',
  ])('aproveita a apresentação profissional: %s', fala => {
    expect(declaracaoDeConclusao([fala])).not.toBeNull();
  });

  it.each([
    'Não sou agrônomo', 'Quero ser nutricionista', 'Meu marido é advogado',
    'Sou auxiliar de dentista', 'Sou técnico de enfermagem', 'Sou gerente de clínica',
    'Trabalho na fazenda', 'Minha graduação é Agronomia',
    'Sou estudante de Nutrição', 'Sou estagiária de Direito',
    'Sou nutricionista mas ainda não me formei',
    'Sou veterinária, ainda curso a graduação',
    'Sou veterinária, curso Medicina Veterinária',
    'Minha graduação é Medicina Veterinária, atuo em clínica e estou no 8º período',
    'Minha irmã disse: "sou nutricionista". Eu só trabalho na recepção',
    'Quero dizer que sou médica, mas ainda não me formei',
  ])('não transforma cargo, terceiro, intenção ou estudante em formação: %s', fala => {
    expect(declaracaoProfissionalDeConclusao([fala])).toBeNull();
  });
});
