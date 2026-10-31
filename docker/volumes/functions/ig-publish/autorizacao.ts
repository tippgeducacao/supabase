import { AcessoNegado } from "../_shared/acessoRegra.ts";

// A leitura do Planner é ampla; poder enxergar o id não autoriza publicar (pentest, 31/10).
// O claim também usa este cliente de sessão, para a RLS revalidar a permissão na escrita.
export async function autorizarPublicacao(cliente: any, usuarioId: string, postId: string): Promise<void> {
  const { data: perfil, error: erroPerfil } = await cliente.from("profiles")
    .select("ativo").eq("id", usuarioId).maybeSingle();
  if (erroPerfil) throw new AcessoNegado(503, "Não foi possível conferir o perfil.");
  if (perfil?.ativo !== true) throw new AcessoNegado(403, "Perfil inativo.");

  const { data: post, error } = await cliente.from("ig_scheduled_posts")
    .select("id, user_id").eq("id", postId).maybeSingle();
  if (error) throw new AcessoNegado(503, "Não foi possível conferir a publicação.");
  if (!post) throw new AcessoNegado(403, "Publicação indisponível para sua conta.");
  if (post.user_id === usuarioId) return;

  const [marketing, gestao] = await Promise.all([
    cliente.rpc("is_marketing_user"), cliente.rpc("is_admin_ou_diretor_user"),
  ]);
  if ((!marketing.error && marketing.data === true) || (!gestao.error && gestao.data === true)) return;
  if (marketing.error || gestao.error) throw new AcessoNegado(503, "Não foi possível conferir a permissão.");
  throw new AcessoNegado(403, "Você não pode publicar este post.");
}
