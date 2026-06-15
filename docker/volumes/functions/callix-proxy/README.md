# callix-proxy

Edge function que faz proxy para a API Callix (`https://ppgeducacao.callix.com.br/api/v1`).

## Por que existe

1. **CORS** — A API Callix não emite headers CORS, então chamadas direto do browser falham.
2. **Token** — O token da Callix dá acesso total à API. Não pode ir pro frontend.
3. **Allowlist** — Só endpoints de leitura (GET) permitidos pelo dashboard.

## Setup

### 1. Configurar o secret no Supabase

```bash
supabase secrets set CALLIX_API_TOKEN=seu_token_aqui --project-ref <PROJECT_REF>
```

Opcionalmente, se o subdomínio mudar:

```bash
supabase secrets set CALLIX_BASE_URL=https://outro.callix.com.br/api/v1 --project-ref <PROJECT_REF>
```

### 2. Fazer deploy da função

```bash
supabase functions deploy callix-proxy --project-ref <PROJECT_REF>
```

## Como o frontend chama

```ts
import { supabase } from '@/integrations/supabase/client';

const { data, error } = await supabase.functions.invoke('callix-proxy', {
  body: { path: 'users', query: { 'page[limit]': 5000 } },
});
```

Em produção, usar os hooks já prontos em `src/lib/callix/hooks.ts`.

## Rate limiting

A função **não** faz rate limiting próprio — ela apenas repassa:
- O `status 429` da Callix
- Os headers `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

O frontend (React Query) usa `staleTime: 60s` em endpoints de relatório para
evitar bater no limite. Endpoints como `user_performance_reports` são limitados
a 1 req/min na Callix.

## Endpoints permitidos

Vide `ALLOWED_PATHS` em `index.ts`. Adicionar novos endpoints aqui antes de
chamar do frontend (a função retorna `403` para paths fora da lista).
