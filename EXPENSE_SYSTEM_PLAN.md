# Expense System - Detailed Implementation Plan

**Status**: ✅ COMPLETE (Phase 7A-7G implemented, 7H-7I optional features skipped)

## Overview
Comprehensive expense tracking with multi-currency support, flexible splitting, and settlement tracking.

## Key Features

### 1. Multi-Currency Support
- Support major currencies: GBP, EUR, USD, CHF, JPY, AUD, CAD
- Automatic conversion to GBP using historical FX rates
- FX rate from **payment date** (not entry date)
- Use frankfurter.app API (free, no key required)

### 2. Flexible Splitting
- **Even Split**: Divide equally among selected participants
- **Custom Amounts**: Enter specific amount for each person (itemized bills)
- **Percentage Split**: Enter percentage for each person

### 3. Balance Tracking
- Show each user's net balance (what they're owed or owe)
- Calculate: `net = paid - owed + settlements_received - settlements_made`
- Color-coded display (green = owed, red = owing, gray = balanced)

### 4. Settlement System
- Record when people pay each other back in real life
- Simple flow: "X paid Y £50" → reduces both balances
- Settlement history with timeline
- Validation: can't settle more than owed

## Database Schema

### New Table: settlements
```sql
CREATE TABLE settlements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  from_user_id UUID NOT NULL REFERENCES users(id),
  to_user_id UUID NOT NULL REFERENCES users(id),
  amount DECIMAL(10, 2) NOT NULL CHECK (amount > 0),
  payment_method TEXT,
  notes TEXT CHECK (char_length(notes) <= 500),
  settled_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES users(id),

  CONSTRAINT different_users CHECK (from_user_id != to_user_id)
);
```

### Updated Table: expenses
```sql
ALTER TABLE expenses ADD COLUMN payment_date DATE NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE expenses ADD COLUMN category TEXT NOT NULL DEFAULT 'other';
ALTER TABLE expenses ADD COLUMN vendor_name TEXT CHECK (char_length(vendor_name) <= 200);
ALTER TABLE expenses ADD COLUMN location TEXT CHECK (char_length(location) <= 200);
ALTER TABLE expenses ADD COLUMN base_currency_amount DECIMAL(10, 2);
ALTER TABLE expenses ADD COLUMN fx_rate DECIMAL(10, 6);
ALTER TABLE expenses ADD COLUMN fx_rate_date DATE;
ALTER TABLE expenses ALTER COLUMN description TYPE TEXT;
ALTER TABLE expenses ADD CONSTRAINT description_length CHECK (char_length(description) <= 500);
```

### Updated Table: expense_splits
```sql
ALTER TABLE expense_splits ADD COLUMN split_type TEXT NOT NULL DEFAULT 'equal';
ALTER TABLE expense_splits ADD COLUMN percentage DECIMAL(5, 2) CHECK (percentage >= 0 AND percentage <= 100);
ALTER TABLE expense_splits ADD COLUMN base_currency_amount DECIMAL(10, 2);
ALTER TABLE expense_splits DROP COLUMN settled;
ALTER TABLE expense_splits DROP COLUMN settled_at;
```

### New Enums
```sql
CREATE TYPE expense_category AS ENUM (
  'accommodation',
  'transport',
  'food',
  'activities',
  'equipment',
  'other'
);

CREATE TYPE split_type AS ENUM (
  'equal',
  'custom',
  'percentage'
);
```

## UI Components

### 1. ExpensesTab
**Layout**: Main container with sidebar
- **Left**: Expense list (scrollable)
- **Right**: Balance summary (sticky)

**Features**:
- List all expenses for trip
- Filter by category
- Sort by date / amount
- Search by description
- Add Expense button (FAB)

### 2. ExpenseCard
**Display**:
```
[Category Badge] Restaurant Dinner
Paid by Tim • Jan 15, 2025
€120.00 (£102.00)
Split between: [Avatar] [Avatar] [Avatar]
```

**Actions**:
- Click to expand details
- Edit (if creator or admin)
- Delete (if creator or admin)

### 3. AddExpenseModal (4 Steps)

**Step 1: Basic Info**
- Description (required, max 500 chars)
- Amount (required, positive number)
- Currency selector (dropdown)
- Payment date (date picker)
- Category (dropdown)
- Vendor name (optional)
- Location (optional)

**Step 2: Who Paid**
- Select participant (default: current user)
- Shows avatar and name

**Step 3: Split Method**
- Radio selection: Even / Custom / Percentage
- **Even**: Multi-select participants (minimum 1)
- **Custom**: Input amount for each selected participant
- **Percentage**: Input percentage for each selected participant
- Show running total / validation

**Step 4: Review**
- Summary table of split
- FX conversion display (if not GBP)
- Total validation
- Submit button

