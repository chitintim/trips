// Shared bootstrap of the receipt / settlement area for BOTH the in-memory (pglite) suites and the real-Postgres CI jobs.
// `db` is anything with exec(sql) and query(sql, params) -> {rows} (PGlite, or lib/pgAdapter.mjs over a node-postgres client).
//
// WHAT IS STUBBED (honestly): the Supabase roles (anon, authenticated, service_role BYPASSRLS), schema `auth` with uid()/role() reading request.jwt.claims,
// the base tables (users, trips, trip_participants, expenses, expense_line_items, expense_item_claims, expense_splits, expense_allocation_links, settlements, activity_feed,
// notifications, rate_limits) shaped like the LIVE schema (live-checks-*.md), the live status trigger as a re-implementation (the live body is unknown; only its md5 and behaviour are recorded),
// guard_immutable_keys / handle_updated_at re-implementations, is_trip_participant / is_trip_organizer, and RLS with the policies RECORDED in the live checks.
// REAL (applied from the repo): currency_exponent, _settlement_can_manage, 20261118100000 (freeze), 20260914154536 (settlement lifecycle, minus its policies), 20261120090000 (tokens),
// 20261120100000 (insert guard), 20261121090000 (dispute), and then whatever the suite applies (receipt migrations).
// NOT modelled: policies on trips / trip_participants / users, the other triggers on trips and trip_participants, realtime, PostgREST (headers are set with set_config).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const M = path.join(ROOT, 'supabase/migrations') + '/'
export const U = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
export const T = '10000000-0000-0000-0000-000000000001'
export const T2 = '10000000-0000-0000-0000-000000000002'
export const read = f => fs.readFileSync(M + f, 'utf8')

