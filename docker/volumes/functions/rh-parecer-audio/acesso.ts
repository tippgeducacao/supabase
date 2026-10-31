import { AcessoNegado } from "../_shared/acessoRegra.ts";

// O front sobe o áudio em <oportunidade>/parecer-<timestamp>.webm. O arquivo novo
// ainda não está em parecer_audio_path, então conferir só a referência gravada
// impediria a primeira transcrição. Vinculamos o caminho à entrevista visível.
export function caminhoParecerValido(audioPath: unknown, oportunidadeId: unknown): audioPath is string {
  if (typeof audioPath !== "string" || typeof oportunidadeId !== "string") return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(oportunidadeId)) return false;
  const partes = audioPath.split("/");
  return partes.length === 2 && partes[0] === oportunidadeId
    && /^parecer-[0-9]+\.webm$/.test(partes[1]);
}

export async function conferirEntrevista(cliente: any, oportunidadeId: string): Promise<void> {
  const { data, error } = await cliente.from("rh_entrevistas").select("id")
    .eq("oportunidade_id", oportunidadeId).neq("status", "cancelada")
    .order("inicio", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new AcessoNegado(503, "Não foi possível conferir a entrevista.");
  if (!data) throw new AcessoNegado(403, "Entrevista indisponível para sua conta.");
}
