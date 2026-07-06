/**
 * Shared CORS headers for all edge functions (plan §13 `_shared/` toolkit).
 * Kept permissive (matches the pre-v2 functions) since the frontend is a
 * static GitHub Pages site with no fixed origin allowlist story yet.
 */
export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/** Standard OPTIONS preflight response. Call this first in every handler. */
export function handleCorsPreflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  return null
}
