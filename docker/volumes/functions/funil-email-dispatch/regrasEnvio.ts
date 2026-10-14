// O que um pedido ao funil do TCC pode pedir (14/10/2026) — conferido antes de qualquer
// leitura no banco, para TODO chamador (o gatilho nunca manda nenhum destes campos).
//
// Achados da revisão adversarial do mesmo dia (anteriores à porta de acesso, não regressão):
//  · `template_id_override` aceitava QUALQUER modelo. Como o remetente sai do modelo, um
//    colaborador ativo mandava HTML livre por remetentes que não são do TCC (domínio de
//    marketing no Resend, caixas com nome de vendedor), por fora da régua do email-send
//    (o dispatch chama o email-send como interno). Em 120 dias, o único modelo trocado de
//    verdade foi o manual da Aprovação, e todo envio saiu por tcc@ppgeducacao.com;
//  · `destinatarios_override` não tinha teto. O maior envio manual em 180 dias teve 3;
//  · "Reenviar" num e-mail de Documentos pendentes mandava o modelo sem a lista: o aluno
//    recebia "{{docs_faltantes}}" literal, sem os documentos e sem os anexos.
import { itensDocsFaltantes } from './docsFaltantes.ts'

/**
 * Modelo do envio MANUAL por etapa, quando difere do automático. Espelho de
 * `ETAPAS_COM_ANEXO[...].templateId` em src/components/gestor-tarefas/tcc/GTTccEtapaEnvioModal.tsx —
 * modelo novo ali precisa entrar aqui também, senão o envio volta 403.
 */
export const MODELOS_MANUAIS: Readonly<Record<string, string>> = {
  // "TCC - Aprovação (ata e declaração)"; o automático da etapa é "TCC - Ata de Aprovação".
  APROVACAO: '4b600a23-11e0-49f5-8316-506afe5846df',
}

export const MAX_DESTINATARIOS = 10

export interface PedidoEnvio {
  etapa_key: string
  template_id_override?: string
  destinatarios_override?: unknown[]
  corpo_html_override?: string
  docs_faltantes?: string
}

/**
 * `null` = pode seguir. Senão, o status e a mensagem da recusa. A dos documentos volta
 * 200 com `ok:false` de propósito: o front só mostra a mensagem do servidor quando a
 * resposta é 2xx (o resto vira "Edge Function returned a non-2xx status code").
 */
export function recusarPedido(p: PedidoEnvio): { status: number; error: string } | null {
  if (p.template_id_override && p.template_id_override !== MODELOS_MANUAIS[p.etapa_key]) {
    return { status: 403, error: 'Este modelo não é o do envio manual desta etapa.' }
  }
  if ((p.destinatarios_override?.length ?? 0) > MAX_DESTINATARIOS) {
    return { status: 400, error: `No máximo ${MAX_DESTINATARIOS} destinatários por envio.` }
  }
  if (p.etapa_key === 'DOCUMENTOS_PENDENTES' && !p.corpo_html_override
    && itensDocsFaltantes(p.docs_faltantes).length === 0) {
    return { status: 200, error: 'Marque os documentos pendentes em "Cobrar documentos": o e-mail precisa da lista.' }
  }
  return null
}
