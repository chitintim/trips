SET LOCAL lock_timeout = '5s';

-- Trip chat, A1 (3/3): admin_ai_usage_summary(p_days) for site admins: AI usage per day x function x model (calls, tokens, cache-read share, cost) and the chat_actions funnel per kind.
-- ai_usage itself is unchanged (service-role written, own rows readable). ADDITIVE AND RE-RUNNABLE.

DO $$
DECLARE
  v_missing text;
BEGIN
  IF to_regclass('public.ai_usage') IS NULL THEN
    RAISE EXCEPTION 'admin usage: public.ai_usage does not exist';
  END IF;
  IF to_regclass('public.chat_actions') IS NULL THEN
    RAISE EXCEPTION 'admin usage: public.chat_actions does not exist (apply 20261129090000_chat_actions.sql first)';
  END IF;
  SELECT string_agg(x.c, ', ') INTO v_missing FROM (VALUES ('function_name'), ('model'), ('input_tokens'), ('output_tokens'), ('cache_read_tokens'), ('cache_write_tokens'), ('estimated_cost_usd'), ('created_at')) x(c)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = 'ai_usage' AND k.column_name = x.c);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'admin usage: ai_usage lacks the expected columns: %', v_missing;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'role') THEN
    RAISE EXCEPTION 'admin usage: users.role does not exist';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.admin_ai_usage_summary(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_days integer := least(180, greatest(1, coalesce(p_days, 30)));
  v_from timestamptz;
  v_usage jsonb;
  v_actions jsonb;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_uid AND u.role::text = 'admin') THEN
    RAISE EXCEPTION 'Site admins only' USING ERRCODE = '42501', HINT = 'forbidden';
  END IF;
  v_from := date_trunc('day', now()) - make_interval(days => v_days - 1);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'day', x.day, 'function_name', x.function_name, 'model', x.model, 'calls', x.calls,
           'input_tokens', x.i, 'output_tokens', x.o, 'cache_read_tokens', x.cr, 'cache_write_tokens', x.cw,
           'cache_read_share', CASE WHEN x.i + x.cr + x.cw > 0 THEN round(x.cr::numeric / (x.i + x.cr + x.cw), 4) ELSE 0 END,
           'cost_usd', round(x.cost, 4)) ORDER BY x.day DESC, x.cost DESC), '[]'::jsonb)
    INTO v_usage
  FROM (SELECT (u.created_at AT TIME ZONE 'UTC')::date AS day, u.function_name, u.model, count(*) AS calls,
               coalesce(sum(u.input_tokens), 0) AS i, coalesce(sum(u.output_tokens), 0) AS o,
               coalesce(sum(u.cache_read_tokens), 0) AS cr, coalesce(sum(u.cache_write_tokens), 0) AS cw, coalesce(sum(u.estimated_cost_usd), 0) AS cost
        FROM public.ai_usage u WHERE u.created_at >= v_from GROUP BY 1, 2, 3) x;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'kind', a.kind, 'proposed', a.n, 'started', a.started, 'done', a.done, 'failed', a.failed, 'dismissed', a.dismissed, 'expired', a.expired, 'edited', a.edited) ORDER BY a.n DESC, a.kind), '[]'::jsonb)
    INTO v_actions
  FROM (SELECT c.kind, count(*) AS n, count(*) FILTER (WHERE c.started_at IS NOT NULL) AS started, count(*) FILTER (WHERE c.status = 'done') AS done,
               count(*) FILTER (WHERE c.status = 'failed') AS failed, count(*) FILTER (WHERE c.status = 'dismissed') AS dismissed,
               count(*) FILTER (WHERE c.status = 'expired') AS expired, count(*) FILTER (WHERE c.status = 'edited_elsewhere' OR c.edited) AS edited
        FROM public.chat_actions c WHERE c.created_at >= v_from GROUP BY c.kind) a;
  RETURN jsonb_build_object('days', v_days, 'generated_at', now(), 'usage', v_usage, 'actions', v_actions);
END
$$;

REVOKE ALL ON FUNCTION public.admin_ai_usage_summary(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_ai_usage_summary(integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
