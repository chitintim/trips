# AI Chat Assistant — Roadmap

## Completed

### Quick Win: Timeline Event IDs in Context
The AI now sees event UUIDs in the timeline context, enabling it to reference specific events for `update_event` and `delete_event` actions. Format: `[uuid] date time: title`.

### Phase 1: Expense Context in System Prompt
The AI now receives:
- **Per-user balance summaries** — who is owed, who owes, net balances in base currency (GBP)
- **Expense overview** — total count, breakdown by currency and category
- **Pending itemized claims** — which expenses need claims, who hasn't claimed yet, claim codes

Data is computed server-side in the edge function from: `expenses` (with nested `expense_splits`, `expense_item_claims`, `expense_allocation_links`) and `settlements`.

---

## Phase 2: Tool-Use for On-Demand Expense Details

### Problem
Including full expense details (every line item, every claim, every split) in the system prompt would work for small trips but wastes tokens. For a trip with 50+ expenses and 15 participants, the expense context alone could reach 10K+ tokens — most of which is irrelevant to any given query.

### Solution: Claude Tool Use
Instead of dumping everything into the system prompt, give the AI **tools** it can call mid-conversation to fetch specific data on demand.

### Proposed Tools

```
get_expense_details(expense_id: string)
→ Returns: full expense record, all line items with names/prices, all claims with who claimed what, splits, receipt info

get_user_expenses(user_id: string)
→ Returns: all expenses paid by or owed by this user, with amounts

get_pending_claims()
→ Returns: all itemized expenses with status != 'allocated', with per-item claim matrix

get_settlement_history()
→ Returns: all settlements with from/to users, amounts, dates

search_expenses(query: string)
→ Returns: expenses matching description/vendor/category search
```

### How It Works
1. System prompt includes the Tier 1 summary (balances, pending claims overview) — same as Phase 1
2. Claude is given tool definitions via the `tools` parameter in the API call
3. When a user asks "what did I spend on food?" or "who hasn't claimed on the Kumo dinner?", the AI calls the relevant tool
4. The edge function executes the tool query against Supabase and returns results
5. Claude incorporates the detailed data into its response
6. This keeps the base system prompt lean (~3K tokens) while allowing deep queries

### Implementation Notes
- Use Claude's native tool_use feature (not function calling shim)
- Each tool call is a separate Supabase query executed in the edge function's streaming loop
- Tool results are injected as `tool_result` messages in the conversation
- Streaming: the AI's text response streams after tool calls complete
- Cache tool definitions alongside the system prompt (they're static per request)

### Token Budget Estimate
| Component | Tokens |
|-----------|--------|
| System prompt (Tier 1 summary) | ~3,000 |
| Tool definitions (5 tools) | ~500 |
| Conversation history (50 msgs) | ~10,000 |
| Tool results (per call) | ~500-2,000 |
| **Total per query** | **~15,000-20,000** |

Well within the 200K context window. With prompt caching, the system prompt + tool definitions are paid once per 5-minute window.

---

## Phase 3: Expense-Related Actions

### Problem
Currently the AI can only modify **timeline events**. Organizers frequently need to:
- Record simple expenses quickly via chat ("I paid 5000 yen for the taxi")
- Mark settlements ("Tony paid me back the 128 quid")
- Generate claim reminders ("who hasn't filled in the Kumo dinner receipt?")

### Proposed Actions

```typescript
interface ExpenseAction {
  type: 'create_expense' | 'record_settlement' | 'generate_claim_reminder'

  // create_expense
  amount?: number
  currency?: string
  description?: string
  category?: string
  paid_by_name?: string  // AI resolves to user_id
  split_type?: 'equal'   // only equal splits via chat (custom/percentage too complex)
  split_among?: string[] // participant names to split among

  // record_settlement
  from_name?: string
  to_name?: string
  settlement_amount?: number

  // generate_claim_reminder
  expense_description?: string  // AI finds matching pending expense
}
```

### Action Details

#### `create_expense`
- AI creates a simple expense with equal split
- Only supports equal splits (custom/percentage requires the UI wizard)
- AI resolves participant names to user_ids from the participant list
- Organizer-only action
- Example: "I paid 82500 yen for the Kumo dinner, split equally among all 15 of us"

#### `record_settlement`
- AI records a settlement between two users
- Resolves names to user_ids
- Validates amount doesn't exceed outstanding debt
- Either party (or organizer) can trigger this
- Example: "Tony just sent me 128 pounds on PayPal"

#### `generate_claim_reminder`
- AI identifies the pending expense and who hasn't claimed
- Generates a formatted summary message (displayed in chat, visible to all)
- Could include the claim link code for easy sharing
- No DB write — purely informational, leveraging the shared chat visibility
- Example: "Can you remind everyone about the Kumo dinner receipt?"
- AI responds: "Hey team! The Kumo Restaurant receipt (JPY 82,500) still needs claims from: Tony, Ginny, Richard. Claim your items here: [claim code ABC12345]"

### Implementation Notes
- Extend `TimelineAction` interface (or create parallel `ExpenseAction` interface)
- Name-to-user_id resolution reuses the existing `nameMap` in `buildSystemPrompt`
- Settlement validation: query current balances before executing
- Claim reminders are the safest to implement first (read-only, high value)
- The `create_expense` action should default to splitting among ALL active participants unless specified

### Complexity & Risk Assessment
| Action | Complexity | Risk | Notes |
|--------|-----------|------|-------|
| `generate_claim_reminder` | Low | None | Read-only, just formats existing data |
| `record_settlement` | Medium | Medium | Writes to settlements table, needs amount validation |
| `create_expense` | High | Medium | Creates expense + splits, needs careful validation |

**Recommended order:** claim reminders first, then settlements, then expense creation.

### Open Questions
- Should `create_expense` support itemized expenses? Probably not via chat — the receipt upload + claim flow is better handled by the existing UI.
- Should non-organizers be able to `record_settlement` for their own debts? This would be useful but needs careful access control.
- Should the AI be able to send actual notifications (email/push) for claim reminders, or just post in the shared chat? Start with chat-only.
