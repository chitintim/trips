SET LOCAL lock_timeout = '5s';

-- Phase 4, M2: the server computes the amounts of a person's OWN claims, and we count the direct writes that old clients still make.
--
-- ADDITIVE AND RE-RUNNABLE: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS + CREATE TRIGGER, idempotent REVOKE/GRANT. The ONE existing function replaced is
-- _receipt_resplit_table_items (20261126090000): identical except that it writes an activity entry when someone's share of a TABLE item goes up (see below). Direct claim writes are NOT
-- refused (that is a later, evidence-gated migration); they are only counted.
--
-- set_my_receipt_claims(p_expense_id uuid, p_lines jsonb) -> jsonb       (authenticated)
--   p_lines = [{line_item_id, quantity}]: the caller's OWN quantity on each listed line (hundredths allowed, 0 = take myself off the line). The SERVER computes amount_owed with the
--   client's rule (claimMath.ts claimAmountMinor): the caller's share of the line total at the unit price, rounded half away from zero in minor units; when the claim takes the last of the
--   line it takes exactly what the other rows left, so a fully claimed line adds up to its total to the penny. Shared fixtures: scratchpad/phase4 parity cases (ownClaimParityCases.json).
--   _receipt_begin(p, false) does the auth, the locks (freeze lock then expense lock), frozen / closed / itemised / "tagged or payer or manager" checks. Leftover parts are stripped first and
--   re-shared afterwards (the 'same' mode, 'everyone' when the chosen person is gone), exactly like a link toggle. The caller's other rows and everyone else's own claims are never touched.
--   Refusals (P0001/22023/42501, hint): auth, not_found, forbidden, frozen, claims_closed, not_itemised, currency_unsupported, bad_input, bad_line, table_item (a table item is not claimed by
--   hand), fixed_share (the caller's row on that line is a shared / fractional share: use the share picker), overclaimed (more than is left).
--   Returns the same shape as set_receipt_claims (expense_id, currency, status, lines[], unclaimed_total, unclaimed_lines[], rows_written).
--
-- client_direct_writes: one row per STATEMENT that a signed-in CLIENT (role authenticated) ran directly against expense_item_claims, expense_line_items or expense_splits.
--   build = the X-Client-Info request header (PostgREST: current_setting('request.headers')); the app tags it 'trips-web/<sha>', old builds send 'supabase-js-web/x.y' (read: old). FAIL-OPEN: a
--   missing / unreadable header logs build NULL, never an error, and a logging problem never blocks the write. RLS on, no policies (service role / owner read it). Append-only.
--   Readout: SELECT build, tbl, op, count(*), max(at) FROM client_direct_writes WHERE at > now() - interval '7 days' GROUP BY 1, 2, 3 ORDER BY 4 DESC;
--   Statements that match zero rows are logged too (an old tab that tried is exactly what we want to see). RPC writes run as the owner and are never logged. Drop the table in Phase 5.
--
-- TABLE-ITEM SHARE ACTIVITY (decision 3): when "I wasn't there" (or a list change) re-splits a table item and a person who already had a share now pays MORE of it, an activity_feed row
-- 'receipt_table_share_changed' {line_item_id, line, user_id, from, to, currency} is written (actor = whoever caused it, or NULL for the job). No email is sent for it; the result email at the
-- deadline carries the final amounts.

CREATE TABLE IF NOT EXISTS public.client_direct_writes (
  at timestamptz NOT NULL DEFAULT now(),
  tbl text NOT NULL,
  op text NOT NULL,
  build text NULL,
  user_id uuid NULL
);
CREATE INDEX IF NOT EXISTS client_direct_writes_at_idx ON public.client_direct_writes (at);
ALTER TABLE public.client_direct_writes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_direct_writes FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.client_direct_writes TO service_role;

CREATE OR REPLACE FUNCTION public._log_client_direct_write(p_tbl text, p_op text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_build text;
BEGIN
  -- ONLY the statement triggers may log: a signed-in user calling this function through /rpc (trigger depth 0) gets a silent no-op, so the log cannot be filled by hand.
  -- (The trigger function runs as the CLIENT, so the client role needs EXECUTE for the trigger's PERFORM to work; the depth test is what protects the table.)
  IF pg_trigger_depth() = 0 THEN
    RETURN;
  END IF;
  BEGIN
    v_build := nullif(btrim(coalesce((nullif(current_setting('request.headers', true), '')::json) ->> 'x-client-info', '')), '');
  EXCEPTION WHEN OTHERS THEN
    v_build := NULL;   -- fail open
  END;
  BEGIN
    INSERT INTO public.client_direct_writes (tbl, op, build, user_id) VALUES (p_tbl, p_op, left(v_build, 120), auth.uid());
  EXCEPTION WHEN OTHERS THEN
    NULL;   -- never block the write because the counter failed
  END;
END
$$;

CREATE OR REPLACE FUNCTION public.count_client_direct_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user = 'authenticated' THEN
    PERFORM public._log_client_direct_write(TG_TABLE_NAME, TG_OP);
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS trg_count_direct_claims ON public.expense_item_claims;
CREATE TRIGGER trg_count_direct_claims AFTER INSERT OR UPDATE OR DELETE ON public.expense_item_claims FOR EACH STATEMENT EXECUTE FUNCTION public.count_client_direct_write();
DROP TRIGGER IF EXISTS trg_count_direct_lines ON public.expense_line_items;
CREATE TRIGGER trg_count_direct_lines AFTER INSERT OR UPDATE OR DELETE ON public.expense_line_items FOR EACH STATEMENT EXECUTE FUNCTION public.count_client_direct_write();
DROP TRIGGER IF EXISTS trg_count_direct_splits ON public.expense_splits;
CREATE TRIGGER trg_count_direct_splits AFTER INSERT OR UPDATE OR DELETE ON public.expense_splits FOR EACH STATEMENT EXECUTE FUNCTION public.count_client_direct_write();

-- ---------------------------------------------------------------------------------------------------------------------
-- set_my_receipt_claims
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_my_receipt_claims(p_expense_id uuid, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_exp public.expenses;
  v_pw numeric;
  v_digits integer;
  v_item jsonb;
  v_line uuid;
  v_q numeric;
  v_li public.expense_line_items;
  v_my public.expense_item_claims;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_has_leftover boolean;
  v_others_q numeric;
  v_others_minor bigint;
  v_total_minor bigint;
  v_amt_minor bigint;
  v_rows integer := 0;
  v_status text;
  v_lines jsonb;
  v_unclaimed_lines jsonb;
  v_unclaimed_minor bigint;
BEGIN
  v_exp := public._receipt_begin(p_expense_id, false);
  v_pw := power(10::numeric, public.currency_exponent(v_exp.currency));
  v_digits := public.currency_exponent(v_exp.currency);
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) > 500 THEN
    RAISE EXCEPTION 'Lines must be a list of at most 500 entries' USING ERRCODE = '22023', HINT = 'bad_input';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.expense_item_claims cl WHERE cl.expense_id = p_expense_id AND (cl.leftover_quantity > 0 OR cl.leftover_amount > 0)) INTO v_has_leftover;
  IF v_has_leftover THEN
    PERFORM public._receipt_strip_leftovers(p_expense_id);   -- the amounts below are computed against OWN parts; the leftovers are rebuilt at the end
  END IF;

  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_lines) AS e(value) LOOP
    IF jsonb_typeof(v_item) <> 'object' OR NOT (v_item ? 'line_item_id') OR jsonb_typeof(v_item -> 'quantity') NOT IN ('number', 'string') THEN
      RAISE EXCEPTION 'Each entry needs a line_item_id and a quantity' USING ERRCODE = '22023', HINT = 'bad_input';
    END IF;
    BEGIN
      v_line := (v_item ->> 'line_item_id')::uuid;
      v_q := (v_item ->> 'quantity')::numeric;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'A line id or quantity is not valid' USING ERRCODE = '22023', HINT = 'bad_input';
    END;
    IF v_line IS NULL OR v_line = ANY (v_seen) OR v_q < 0 OR v_q >= 100000 OR round(v_q, 2) <> v_q THEN
      RAISE EXCEPTION 'A line is listed twice, or a quantity is negative or has more than 2 decimals' USING ERRCODE = '22023', HINT = 'bad_input';
    END IF;
    v_seen := v_seen || v_line;
    SELECT li.* INTO v_li FROM public.expense_line_items li WHERE li.id = v_line AND li.expense_id = p_expense_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A line doesn''t belong to this expense' USING ERRCODE = '22023', HINT = 'bad_line';
    END IF;
    IF v_li.shared_by_all THEN
      RAISE EXCEPTION 'This item is shared by everyone; it is not claimed by hand' USING ERRCODE = '42501', HINT = 'table_item';
    END IF;
    SELECT cl.* INTO v_my FROM public.expense_item_claims cl WHERE cl.line_item_id = v_line AND cl.user_id = v_uid;
    IF FOUND THEN
      IF round(v_q * 100) = round(v_my.quantity_claimed * 100) THEN
        CONTINUE;   -- nothing to change on this line
      END IF;
      IF v_my.source = 'shared' OR abs(v_my.quantity_claimed - round(v_my.quantity_claimed)) >= 0.005 THEN
        RAISE EXCEPTION 'Your part of this item is a shared or fractional share; change it with the share picker' USING ERRCODE = '42501', HINT = 'fixed_share';
      END IF;
    ELSIF v_q = 0 THEN
      CONTINUE;
    END IF;
    SELECT coalesce(sum(cl.quantity_claimed), 0), coalesce(sum(round(cl.amount_owed * v_pw)), 0)::bigint INTO v_others_q, v_others_minor
    FROM public.expense_item_claims cl WHERE cl.line_item_id = v_line AND cl.user_id <> v_uid;
    IF v_q > v_li.quantity - v_others_q + 0.011 THEN
      RAISE EXCEPTION 'There is not that much of this item left to claim' USING ERRCODE = 'P0001', HINT = 'overclaimed';
    END IF;
    IF v_q = 0 THEN
      DELETE FROM public.expense_item_claims WHERE line_item_id = v_line AND user_id = v_uid;
      v_rows := v_rows + 1;
      CONTINUE;
    END IF;
    v_total_minor := round(v_li.total_amount * v_pw)::bigint;
    IF v_li.quantity - v_others_q - v_q < 0.001 THEN
      v_amt_minor := greatest(0, v_total_minor - v_others_minor);   -- takes the last of the line: exactly what the others left
    ELSE
      v_amt_minor := round(v_total_minor::numeric / v_li.quantity * v_q)::bigint;
    END IF;
    IF v_my.id IS NOT NULL THEN
      UPDATE public.expense_item_claims SET quantity_claimed = v_q, amount_owed = v_amt_minor::numeric / v_pw WHERE id = v_my.id;
    ELSE
      INSERT INTO public.expense_item_claims (line_item_id, user_id, expense_id, quantity_claimed, amount_owed, source, created_by)
      VALUES (v_line, v_uid, p_expense_id, v_q, v_amt_minor::numeric / v_pw, 'self', v_uid);
    END IF;
    v_rows := v_rows + 1;
  END LOOP;

  -- leftovers were stripped: rebuild them the way they were shared (this also re-splits table items and refreshes the status)
  IF v_has_leftover AND v_exp.leftover_mode IS NOT NULL THEN
    PERFORM public._receipt_after_tagged_change(p_expense_id);
  END IF;
  v_status := public._receipt_refresh_status(p_expense_id);

  INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
  VALUES (v_exp.trip_id, v_uid, 'receipt_claims_set', jsonb_build_object('type', 'expense', 'id', p_expense_id, 'label', v_exp.description),
          jsonb_build_object('self', true, 'rows', v_rows, 'lines', jsonb_array_length(p_lines)));

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'line_item_id', l.line_item_id, 'shared_by_all', li.shared_by_all,
           'total', round(l.total_minor::numeric / v_pw, v_digits), 'quantity', li.quantity,
           'claimed_total', round(l.claimed_minor::numeric / v_pw, v_digits), 'unclaimed', round(l.remaining_minor::numeric / v_pw, v_digits),
           'people', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                         'user_id', cl.user_id, 'quantity', cl.quantity_claimed, 'amount', cl.amount_owed, 'source', cl.source,
                         'leftover_quantity', cl.leftover_quantity, 'leftover_amount', cl.leftover_amount) ORDER BY cl.user_id), '[]'::jsonb)
                      FROM public.expense_item_claims cl WHERE cl.line_item_id = l.line_item_id)
         ) ORDER BY l.line_number, l.line_item_id), '[]'::jsonb)
    INTO v_lines
  FROM public._receipt_lines(p_expense_id, true) l JOIN public.expense_line_items li ON li.id = l.line_item_id
  WHERE l.line_item_id = ANY (v_seen);
  SELECT coalesce(jsonb_agg(jsonb_build_object('line_item_id', l.line_item_id, 'unclaimed', round(l.remaining_minor::numeric / v_pw, v_digits)) ORDER BY l.line_number, l.line_item_id), '[]'::jsonb),
         coalesce(sum(l.remaining_minor), 0)
    INTO v_unclaimed_lines, v_unclaimed_minor
  FROM public._receipt_lines(p_expense_id, true) l WHERE l.remaining_minor > 0;

  RETURN jsonb_build_object('expense_id', p_expense_id, 'currency', v_exp.currency, 'status', v_status, 'lines', v_lines,
                            'unclaimed_total', round(v_unclaimed_minor::numeric / v_pw, v_digits), 'unclaimed_lines', v_unclaimed_lines, 'rows_written', v_rows);