### 4. BalanceSummary
**Your Balance**:
```
You paid:     £450.00
You owe:      £120.00
Received:     £0.00
Paid back:    £0.00
─────────────────────
Net balance:  £330.00 ✓
```

**Actions**:
- "View Settlement History" button
- "Record Payment" button

### 5. SettlementSummary
**Who Owes Whom**:
```
Sarah owes you     £45.00
You owe Tom        £30.00
Tom owes Sarah     £15.00
```

**Simplified Suggestion**:
```
To settle up:
1. Tom pays you £30.00
2. You pay Sarah £45.00
```

**Actions**:
- "Record Settlement" button on each line

### 6. RecordSettlementModal
**Form**:
- From (selector)
- To (selector)
- Amount (input, max = debt amount)
- Date (date picker)
- Payment method (optional dropdown)
- Notes (optional textarea)

**Validation**:
- Amount must be positive
- Amount ≤ current debt
- From ≠ To

## FX Rate Integration

### API: frankfurter.app
```typescript
// Fetch historical rate
GET https://api.frankfurter.app/2025-01-15?from=EUR&to=GBP

// Response:
{
  "amount": 1.0,
  "base": "EUR",
  "date": "2025-01-15",
  "rates": { "GBP": 0.85 }
}
```

### Caching Strategy
- Cache rates in-memory for session
- Store in localStorage for 24 hours
- Key: `fx_rate_${date}_${from}_${to}`

### Fallback
- If API fails, show warning
- Allow manual FX rate entry
- Suggest checking xe.com

## Balance Calculation Algorithm

### Step 1: Calculate Expenses
```typescript
for each user:
  total_paid = SUM(expenses where paid_by = user)
  total_owed = SUM(expense_splits where user_id = user)
```

### Step 2: Add Settlements
```typescript
for each user:
  settlements_received = SUM(settlements where to_user_id = user)
  settlements_paid = SUM(settlements where from_user_id = user)
```

### Step 3: Calculate Net
```typescript
net_balance = total_paid - total_owed + settlements_received - settlements_paid
```

### Step 4: Pairwise Balances
```typescript
// For each pair of users (A, B):
// Calculate: (A paid for B) - (B paid for A) - (settlements A→B) + (settlements B→A)
```

## RLS Policies

### expenses
- SELECT: Trip participants
- INSERT: Trip participants
- UPDATE: Creator or admin
- DELETE: Creator or admin

### expense_splits
- SELECT: Trip participants
- INSERT: System only (created with expense)
- UPDATE: Never
- DELETE: Cascade with expense

### settlements
- SELECT: Trip participants
- INSERT: Trip participants
- UPDATE: Creator within 24 hours
- DELETE: Creator within 24 hours or admin

## Implementation Order

### Phase 7A: Database ✅ COMPLETE (2 hours)
1. ✅ Create enums (expense_category, split_type)
2. ✅ Alter expenses table (9 new fields)
3. ✅ Alter expense_splits table (3 new fields, removed 2)
4. ✅ Create settlements table (10 fields)
5. ✅ Add RLS policies (13 new policies)
6. ✅ Test policies in Supabase Dashboard
7. ✅ Fix admin delete policy
8. ✅ Fix expense_splits INSERT policy

### Phase 7B: FX Utilities ✅ COMPLETE (1 hour)
1. ✅ Create `src/lib/currency.ts` (320 lines)
2. ✅ Implement frankfurter API integration
3. ✅ Add two-level caching logic (in-memory + localStorage, 24hr TTL)
4. ✅ Add error handling and fallbacks
5. ✅ Support 7 major currencies

### Phase 7C: Basic UI ✅ COMPLETE (1.5 hours)
1. ✅ Create ExpensesTab component (650 lines)
2. ✅ Create ExpenseCard component
3. ✅ Fetch and display expenses
4. ✅ Add empty state
5. ✅ Add category filtering
6. ✅ Add BalanceSummary sidebar
7. ✅ Integrate into TripDetail page

### Phase 7D: Add Expense ✅ COMPLETE (2 hours)
1. ✅ Create AddExpenseModal (700 lines)
2. ✅ Implement 4-step wizard
3. ✅ Add split calculations for all 3 types
4. ✅ Integrate FX conversion with preview
5. ✅ Test all split types
6. ✅ Add validation to prevent zero amounts
7. ✅ Fix RLS policy for split creation

### Phase 7E: Balance & Settlement ✅ COMPLETE (1 hour)
1. ✅ Create BalanceSummary component
2. ✅ Implement balance calculation algorithm
3. ✅ Create SettlementSummary component
4. ✅ Implement debt minimization algorithm (src/lib/debtMinimization.ts)
5. ✅ Add settlement suggestions display
6. ⏭️ RecordSettlementModal (not implemented - placeholder buttons)
7. ⏭️ Settlement history (not implemented)