export const oldFreezeSrc = () => read('20261118100000_settlement_freeze.sql')
export async function bootstrapBase(db) {
  await db.exec(`
  DO $roles$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $roles$;  -- roles are cluster-global: a real Postgres may already have them from another database
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
  CREATE TYPE participant_role AS ENUM ('organizer','participant');
  CREATE TYPE expense_status AS ENUM ('unallocated','pending_allocation','allocated','confirmed');
  CREATE TABLE users (id uuid primary key, role text default 'member', full_name text, first_name text);
  CREATE TABLE trips (id uuid primary key default gen_random_uuid(), name text default 'trip', created_by uuid, base_currency text default 'GBP', start_date date, end_date date, created_at timestamptz default now(), confirmation_enabled boolean default false, settlement_snapshot jsonb, settlement_snapshot_at timestamptz, settlement_snapshot_by uuid);
  CREATE TABLE trip_participants (trip_id uuid, user_id uuid, role participant_role default 'participant', active bool default true, confirmation_status text, primary key(trip_id,user_id));
  CREATE TABLE rate_limits (id uuid primary key default gen_random_uuid(), user_id uuid not null, feature text not null, tokens numeric(10,4) not null, last_refill timestamptz not null default now(), unique(user_id, feature));
  CREATE TABLE settlements (id uuid primary key default gen_random_uuid(), trip_id uuid not null, from_user_id uuid not null, to_user_id uuid not null, amount numeric not null, payment_method text, notes text, settled_at timestamptz not null, created_at timestamptz default now(), created_by uuid not null, status text not null default 'confirmed' check (status in ('suggested','marked_paid','confirmed')), currency text);
  CREATE TABLE activity_feed (id uuid primary key default gen_random_uuid(), trip_id uuid, actor uuid, verb text not null, entity jsonb, metadata jsonb, created_at timestamptz default now());
  CREATE TABLE expenses (id uuid primary key default gen_random_uuid(), trip_id uuid not null references trips(id), paid_by uuid not null references users(id), amount numeric(10,2) not null, currency text not null default 'EUR', description text not null, status expense_status default 'confirmed', ai_parsed bool default false, participant_ids uuid[], fx_rate numeric(10,6), base_currency_amount numeric(10,2), updated_at timestamptz default now());
  CREATE TABLE expense_line_items (id uuid primary key default gen_random_uuid(), expense_id uuid not null references expenses(id) on delete cascade, name_original text not null, quantity numeric(10,2) not null check (quantity > 0), unit_price numeric(10,2) not null check (unit_price >= 0), line_discount_amount numeric(10,2) default 0, subtotal numeric(10,2) not null check (subtotal >= 0), tax_amount numeric(10,2) default 0, service_amount numeric(10,2) default 0, total_amount numeric(10,2) not null check (total_amount >= 0), line_number int not null check (line_number > 0), created_at timestamptz default now(), unique (expense_id, line_number));
  CREATE TABLE expense_item_claims (id uuid primary key default gen_random_uuid(), line_item_id uuid not null references expense_line_items(id) on delete cascade, user_id uuid not null references users(id) on delete cascade, expense_id uuid not null references expenses(id) on delete cascade, quantity_claimed numeric(10,2) not null, amount_owed numeric(10,2) not null, confirmed bool default false, claimed_at timestamptz default now(), updated_at timestamptz default now(), constraint unique_user_claim_per_item unique (line_item_id, user_id), check (amount_owed >= 0), check (quantity_claimed > 0));
  CREATE INDEX ON expense_item_claims(line_item_id); CREATE INDEX ON expense_item_claims(user_id); CREATE INDEX ON expense_item_claims(expense_id);
  -- stand-ins for the LIVE triggers (bodies of the real ones are unknown; behaviour per live-checks-receipts.md)
  CREATE FUNCTION handle_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
  CREATE FUNCTION guard_immutable_keys() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.trip_id IS DISTINCT FROM OLD.trip_id THEN RAISE EXCEPTION 'trip_id is immutable'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER trigger_guard_immutable_keys BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION guard_immutable_keys();
  CREATE FUNCTION check_all_items_claimed(p_expense_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT NOT EXISTS (SELECT 1 FROM expense_line_items li WHERE li.expense_id = p_expense_id
      AND coalesce((SELECT sum(c.quantity_claimed) FROM expense_item_claims c WHERE c.line_item_id = li.id), 0) < li.quantity) $$;
  CREATE FUNCTION auto_update_expense_status() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  BEGIN
    IF check_all_items_claimed(NEW.expense_id) THEN UPDATE expenses SET status = 'allocated' WHERE id = NEW.expense_id;
    ELSIF EXISTS (SELECT 1 FROM expense_item_claims c WHERE c.expense_id = NEW.expense_id) THEN UPDATE expenses SET status = 'pending_allocation' WHERE id = NEW.expense_id;
    ELSE UPDATE expenses SET status = 'unallocated' WHERE id = NEW.expense_id; END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER trigger_auto_update_expense_status AFTER INSERT OR UPDATE ON expense_item_claims FOR EACH ROW EXECUTE FUNCTION auto_update_expense_status();
  `)
  
  // real helpers copied out of the real migrations
  const mig16 = fs.readFileSync(M + '20261116130000_guard_participant_removal.sql', 'utf8')
  await db.exec(mig16.slice(mig16.indexOf('CREATE OR REPLACE FUNCTION public.currency_exponent'), mig16.indexOf('$$;', mig16.indexOf('CREATE OR REPLACE FUNCTION public.currency_exponent')) + 3))
  const mig20 = fs.readFileSync(M + '20261120100000_settlement_insert_guard.sql', 'utf8')
  const cm = mig20.indexOf('CREATE OR REPLACE FUNCTION public._settlement_can_manage')
  await db.exec(mig20.slice(cm, mig20.indexOf('$$;', mig20.indexOf('AS $$', cm) + 5) + 3))
  const oldFreeze = fs.readFileSync(M + '20261118100000_settlement_freeze.sql', 'utf8')
  await db.exec(`CREATE FUNCTION is_trip_organizer(t uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ select exists(select 1 from trip_participants where trip_id=t and user_id=u and role='organizer') $$;`)
  await db.exec(oldFreeze)
  // the repo's own settlement migrations (guards, tokens, dispute) instead of re-implementations; the stub's own status CHECK / policies are stripped as the md5 harness did
  {
    const strip = t => t.replace(/DROP POLICY[^;]*;|CREATE POLICY[\s\S]*?;\n/g, '').replace(/ALTER TABLE public.settlements\s+ADD CONSTRAINT[^;]*;/, '')
    await db.exec(strip(fs.readFileSync(M + '20260914154536_settlements_two_party_lifecycle.sql', 'utf8')))
    for (const f of ['20261120090000_payment_confirm_tokens.sql', '20261120100000_settlement_insert_guard.sql', '20261121090000_payment_receipt_dispute.sql']) await db.exec(fs.readFileSync(M + f, 'utf8'))
  }
  
  // people
  const users = [[1, 'member', 'Org'], [2, 'member', 'Alice'], [3, 'member', 'Bob'], [4, 'member', 'Carol'], [9, 'member', 'Outsider'], [10, 'admin', 'Admin'], [11, 'member', 'Creator']]
  for (let i = 21; i <= 28; i++) users.push([i, 'member', 'P' + i])
  for (const [id, role, n] of users) await db.query(`insert into users(id,role,full_name) values ($1,$2,$3)`, [U(id), role, n])
  await db.exec(`insert into trips(id,created_by) values ('${T}','${U(11)}'),('${T2}','${U(11)}')`)
  const part = [[1, 'organizer'], [2, 'participant'], [3, 'participant'], [4, 'participant'], ...[21, 22, 23, 24, 25, 26, 27, 28].map(n => [n, 'participant'])]
  for (const [id, role] of part) await db.query(`insert into trip_participants(trip_id,user_id,role,active) values ($1,$2,$3,true)`, [T, U(id), role])
  
  // ---- extra stubs (live shapes: live-checks-receipts.md / live-checks-paid-email.md) ---------------------------------------------------
  await db.exec(`
  ALTER TABLE expense_line_items ADD COLUMN name_english text;
  ALTER TABLE expense_line_items ADD CONSTRAINT live_name_original_len CHECK (char_length(name_original) <= 200), ADD CONSTRAINT live_name_english_len CHECK (char_length(name_english) <= 200);  -- LIVE (22p)
  ALTER TABLE expense_line_items ADD COLUMN line_discount_percent numeric(5,2) default 0 check (line_discount_percent >= 0 and line_discount_percent <= 100), ADD COLUMN notes text;
  CREATE TABLE expense_allocation_links (id uuid primary key default gen_random_uuid(), expense_id uuid not null references expenses(id) on delete cascade, trip_id uuid not null, code text not null unique, created_at timestamptz, expires_at timestamptz, created_by uuid not null);  -- NOT NULL columns as LIVE (22s)
  CREATE FUNCTION is_trip_participant(t uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ select exists(select 1 from trip_participants where trip_id=t and user_id=u) $$;
  CREATE TYPE expense_category AS ENUM ('accommodation','transport','food','activities','equipment','other');  -- the LIVE labels (22s)
  ALTER TABLE expenses ADD COLUMN vendor_name text, ADD COLUMN category expense_category not null default 'other', ADD COLUMN payment_date date not null default current_date, ADD COLUMN receipt_url text, ADD COLUMN fx_rate_date date, ADD COLUMN rate_source text;
ALTER TABLE expenses ADD COLUMN location text, ADD COLUMN place_id uuid, ADD COLUMN option_id uuid, ADD COLUMN booking_id uuid, ADD COLUMN receipt_date date, ADD COLUMN ai_parsed_data jsonb, ADD COLUMN parsing_error text, ADD COLUMN created_at timestamptz default now();
ALTER TABLE expenses ADD CONSTRAINT live_amount_positive CHECK (amount > 0), ADD CONSTRAINT live_description_len CHECK (char_length(description) <= 500), ADD CONSTRAINT live_currency_len CHECK (char_length(currency) <= 10),
  ADD CONSTRAINT live_location_len CHECK (char_length(location) <= 200), ADD CONSTRAINT live_vendor_len CHECK (char_length(vendor_name) <= 200), ADD CONSTRAINT live_parsing_error_len CHECK (char_length(parsing_error) <= 1000);  -- LIVE (22s)
  CREATE TYPE split_type AS ENUM ('equal','custom','percentage','shares');
  CREATE TABLE expense_splits (id uuid primary key default gen_random_uuid(), expense_id uuid not null references expenses(id) on delete cascade, user_id uuid not null, amount numeric not null, created_at timestamptz not null default now(), split_type split_type not null default 'equal', percentage numeric, base_currency_amount numeric, shares numeric);  -- the LIVE columns (live-checks-phase4-receipts.md): NOT NULL DEFAULT columns included
  CREATE TABLE notifications (id uuid primary key default gen_random_uuid(), trip_id uuid not null, user_id uuid not null, kind text not null, entity_type text, entity_id uuid, channel text not null default 'email', dedupe_key text not null, sent_at timestamptz not null default now(), constraint notifications_dedupe_key_unique unique (dedupe_key));
  -- trip chat (live shape from schema.txt; the LIVE policies are not in the repo: ONE permissive participant SELECT policy is assumed, the migration only adds RESTRICTIVE ones)
CREATE TYPE chat_message_role AS ENUM ('user','assistant','system');
CREATE TABLE trip_chat_messages (id uuid primary key default gen_random_uuid(), trip_id uuid not null references trips(id) on delete cascade, user_id uuid references users(id), role chat_message_role not null, content text not null, actions_executed jsonb default '[]'::jsonb, had_write_actions boolean default false, metadata jsonb default '{}'::jsonb, created_at timestamptz default now());
ALTER TABLE trip_chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "stub: participants can view chat messages" ON trip_chat_messages FOR SELECT USING (is_trip_participant(trip_id, auth.uid()));
CREATE TABLE ai_usage (id uuid primary key default gen_random_uuid(), user_id uuid references users(id) on delete set null, trip_id uuid references trips(id) on delete set null, function_name text not null, model text not null, input_tokens int, output_tokens int, cache_read_tokens int, cache_write_tokens int, estimated_cost_usd numeric(10,6), created_at timestamptz not null default now());
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own ai usage" ON ai_usage FOR SELECT USING (auth.uid() = user_id);
-- trip_timeline_events (live shape + the FOUR live policies, verbatim, recorded 2026-11-20: organisers write, participants read) and the enum / places it needs (20261201090000_own_travel_and_plans.sql)
CREATE TYPE timeline_event_category AS ENUM ('flight','accommodation','transport','activity','dining','transfer','meeting_point','free_time','other');
CREATE TABLE places (id uuid primary key default gen_random_uuid(), trip_id uuid not null references trips(id) on delete cascade, name text not null default 'Place');
CREATE TABLE trip_timeline_events (id uuid primary key default gen_random_uuid(), trip_id uuid not null references trips(id) on delete cascade, event_date date not null, start_time time, end_time time, all_day boolean default false, title text not null, description text,
  category timeline_event_category not null default 'other', location text, participant_ids uuid[], metadata jsonb default '{}'::jsonb, sort_order integer default 0, source_option_id uuid, created_by uuid not null references users(id), created_at timestamptz default now(), updated_at timestamptz default now(),
  place_id uuid references places(id) on delete set null);
ALTER TABLE trip_timeline_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY organizers_insert_timeline ON trip_timeline_events FOR INSERT WITH CHECK (is_trip_organizer(trip_id, auth.uid()));
CREATE POLICY organizers_update_timeline ON trip_timeline_events FOR UPDATE USING (is_trip_organizer(trip_id, auth.uid()));
CREATE POLICY organizers_delete_timeline ON trip_timeline_events FOR DELETE USING (is_trip_organizer(trip_id, auth.uid()));
CREATE POLICY participants_view_timeline ON trip_timeline_events FOR SELECT USING (is_trip_participant(trip_id, auth.uid()));
-- Supabase default ACLs: every new table/function in public is open to the three API roles (the migrations revoke what must not be)
  GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
  GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated, service_role;
  ALTER ROLE service_role BYPASSRLS;
  -- RLS on the base tables with the policies RECORDED in live-checks-receipts.md / live-checks-paid-email.md (trips, trip_participants, users: policies not recorded in full,
  -- left open here and listed as a required live check)
  ALTER TABLE expenses DROP CONSTRAINT expenses_trip_id_fkey, ADD CONSTRAINT expenses_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE;  -- live: a trip's expenses go with it
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY; ALTER TABLE expense_line_items ENABLE ROW LEVEL SECURITY; ALTER TABLE expense_item_claims ENABLE ROW LEVEL SECURITY;
  ALTER TABLE activity_feed ENABLE ROW LEVEL SECURITY; ALTER TABLE settlements ENABLE ROW LEVEL SECURITY; ALTER TABLE expense_splits ENABLE ROW LEVEL SECURITY; ALTER TABLE expense_allocation_links ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Users can view expenses for their trips" ON expenses FOR SELECT USING (is_trip_participant(trip_id, auth.uid()));
  CREATE POLICY "Participants can create expenses" ON expenses FOR INSERT TO authenticated WITH CHECK (is_trip_participant(trip_id, auth.uid()));
  CREATE POLICY "Participants can update trip expenses" ON expenses FOR UPDATE USING (is_trip_participant(trip_id, auth.uid())) WITH CHECK (is_trip_participant(trip_id, auth.uid()));
  CREATE POLICY "Users can delete their own" ON expenses FOR DELETE USING (auth.uid() = paid_by);
  CREATE POLICY "Organizers can delete trip expenses" ON expenses FOR DELETE USING (is_trip_organizer(trip_id, auth.uid()));
  CREATE POLICY "li select" ON expense_line_items FOR SELECT USING (EXISTS (SELECT 1 FROM expenses e WHERE e.id = expense_id AND is_trip_participant(e.trip_id, auth.uid())));
  CREATE POLICY "li insert" ON expense_line_items FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM expenses e WHERE e.id = expense_id AND is_trip_participant(e.trip_id, auth.uid())));
  CREATE POLICY "li delete" ON expense_line_items FOR DELETE USING (EXISTS (SELECT 1 FROM expenses e WHERE e.id = expense_id AND (e.paid_by = auth.uid() OR EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role = 'admin'))));
  CREATE POLICY "Trip participants can view claims" ON expense_item_claims FOR SELECT USING (EXISTS (SELECT 1 FROM expenses e WHERE e.id = expense_id AND is_trip_participant(e.trip_id, auth.uid())));
  CREATE POLICY "Users can create their own claims" ON expense_item_claims FOR INSERT WITH CHECK (auth.uid() = user_id AND EXISTS (SELECT 1 FROM expenses e WHERE e.id = expense_id AND is_trip_participant(e.trip_id, auth.uid())));
  CREATE POLICY "Users can delete their own claims" ON expense_item_claims FOR DELETE USING (auth.uid() = user_id OR EXISTS (SELECT 1 FROM expenses e WHERE e.id = expense_id AND (e.paid_by = auth.uid() OR EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role = 'admin'))));
  CREATE POLICY "Users can update their own claims" ON expense_item_claims FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  CREATE POLICY "af select" ON activity_feed FOR SELECT USING (is_trip_participant(trip_id, auth.uid()));
  CREATE POLICY "Participants can write their own activity" ON activity_feed FOR INSERT WITH CHECK (is_trip_participant(trip_id, auth.uid()) AND (actor IS NULL OR actor = auth.uid()));
  CREATE POLICY "Participants can view settlements" ON settlements FOR SELECT TO authenticated USING (trip_id IN (SELECT trip_id FROM trip_participants WHERE user_id = auth.uid()));
  CREATE POLICY "Participants can create settlements" ON settlements FOR INSERT TO authenticated WITH CHECK (trip_id IN (SELECT trip_id FROM trip_participants WHERE user_id = auth.uid()) AND created_by = auth.uid());
  CREATE POLICY "Creator, organizer, payer or payee can update settlement" ON settlements FOR UPDATE TO authenticated USING (created_by = auth.uid() OR is_trip_organizer(trip_id, auth.uid()) OR from_user_id = auth.uid() OR to_user_id = auth.uid()) WITH CHECK (created_by = auth.uid() OR is_trip_organizer(trip_id, auth.uid()) OR from_user_id = auth.uid() OR to_user_id = auth.uid());
  CREATE POLICY "Creator, organizer or admin can delete settlement" ON settlements FOR DELETE TO authenticated USING (is_trip_organizer(trip_id, auth.uid()) AND status = 'suggested');
  CREATE POLICY "splits insert" ON expense_splits FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM expenses e WHERE e.id = expense_id AND is_trip_participant(e.trip_id, auth.uid())));
CREATE POLICY "splits update" ON expense_splits FOR UPDATE USING (EXISTS (SELECT 1 FROM expenses e WHERE e.id = expense_id AND is_trip_participant(e.trip_id, auth.uid())));
CREATE POLICY "splits delete" ON expense_splits FOR DELETE USING (EXISTS (SELECT 1 FROM expenses e WHERE e.id = expense_id AND is_trip_participant(e.trip_id, auth.uid())));
CREATE POLICY "splits select" ON expense_splits FOR SELECT USING (EXISTS (SELECT 1 FROM expenses e WHERE e.id = expense_id AND is_trip_participant(e.trip_id, auth.uid())));
  CREATE POLICY "links select" ON expense_allocation_links FOR SELECT USING (is_trip_participant(trip_id, auth.uid()));
  `)
  for (let i = 100; i <= 119; i++) await db.query(`insert into users(id,role,full_name) values ($1,'member',$2)`, [U(i), 'F' + i])
  for (let i = 100; i <= 119; i++) await db.query(`insert into trip_participants(trip_id,user_id,role,active) values ($1,$2,'participant',true)`, [T, U(i)])
  await db.query(`update users set first_name='Alice' where id=$1`, [U(2)])
  
  
}