END
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- table-item share activity (replaces the 20261126090000 body; the only difference is the activity entry)
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._receipt_resplit_table_items(p_expense_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exp public.expenses;
  v_tagged uuid[];
  v_k integer;
  v_pw numeric;
  v_li public.expense_line_items;
  v_qs bigint[];
  v_as bigint[];
  v_prev jsonb;
  v_n integer := 0;
  v_old_skip text;
  v_exact boolean;
  v_prevamt jsonb;
  v_old numeric;
  i integer;
BEGIN
  SELECT * INTO v_exp FROM public.expenses WHERE id = p_expense_id;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.expense_line_items l WHERE l.expense_id = p_expense_id AND l.shared_by_all) THEN
    RETURN 0;
  END IF;
  v_tagged := public._receipt_tagged(p_expense_id);
  v_k := coalesce(cardinality(v_tagged), 0);
  IF v_k = 0 THEN
    RETURN 0;
  END IF;
  v_pw := power(10::numeric, public.currency_exponent(v_exp.currency));
  v_old_skip := current_setting('receipt.skip_done_clear', true);
  PERFORM set_config('receipt.skip_done_clear', 'on', true);
  FOR v_li IN SELECT * FROM public.expense_line_items l WHERE l.expense_id = p_expense_id AND l.shared_by_all ORDER BY l.line_number LOOP
    IF v_k > round(v_li.quantity * 100) THEN
      CONTINUE;
    END IF;
    v_qs := public._receipt_even_split(round(v_li.quantity * 100)::bigint, v_k);
    v_as := public._receipt_even_split(round(v_li.total_amount * v_pw)::bigint, v_k);
    SELECT (SELECT count(*) FROM public.expense_item_claims c WHERE c.line_item_id = v_li.id) = v_k
           AND NOT EXISTS (SELECT 1 FROM unnest(v_tagged) WITH ORDINALITY AS u(uid, ord)
                           LEFT JOIN public.expense_item_claims c ON c.line_item_id = v_li.id AND c.user_id = u.uid
                           WHERE c.id IS NULL OR round(c.quantity_claimed * 100) <> v_qs[u.ord] OR round(c.amount_owed * v_pw) <> v_as[u.ord]
                              OR c.leftover_quantity <> 0 OR c.leftover_amount <> 0)
      INTO v_exact;
    IF v_exact THEN
      CONTINUE;
    END IF;
    SELECT coalesce(jsonb_object_agg(c.user_id::text, to_jsonb(coalesce(c.created_by, c.user_id))), '{}'::jsonb) INTO v_prev
    FROM public.expense_item_claims c WHERE c.line_item_id = v_li.id AND c.quantity_claimed - c.leftover_quantity > 0;
    SELECT coalesce(jsonb_object_agg(c.user_id::text, to_jsonb(c.amount_owed - c.leftover_amount)), '{}'::jsonb) INTO v_prevamt FROM public.expense_item_claims c WHERE c.line_item_id = v_li.id;
    DELETE FROM public.expense_item_claims WHERE line_item_id = v_li.id;
    FOR i IN 1..v_k LOOP
      INSERT INTO public.expense_item_claims (line_item_id, user_id, expense_id, quantity_claimed, amount_owed, source, created_by)
      VALUES (v_li.id, v_tagged[i], p_expense_id, v_qs[i]::numeric / 100, v_as[i]::numeric / v_pw, 'shared',
              CASE WHEN v_prev ? v_tagged[i]::text THEN (v_prev ->> v_tagged[i]::text)::uuid ELSE v_exp.paid_by END);
      -- a person who already had a share of this table item and now pays MORE of it (someone was removed / said "I wasn't there"): an activity entry, no email
      v_old := (v_prevamt ->> v_tagged[i]::text)::numeric;
      IF v_old IS NOT NULL AND v_as[i]::numeric / v_pw > v_old THEN
        INSERT INTO public.activity_feed (trip_id, actor, verb, entity, metadata)
        VALUES (v_exp.trip_id, auth.uid(), 'receipt_table_share_changed',
                jsonb_build_object('type', 'expense', 'id', p_expense_id, 'label', v_exp.description),
                jsonb_build_object('line_item_id', v_li.id, 'line', v_li.name_original, 'user_id', v_tagged[i], 'from', v_old, 'to', v_as[i]::numeric / v_pw,
                                   'currency', v_exp.currency));
      END IF;
    END LOOP;
    v_n := v_n + 1;
  END LOOP;
  PERFORM set_config('receipt.skip_done_clear', coalesce(v_old_skip, ''), true);
  RETURN v_n;
END
$$;

REVOKE ALL ON FUNCTION public._receipt_resplit_table_items(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._log_client_direct_write(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._log_client_direct_write(text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.count_client_direct_write() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_my_receipt_claims(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_receipt_claims(uuid, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
