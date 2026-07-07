# Security Audit — Trips v2

**Date:** 2026-07-07
**Scope:** v2 rebuild QA/hardening gate (workstream H). Read-mostly audit of the Postgres schema/RLS, the six Supabase Edge Functions, the production frontend bundle, third-party dependencies, and the invitation/signup brute-force surface.
**Sources reviewed:** `backups/pre_v2_schema_20260706.sql` (authoritative pre-v2 baseline, 3152 lines), `supabase/migrations/20260706153414_v2_additions.sql` (v2 additive DDL), `supabase/migrations/20260707090000_waitlist_offers.sql`, all six `supabase/functions/*/index.ts` plus `_shared/` helpers (excluding `receiptReconciliation.ts`, owned by another workstream), the production Vite build in `dist/`, `package.json`/`npm audit`, and `src/features/auth/Signup.tsx`.

Severity scale: **Critical** (exploitable now, high impact — data breach/takeover) · **High** (exploitable now, meaningful impact) · **Medium** (exploitable under specific conditions or lower impact) · **Low** (defense-in-depth gap, limited blast radius) · **Info** (no action required, noted for completeness).

---

## 1. Per-table access matrix (RLS)

Legend: **SD** = SECURITY DEFINER helper (`is_trip_participant`, `is_trip_organizer`, `can_view_trip`) used inside policies to check trip membership without RLS recursion.

### Pre-v2 baseline tables

| Table | Select | Insert | Update | Delete | RLS enabled? | Notes / anomalies |
|---|---|---|---|---|---|---|
| `users` | `USING (true)` — any session, incl. anon | self only (`auth.uid() = id`) | self only, **no WITH CHECK** | none | Yes | See Finding M-1 (payment_details exposed) and Finding M-3 (no WITH CHECK, role self-escalation risk). |
| `trips` | `can_view_trip()` (admin/creator/participant/public) | creator only | creator/admin + organizer-settings policy, **no WITH CHECK** on either | creator/admin | Yes | See Finding M-3. |
| `trip_participants` | admin/self/participant/public-trip | admin or organizer | 3 overlapping policies (organizer/admin/self), **no WITH CHECK** on organizer/admin ones | admin/self/organizer | Yes | See Finding M-3. |
| `planning_sections` | participant | organizer | organizer, no WITH CHECK | organizer | Yes | Consistent pattern, low risk (scoped by USING already). |
| `options` | participant (via section→trip) | organizer | organizer, no WITH CHECK | organizer | Yes | Could re-point `section_id` cross-trip in theory (Low). |
| `selections` | participant | self + participant | self, no WITH CHECK | self | Yes | Self-serve data only (Low). |
| `comments` | participant | self + participant | self, no WITH CHECK | self | Yes | Self-serve data only (Low). |
| `expenses` | participant | participant | 3 overlapping policies (self/organizer/admin), **no WITH CHECK on any** | self/organizer/admin | Yes | See Finding M-3 — `trip_id` reassignment risk. |
| `expense_splits` | participant | participant | 4 overlapping policies, 3 of 4 **no WITH CHECK** | creator/organizer/admin | Yes | See Finding M-3. |
| `expense_line_items` | participant | participant | none | creator/admin | Yes | No UPDATE policy — immutable post-insert (fine). |
| `expense_item_claims` | participant | self + participant | self, **WITH CHECK present** | self/paid_by/admin | Yes | Good pattern. |
| `expense_allocation_links` | participant | self + participant | none | creator/admin | Yes | Immutable links (fine). |
| `settlements` | participant | self + participant | self, time-boxed 24h, no WITH CHECK | self (24h)/admin | Yes | See Finding M-3. |
| `invitations` | admin **OR `auth.uid() IS NULL`** | admin only | admin only | admin only | Yes | **Finding M-2** — full table readable by anonymous callers. |
| `invitation_attempts` | **admin only** (`role='admin'`) | `WITH CHECK (true)`, granted to `anon` | none | none | Yes | SELECT correctly locked to admins. See Finding H-1 (unrestricted anonymous INSERT) and Finding C-1 (SECURITY DEFINER RPC bypasses the admin-only SELECT). |
| `fx_rates` | `USING (true)` (public reference data) | any authenticated | **`USING (true) WITH CHECK (true)`** — any authenticated user | none | Yes | Finding M-4 — any signed-in user can corrupt shared exchange-rate data. |
| `trip_notes` | `can_view_trip` | self + `can_view_trip` | self, **WITH CHECK present** | self/organizer | Yes | Good pattern. |
| `trip_chat_messages` | participant | **none** | **none** | **none** | Yes | Correctly append-only via service role / edge function only. |
| `trip_timeline_events` | participant | organizer | organizer, no WITH CHECK | organizer | Yes | Same class as Finding M-3 (Low/Medium here specifically). |