### Phase 7F: Receipt Upload ✅ COMPLETE (1.5 hours)
1. ✅ Set up Supabase Storage bucket (receipts, 3MB limit, private)
2. ✅ Configure storage RLS policies (3 policies for INSERT/SELECT/DELETE)
3. ✅ Create `src/lib/receiptUpload.ts` (250 lines)
4. ✅ Implement HEIC/HEIF to JPEG conversion (heic2any) - MANDATORY
5. ✅ Implement image compression (browser-image-compression, 70-80% reduction) - MANDATORY
6. ✅ Add strict file size validation (15MB max original, 3MB max final)
7. ✅ Add receipt upload UI in AddExpenseModal Step 1
8. ✅ Add receipt display in ExpenseCard with ReceiptDisplay component
9. ✅ Implement signed URLs for secure private bucket access (1-hour expiry)
10. ✅ Support JPEG, PNG, PDF, HEIC, HEIF formats
11. ✅ Install NPM packages (heic2any, browser-image-compression)
12. ✅ Add async URL fetching with loading/error states

### Phase 7G: Edit & Delete ✅ COMPLETE (1 hour)
1. ✅ Add delete expense with cascade handling
2. ✅ Add admin delete RLS policy
3. ✅ Add confirmation dialogs showing impact
4. ⏭️ Edit expense functionality (not implemented - delete and re-add instead)
5. ⏭️ Expense history/audit trail (not implemented)

**Total Time Spent: 10 hours** (estimated 12 hours)
**Implementation Date**: 2025-11-01

### Files Created
1. `/src/lib/currency.ts` (320 lines) - FX rate utilities
2. `/src/lib/debtMinimization.ts` (90 lines) - Settlement optimization
3. `/src/lib/receiptUpload.ts` (230 lines) - Receipt upload utilities
4. `/src/components/ExpensesTab.tsx` (650 lines) - Main expenses UI
5. `/src/components/AddExpenseModal.tsx` (700 lines) - Expense creation wizard

### Migrations Applied
1. `expense_system_schema_phase_7a` - Database schema updates
2. `add_admin_delete_expense_policy` - Admin delete rights
3. `fix_expense_splits_insert_policy` - Fixed RLS policy for splits

### NPM Packages Installed
```bash
npm install heic2any browser-image-compression
```

## Testing Checklist

- [x] Add expense in GBP (no FX conversion)
- [x] Add expense in EUR (with FX conversion)
- [x] Test even split (3 people)
- [x] Test custom split (itemized amounts)
- [x] Test percentage split
- [x] Verify balance calculations
- [ ] Record settlement between users (not implemented)
- [ ] Verify balances update after settlement (not implemented)
- [ ] Test edit expense (not implemented - delete and re-add)
- [x] Test delete expense (admin and creator)
- [x] Test FX API failure handling
- [x] Verify RLS policies
- [x] Test receipt upload (JPEG, PNG)
- [x] Test HEIC conversion (iPhone photos)
- [x] Verify receipt display in expense cards
- [x] Test image compression (reduces by 70-80%)
- [x] Verify optimized settlements display

## Receipt Upload Strategy (Phase 7F - Optional)

### Supported Formats
- **Input**: JPEG, PNG, PDF, HEIC/HEIF (iPhone photos)
- **Storage**: JPEG, PNG, PDF (HEIC converted to JPEG)

### HEIC Handling
```typescript
// Use heic2any library for client-side conversion
import heic2any from 'heic2any'

async function convertHeicToJpeg(file: File): Promise<File> {
  if (file.type === 'image/heic' || file.name.endsWith('.heic')) {
    const converted = await heic2any({
      blob: file,
      toType: 'image/jpeg',
      quality: 0.8
    })
    return new File([converted], file.name.replace('.heic', '.jpg'), {
      type: 'image/jpeg'
    })
  }
  return file
}
```

### Compression
```typescript
// Compress images before upload (reduce file size by 70-80%)
import imageCompression from 'browser-image-compression'

const options = {
  maxSizeMB: 0.5,
  maxWidthOrHeight: 1920,
  useWebWorker: true
}
await imageCompression(file, options)
```

### Storage Limits
- Max original file size: 15 MB (before compression)
- Max final file size: 3 MB (after compression)
- Supabase free tier: 1 GB total storage
- Estimated capacity: ~2000 receipts at 500 KB each
- PDF files: 3 MB max (no compression applied)

### Security & Access
- **Private bucket**: Not publicly accessible
- **Signed URLs**: Temporary access links that expire after 1 hour
- **RLS policies**: Users can only access receipts for trips they're participants in
- **Folder structure**: `{userId}/{filename}` for organization and security

## Future Enhancements (Not in Phase 7)

- AI receipt parsing (OCR + Anthropic API)
- Export expenses to CSV
- Multi-trip settlement (pay back across trips)
- Recurring expenses
- Expense templates
- Budget tracking
- Currency converter tool