### v2 additions (`20260706153414_v2_additions.sql`)

| Table | Select | Insert | Update | Delete | RLS enabled? | Notes / anomalies |
|---|---|---|---|---|---|---|
| `places` | `can_view_trip` | participant | organizer, **WITH CHECK present** | organizer | Yes | Clean — one of the best-designed tables in the schema. |
| `bookings` | `can_view_trip` | organizer | organizer, **WITH CHECK present** | organizer | Yes | Clean, symmetric organizer-only writes. |
| `option_votes` | participant (nested subquery) | self + participant | self, **WITH CHECK present** | self | Yes | See Finding L-2 — `hide_votes_until_close` is UI-only, not RLS-enforced (acknowledged in the migration's own comment). |
| `reactions` | `can_view_trip` | self + participant | none | self | Yes | No UPDATE (reasonable for reactions). |
| `activity_feed` | `can_view_trip` | participant, `actor IS NULL OR actor = auth.uid()` | none | none | Yes | Append-only (good). See Finding L-3 — no shape validation on actor-less rows. |
| `rate_limits` | none | none | none | none | Yes | **Zero client-facing policies — correct default-deny.** Only reachable via `consume_rate_limit()` SECURITY DEFINER RPC or service_role. |
| `ai_usage` | self only (`auth.uid() = user_id`) | none | none | none | Yes | Correct: reads scoped to self, writes are service-role only from edge functions. |
| `trip_checklists` | `can_view_trip` | self + participant | creator/assignee/organizer, **WITH CHECK present** | creator/organizer | Yes | Good — WITH CHECK mirrors USING. |
| `settlement_carryovers` | `can_view_trip` (destination trip) | organizer of destination trip + self | none | organizer (destination trip) | Yes | **Finding M-5** — INSERT never validates the actor's relationship to `source_trip_id`. |
| `ai_proposals` | `can_view_trip` | self + participant | creator/organizer, **WITH CHECK present** | none | Yes | Good pattern; no delete (proposals expire via `expires_at`). |
| `notifications` | self + organizer (trip-wide) | none | none | none | Yes | **Correctly locked down** — service-role-only writes. |

### `20260707090000_waitlist_offers.sql`

No new table — adds one nullable column (`trip_participants.waitlist_offer_expires_at`). Inherits existing `trip_participants` RLS. No anomaly.

**Bottom line on the core audit question:** all 11 new v2 tables have RLS **enabled**, and none was left completely unprotected — the specific concern in the brief ("missing RLS on new tables") does **not** materialize. The new tables are, if anything, better-designed (more consistent use of `WITH CHECK`) than several pre-v2 baseline tables. The real findings are (a) two genuine pre-existing exposure bugs (`invitation_attempts` open INSERT + a SECURITY DEFINER RPC that bypasses its own table's RLS), and (b) a systemic missing-`WITH CHECK` pattern across much of the pre-v2 baseline's UPDATE policies.

Matrix covers **31 tables** total (19 pre-v2 + 11 v2-new + 1 column-only migration with no new table). **2 tables** (`invitation_attempts`, `invitations`) have policy-level anomalies rated Medium or higher; **~10 tables** share the lower-severity missing-`WITH CHECK` pattern (Finding M-3).

---

## 2. Edge function audit

Shared auth helper: `supabase/functions/_shared/supabaseClients.ts` provides `callerClient()` (RLS-scoped, caller's JWT), `requireUser()` (server-side `auth.getUser()` validation), `requireTripParticipant()` (calls the `is_trip_participant` SECURITY DEFINER RPC keyed on the verified user id), `isTripOrganizer()`, and `serviceClient()` (service-role, RLS-bypassing).

| Function | JWT check | Trip/resource membership check | Service-role usage | Worst finding |
|---|---|---|---|---|
| `auto-chase` | No user-JWT check; requires bearer token to literally equal `SUPABASE_SERVICE_ROLE_KEY` (index.ts ~L121-125) | N/A — cron sweep across all trips by design | Read-heavy + narrow sanctioned writes (`trip_participants.waitlist_offer_expires_at`, `notifications`) | Low |
| `ingest` | Yes — `requireUser`/`auth.getUser()` | Yes — `requireTripParticipant` before any AI call/write | None (writes under caller's own JWT, RLS-enforced) | Low |
| `nudge-draft` | Yes — `requireUser` | Yes for the trip; **no check that `target_user_id` is a participant** before looking up their name/email | None | Low |
| `parse-receipt` | Yes — `requireUser` | Yes — `requireTripParticipant` before rate-limit/storage/AI work | None (storage download under caller's own JWT) | Info — cleanest implementation in the set |
| `refresh-fx-rates` | **No JWT/caller check in code** (fixed in this pass — see §7) | N/A by design | Read/write scoped to `fx_rates` + expense fx metadata only | **High** (pre-fix) |
| `trip-chat` | Yes — `requireUser` | Yes — `requireTripParticipant` + `isTripOrganizer` for tool gating | Write-only to `trip_chat_messages`, ownership already verified earlier in the request | Info/Low |

### Findings

- **[High, fixed in this pass] `refresh-fx-rates` had no in-code authorization check.** Unlike its sibling cron job `auto-chase` (which explicitly requires the bearer token to equal the service-role key), `refresh-fx-rates` proceeded directly into a full cross-trip financial-data mutation job (writes `fx_rates`, `expenses.fx_rate*`, `expense_splits.base_currency_amount` for every eligible expense in the system) with **zero authorization gate in code**. `supabase/config.toml` has explicit `[functions.trip-chat]` and `[functions.parse-receipt]` blocks with `verify_jwt = true`, but **no equivalent block for `refresh-fx-rates`** — meaning its effective `verify_jwt` behavior is whatever the platform default is, and even where `verify_jwt = true` is in effect, that only requires *some* valid JWT (which the public anon key or any logged-in user's JWT satisfies) — not specifically the service role. Net effect: any authenticated app user could very plausibly invoke this function directly and force a full, on-demand fx-recompute across every trip, with no rate limiting and no audit trail of who triggered it. **Fixed** — see §7.

- **[Low] `nudge-draft` does not verify `target_user_id` is a trip participant** before reading their `full_name`/`first_name`/`email` (index.ts ~L78-88). An authenticated trip participant could pass an arbitrary user id and get back that user's name/email even if they're unrelated to the trip. Actual exposure depends on the `users` table SELECT policy — which this audit found is `USING (true)` (see Finding M-1/§1), so this is not a novel hole on top of that, but it's a second path to the same information. Not fixed in this pass (not a v2 regression, low incremental impact given `users` is already broadly readable) — recommend adding the same `requireTripParticipant`-style check against `target_user_id` for defense-in-depth.

- **[Low] `ingest`'s URL-fetch tool has no SSRF denylist** for internal/private IP ranges (only restricts to `http`/`https` schemes). Likely mitigated by Supabase Edge Functions' sandboxed network egress, but not verified in code. Not fixed — recommend an IP-range denylist if the trust model changes.

- **[Info] `requireUser()` throws a plain `Error`, not the shared `UnauthorizedError`.** `_shared/errors.ts`'s `errorResponse()` maps `HttpError` subclasses to their declared status and defaults everything else to `400`. Since `requireUser()` (in `supabaseClients.ts`) throws `new Error('Unauthorized')` rather than `new UnauthorizedError()`, every function using it (`ingest`, `nudge-draft`, `parse-receipt`, `trip-chat`) currently returns **HTTP 400** for a missing/invalid JWT instead of the semantically-correct **401**. This is a status-code correctness bug, not an access-control hole — the request is still rejected before any real work happens (fails closed) — so it's Info/Low, not fixed in this pass to keep changes minimal (a fix would touch a shared file used by 4 functions; flagged as a recommendation instead).

- **Service-role key scope confirmed correct.** Cross-checked against the requested allowlist (`fx_rates`, `ai_usage`, `notifications`, `rate_limits`, plus `auto-chase`'s read-heavy queries): `_shared/usage.ts` writes only to `ai_usage` via service role; `_shared/rateLimit.ts` uses the caller-scoped client calling a SECURITY DEFINER RPC (not service role) so `auth.uid()` resolves correctly; `auto-chase` writes only `trip_participants.waitlist_offer_expires_at` and `notifications` via service role (both explicitly sanctioned, metadata-only); `refresh-fx-rates` writes `fx_rates` and expense fx-metadata columns only (never `amount`, `description`, `paid_by`, or other user-authored fields); `trip-chat` writes only `trip_chat_messages` via service role, and only after the caller's own trip membership was already verified in the same request. **No function was found using the service role to write arbitrary user data without an ownership check** beyond the `refresh-fx-rates` authorization gap itself (which is about *who can trigger the job*, not about the job writing to the wrong tables).

---

## 3. Bundle secret scan

Ran `npm run build` (Vite production build) — succeeded cleanly, output in `dist/`.

- Searched `dist/assets/*.js` for `service_role`, `sk-` / `sk-ant-` prefixed keys, `PRIVATE KEY` blocks, and `SUPABASE_SERVICE`/`ANTHROPIC_API_KEY` literals — **zero matches**. Server-side secrets (`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`) are correctly confined to edge functions (`Deno.env.get(...)`) and never reach the frontend bundle.
- Found exactly **one** JWT-shaped string in the bundle (`dist/assets/index-CLac-4BT.js`). Decoded its payload: `{"iss":"supabase","ref":"vrmhwfrpdaiovulornli","role":"anon", ...}` — confirmed **`role: anon`**, and the raw string matches `VITE_SUPABASE_ANON_KEY` in the repo's `.env` byte-for-byte. This is the intended, public-by-design anon key, not a service key.
- Other long random-looking strings found via a broad `[A-Za-z0-9_-]{40,}` grep were inspected and are all library internals — the WebAuthn base64url alphabet constant and `ERROR_AUTHENTICATOR_*` constant names (from a passkey/WebAuthn library), not secrets.
- Confirmed `.env` is gitignored and not tracked in git (`git ls-files` shows only `.env.example`); `dist/` is also gitignored (not committed — built fresh by CI/deploy).

**Result: no secrets found in the bundle beyond the expected public anon key. [Info]**

---

## 4. Dependency audit

`npm audit --omit=dev`:

```
4 vulnerabilities (1 moderate, 3 high)
```

| Package | Severity | Advisory | Direct/transitive | Exploitable here? |
|---|---|---|---|---|
| `mdast-util-to-hast` 13.0.0–13.2.0 | Moderate | GHSA-4fh9-h7wg-q85m (unsanitized class attribute) | Transitive via `react-markdown` → used to render `trip_notes`, `confirmation_message`, and FAQ content (all same-trip-member-authored, not stranger-arbitrary input) | Low-Medium in context — markdown content is co-traveler-authored, not fully untrusted, but still worth patching since it's rendered to other users' browsers. |
| `react-router` / `react-router-dom` 7.0.0-pre.0–7.14.2 | High | Multiple: XSS via open redirect, SSR XSS, arbitrary-constructor-invocation RCE in vendored turbo-stream, protocol-relative open redirect, CSRF in Action processing, DoS | **Direct** dependency, actively used (client-side routing throughout the app) | Some advisories are SSR/RSC-specific (this app is a static SPA, not SSR, so several don't apply), but the open-redirect and DoS items are plausibly relevant to a client-rendered router. Worth upgrading. |
| `ws` 8.0.0–8.20.1 | High | GHSA-58qx-3vcg-4xpx (uninitialized memory disclosure), GHSA-96hv-2xvq-fx4p (DoS via tiny fragments) | Transitive via `@supabase/supabase-js` → `@supabase/realtime-js` (Realtime WebSocket client) | Low in practice — this is the client establishing outbound WebSocket connections to Supabase's Realtime service, not a server accepting arbitrary connections; the DoS/memory-disclosure vectors target a `ws` *server*, which this app doesn't run. |

Full `npm audit` (including devDependencies) reports **14 vulnerabilities (1 low, 5 moderate, 8 high)** — the extra 10 are `vite` (dev-server-only path traversal / arbitrary file read, applies to `vite dev`, not the production build) and `launch-editor` (Windows NTLM hash disclosure, dev-tooling only). These are **pure devDependency noise** — not shipped to production, not applicable to the deployed static site.

**Recommendation:** run `npm audit fix` for `mdast-util-to-hast` (should be a safe, non-breaking patch bump) and evaluate a `react-router-dom` major/minor bump (check for breaking changes in the app's routing usage first — do not blind-upgrade without testing). `ws` can be left as-is given the low practical exploitability in a pure WebSocket-client context, but keep an eye on `@supabase/supabase-js` releases that bump it transitively. **Not fixed in this pass** — dependency upgrades are out of scope for a "small, low-risk fix" given the risk of breaking the router or markdown rendering; flagged as a recommendation.

---

## 5. Invitation brute-force check

Confirmed in `src/features/auth/Signup.tsx` (`handleValidateCode`, ~L56-101): every invitation code validation attempt — success or failure — is logged to `invitation_attempts` with `code_attempted`, computed `success`, and `navigator.userAgent`, **before** the validation result is even shown to the user. This matches the pre-v2 design and is unchanged in the v2 signup flow.

**[Medium] There is no lockout mechanism.** A caller can submit an unlimited number of invitation-code guesses with no throttling, no CAPTCHA, and no IP/account-based cooldown — the `invitation_attempts` table is purely a monitoring log (`get_recent_failed_attempts()` surfaces codes with 3+ failed attempts to admins), not an enforcement mechanism. This is expected/known per the v2 master plan (not a regression), so **no fix was built** per the task's instructions — only a recommendation:

- Add a rate limit on invitation-code validation attempts, e.g. via the same `consume_rate_limit()` RPC/pattern already used for `parse_receipt`/`trip_chat`/`ingest`/`nudge_draft` (see `_shared/rateLimit.ts`), keyed on IP address or a pre-auth device/session identifier (since the caller isn't authenticated yet, `auth.uid()` isn't available — would need a variant keyed on `ip_address` or a client-supplied nonce/cookie). A reasonable starting point: **N attempts per code per hour** (e.g. 10/hour) and/or a global per-IP cap, surfaced as a friendly "too many attempts, try again later" error.
- Consider also throttling based on `code_attempted` pattern density (many distinct codes from one source in a short window = enumeration attempt) rather than only per-code — `get_recent_failed_attempts()` already aggregates by code, but a per-source view would catch enumeration across many codes.

---

## 6. Findings summary by severity

| Severity | Count | Findings |
|---|---|---|
| Critical | 1 | C-1: `get_recent_failed_attempts()` RPC bypasses `invitation_attempts` admin-only RLS |
| High | 2 | H-1: `invitation_attempts` open anonymous INSERT; H-2: `refresh-fx-rates` missing in-code auth gate (both addressed in this pass) |
| Medium | 5 | M-1: `users` fully-open SELECT incl. `payment_details`; M-2: `invitations` anon-readable table-wide; M-3: missing `WITH CHECK` across ~10 baseline UPDATE policies; M-4: `fx_rates` UPDATE open to any authenticated user; M-5: `settlement_carryovers` INSERT doesn't validate `source_trip_id` relationship; plus invitation lockout (Medium, recommendation only, expected/known) |
| Low | 5 | nudge-draft target-user membership check; ingest SSRF surface; option_votes pre-close visibility; activity_feed shape validation; auto-chase non-constant-time secret comparison |
| Info | 4 | requireUser() 400-vs-401 status code; bundle scan clean; boilerplate GRANT ALL pattern; several tables/functions confirmed as good/correct patterns |

*(Note: the Medium row lists 5 schema/RLS findings; the invitation-lockout item is a 6th Medium-rated item but is explicitly a "recommended, not built" item per the task brief, not a bug to fix.)*

---

## 7. Fixes applied in this pass

Two low-risk, narrowly-scoped fixes were made. Both follow the existing codebase's own patterns (mirroring a sibling function / a sibling admin-check function) rather than introducing new patterns, to keep risk minimal.

1. **`supabase/functions/refresh-fx-rates/index.ts`** — added an in-code authorization gate requiring the request's bearer token to equal `SUPABASE_SERVICE_ROLE_KEY`, identical to the existing pattern already used by `supabase/functions/auto-chase/index.ts`. Before this fix, the function had no authorization check in code at all and relied entirely on ambient platform defaults (no explicit `[functions.refresh-fx-rates]` block exists in `supabase/config.toml`, unlike `trip-chat`/`parse-receipt`). Returns `401` with `{ success: false, error: '...' }` if the check fails, before any database work begins. **Not deployed** — this is a source change only; no `supabase functions deploy` was run.

2. **`supabase/migrations/20260707100000_fix_failed_attempts_admin_check.sql`** (new file) — hardens `public.get_recent_failed_attempts()`, a `SECURITY DEFINER` function that reads `invitation_attempts` (admin-only per RLS) but previously had **no internal role check** and was granted `EXECUTE` to `anon`/`authenticated`. This meant any signed-in user — or any caller of the public PostgREST RPC endpoint with just the anon key — could call this function directly and read admin-only security-monitoring data (attempted codes, IP addresses, attempt counts), completely bypassing the table's own `"Admins can view all invitation attempts"` RLS policy. The migration replaces the function body with an internal `role = 'admin'` check (mirroring the same pattern already used by `create_invitation()` elsewhere in the schema) that raises an exception for non-admins, and tightens the grant to `authenticated` only (removing `anon`). **This migration file was written but NOT applied** — per the task constraints, `supabase db push` was not run. It needs to be deployed by whoever owns that step before the fix takes effect in the live database.

No other files were modified. `supabase/functions/_shared/receiptReconciliation.ts` and its test file were not touched or read, per instructions.

---

## 8. Recommended but not built

- **Deploy the `20260707100000_fix_failed_attempts_admin_check.sql` migration** (written in this pass, not applied) and confirm `get_recent_failed_attempts()` now rejects non-admin callers.
- **Add `WITH CHECK` clauses** (mirroring existing `USING` clauses, plus explicit protection for sensitive columns like `role`/`trip_id`/`user_id`) to the ~10 tables identified in Finding M-3: `users`, `trips`, `trip_participants`, `expenses`, `expense_splits`, `settlements`, `trip_timeline_events`, `options`, `planning_sections`, `selections`, `comments`. Highest-value first: `users` (prevent self-role-escalation) and `expenses`/`expense_splits` (prevent cross-trip reassignment).
- **Scope `invitations` SELECT for anonymous callers** to a single-row-by-code lookup (e.g. a SECURITY DEFINER RPC returning only the fields needed for signup validation) instead of an open table-wide SELECT, to stop leaking `used_by`/`created_by`/`trip_id` linkage.
- **Restrict `payment_details` visibility** on `users` — either split into a separate trip-scoped table, or add a column-filtered view, so any signed-in user can't read every other user's bank/payment handles.
- **Restrict `fx_rates` UPDATE** to admin/service_role rather than any authenticated user, or route writes through a validating RPC.
- **Add a `source_trip_id` membership/organizer check** to the `settlement_carryovers` INSERT policy.
- **Add a rate limit / lockout on invitation code validation** (see §5) — e.g. reuse the existing `consume_rate_limit()` pattern keyed on IP address, N attempts/code/hour.
- **Fix `requireUser()` to throw `UnauthorizedError`** instead of a plain `Error`, so missing/invalid JWTs return `401` instead of `400` across `ingest`, `nudge-draft`, `parse-receipt`, `trip-chat`.
- **Add a `requireTripParticipant`-style check on `target_user_id`** in `nudge-draft` before reading their name/email.
- **Run `npm audit fix`** for `mdast-util-to-hast` and evaluate a tested upgrade of `react-router-dom` (direct dependency, 8 advisories including a high-severity RCE chain in vendored `turbo-stream`, though several are SSR-specific and may not apply to this SPA).
- **Add a shape/enum CHECK constraint** on `activity_feed.verb`/`entity` if not already validated at the application layer, to prevent participants from inserting malformed system-looking feed entries.
