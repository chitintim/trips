# Trip Confirmation System - Implementation Plan

**Status**: 🟡 In Progress - Phase A & B Complete, Phase C Next
**Priority**: HIGH (Solves critical pain point in trip planning)
**Estimated Time**: 8-10 hours total (5 hours spent, 3-5 hours remaining)
**Started**: 2025-11-03

---

## Overview

A system to track participant commitment levels for trips with expensive, non-refundable accommodation. Allows users to indicate their confirmation status with conditions, dependencies, and waitlist management.

---

## Core Requirements

### 1. Confirmation Statuses
- **Pending** - Invited, hasn't responded yet (default)
- **Confirmed** - Locked in, committed to paying their share
- **Interested** - Considering, but not committed yet
- **Conditional** - Will confirm under certain conditions (date or user dependencies)
- **Waitlist** - Doesn't have space but wants to be notified if someone drops
- **Declined** - Not interested/can't make it
- **Cancelled** - Was confirmed but cancelled (needs to find substitute)

### 1b. Common Scenarios & Reasons
Users might want to indicate various reasons. We'll support:

**Date-based conditionals** ("I can confirm by X date"):
- Waiting for annual leave approval from work
- Waiting for exam schedule confirmation
- Waiting for another commitment to resolve
- Need to check with partner/family first

**User-based conditionals** ("I'll confirm when X confirms"):
- Only coming if my friend/partner is coming
- Coming if my roommate is coming (shared transport)
- Following a group decision

**Notes field** for any explanation:
- "Need to check work schedule"
- "Waiting on my boss to approve leave"
- "Only if my girlfriend can come"
- "Depends on exam dates"
- "Will know by end of month"

**Cancelled status** - Important for tracking:
- User was confirmed but needs to cancel
- They're responsible for finding a substitute
- Shows urgency (someone needs to fill this spot)
- Different from "Declined" (never confirmed)

### 2. Conditional Logic
Users can be conditional based on:
- **Date**: "I can confirm by [date]"
- **Users**: "I'll confirm when [User X] confirms"
- **Both**: "I'll confirm when [User X] confirms or by [date], whichever comes first"

### 3. Admin Controls
Trip organizers can set:
- Confirmation requirements message (what commitment means)
- Estimated accommodation cost per person
- External link to full trip costs
- Capacity limit (max participants)
- Overall confirmation deadline (optional)

### 4. Visibility & Prioritization
All participants can see:
- Who's confirmed (with timestamps for priority)
- Who's interested/conditional/waitlist
- Dependencies between users
- Progress toward capacity
- Their own position in priority order

---

## Database Design

### Option 1: Add to Existing Tables (Recommended for MVP)

#### Update `trips` table
Add confirmation settings directly to trips:

```sql
ALTER TABLE trips ADD COLUMN confirmation_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE trips ADD COLUMN confirmation_message TEXT CHECK (char_length(confirmation_message) <= 1000);
ALTER TABLE trips ADD COLUMN estimated_accommodation_cost DECIMAL(10, 2);
ALTER TABLE trips ADD COLUMN accommodation_cost_currency TEXT DEFAULT 'GBP';
ALTER TABLE trips ADD COLUMN full_cost_link TEXT CHECK (char_length(full_cost_link) <= 500);
ALTER TABLE trips ADD COLUMN capacity_limit INTEGER CHECK (capacity_limit > 0);
ALTER TABLE trips ADD COLUMN confirmation_deadline TIMESTAMPTZ;
```

#### Update `trip_participants` table
Add confirmation tracking:

```sql
-- Add new enum types
CREATE TYPE confirmation_status AS ENUM (
  'pending',      -- Invited, not responded
  'confirmed',    -- Locked in, committed
  'interested',   -- Interested but not committed
  'conditional',  -- Will confirm under certain conditions
  'waitlist',     -- Want to be on waitlist
  'declined',     -- Not coming (never committed)
  'cancelled'     -- Was confirmed but cancelled (needs substitute)
);

CREATE TYPE conditional_type AS ENUM (
  'none',         -- No conditions
  'date',         -- Will confirm by date
  'users',        -- Will confirm when other users confirm
  'both'          -- Both date and users conditions
);

-- Add columns to trip_participants
ALTER TABLE trip_participants ADD COLUMN confirmation_status confirmation_status DEFAULT 'pending';
ALTER TABLE trip_participants ADD COLUMN confirmed_at TIMESTAMPTZ;
ALTER TABLE trip_participants ADD COLUMN confirmation_note TEXT CHECK (char_length(confirmation_note) <= 500);
ALTER TABLE trip_participants ADD COLUMN conditional_type conditional_type DEFAULT 'none';
ALTER TABLE trip_participants ADD COLUMN conditional_date DATE;
ALTER TABLE trip_participants ADD COLUMN conditional_user_ids UUID[];
ALTER TABLE trip_participants ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();

-- Create index for performance
CREATE INDEX idx_trip_participants_confirmation ON trip_participants(trip_id, confirmation_status, confirmed_at);
CREATE INDEX idx_trip_participants_conditional ON trip_participants(trip_id, conditional_type) WHERE conditional_type != 'none';
```

### Option 2: Separate Tables (Better for Future Scaling)

Create a dedicated `trip_confirmations` table for better separation and history tracking:

```sql
CREATE TABLE trip_confirmations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trip_id UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  confirmation_enabled BOOLEAN DEFAULT FALSE,
  confirmation_message TEXT CHECK (char_length(confirmation_message) <= 1000),
  estimated_accommodation_cost DECIMAL(10, 2),
  accommodation_cost_currency TEXT DEFAULT 'GBP',
  full_cost_link TEXT CHECK (char_length(full_cost_link) <= 500),
  capacity_limit INTEGER CHECK (capacity_limit > 0),
  confirmation_deadline TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Make trip_id unique (one confirmation setting per trip)
CREATE UNIQUE INDEX idx_trip_confirmations_trip ON trip_confirmations(trip_id);
```

**Recommendation**: Start with Option 1 (add to existing tables) for MVP, migrate to Option 2 if we need history tracking or versioning.

---

## Database Functions

### 1. Get Confirmation Summary
Returns counts and lists for a trip:

```sql
CREATE OR REPLACE FUNCTION get_confirmation_summary(p_trip_id UUID)
RETURNS TABLE (
  status confirmation_status,
  count BIGINT,
  user_ids UUID[]
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT
    confirmation_status as status,
    COUNT(*) as count,
    ARRAY_AGG(user_id ORDER BY confirmed_at NULLS LAST, created_at) as user_ids
  FROM trip_participants
  WHERE trip_id = p_trip_id
  GROUP BY confirmation_status;
$$;
```

### 2. Check if User's Conditions are Met
Determines if a conditional user can now confirm:

```sql
CREATE OR REPLACE FUNCTION check_conditions_met(p_participant_trip_id UUID, p_participant_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_conditional_type conditional_type;
  v_conditional_date DATE;
  v_conditional_user_ids UUID[];
  v_date_met BOOLEAN := FALSE;
  v_users_met BOOLEAN := FALSE;
  v_required_user_id UUID;
BEGIN
  -- Get the participant's conditions
  SELECT conditional_type, conditional_date, conditional_user_ids
  INTO v_conditional_type, v_conditional_date, v_conditional_user_ids
  FROM trip_participants
  WHERE trip_id = p_participant_trip_id AND user_id = p_participant_user_id;

  -- If no conditions, return TRUE
  IF v_conditional_type = 'none' THEN
    RETURN TRUE;
  END IF;

  -- Check date condition
  IF v_conditional_type IN ('date', 'both') THEN
    v_date_met := (v_conditional_date IS NULL OR CURRENT_DATE <= v_conditional_date);
  END IF;

  -- Check users condition
  IF v_conditional_type IN ('users', 'both') THEN
    -- All required users must be confirmed
    v_users_met := NOT EXISTS (
      SELECT 1
      FROM UNNEST(v_conditional_user_ids) AS required_user_id
      WHERE NOT EXISTS (
        SELECT 1
        FROM trip_participants
        WHERE trip_id = p_participant_trip_id
          AND user_id = required_user_id
          AND confirmation_status = 'confirmed'
      )
    );
  END IF;

  -- Return based on condition type
  CASE v_conditional_type
    WHEN 'date' THEN RETURN v_date_met;
    WHEN 'users' THEN RETURN v_users_met;
    WHEN 'both' THEN RETURN v_date_met OR v_users_met;  -- Either condition works
    ELSE RETURN FALSE;
  END CASE;
END;
$$;
```

### 3. Trigger to Auto-Check Dependencies
When someone confirms, check if anyone waiting on them can now be notified:

```sql
CREATE OR REPLACE FUNCTION notify_conditional_users()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_waiting_user RECORD;
BEGIN
  -- Only proceed if status changed to 'confirmed'
  IF NEW.confirmation_status = 'confirmed' AND (OLD.confirmation_status IS NULL OR OLD.confirmation_status != 'confirmed') THEN

    -- Find users waiting on this user
    FOR v_waiting_user IN
      SELECT user_id, trip_id
      FROM trip_participants
      WHERE trip_id = NEW.trip_id
        AND confirmation_status = 'conditional'
        AND conditional_type IN ('users', 'both')
        AND NEW.user_id = ANY(conditional_user_ids)
    LOOP
      -- Check if their conditions are now met
      -- In production, this would trigger a notification
      -- For now, just update updated_at to signal a change
      UPDATE trip_participants
      SET updated_at = NOW()
      WHERE trip_id = v_waiting_user.trip_id
        AND user_id = v_waiting_user.user_id
        AND check_conditions_met(v_waiting_user.trip_id, v_waiting_user.user_id);
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_notify_conditional_users
  AFTER UPDATE OF confirmation_status ON trip_participants
  FOR EACH ROW
  EXECUTE FUNCTION notify_conditional_users();
```

### 4. Capacity Management Function
Automatically move to waitlist if capacity exceeded:

```sql
CREATE OR REPLACE FUNCTION enforce_capacity_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_capacity INTEGER;
  v_confirmed_count INTEGER;
BEGIN
  -- Only enforce when confirming
  IF NEW.confirmation_status = 'confirmed' AND (OLD.confirmation_status IS NULL OR OLD.confirmation_status != 'confirmed') THEN

    -- Get capacity limit
    SELECT capacity_limit INTO v_capacity
    FROM trips
    WHERE id = NEW.trip_id;

    -- If no limit set, allow all confirmations
    IF v_capacity IS NULL THEN
      RETURN NEW;
    END IF;

    -- Count confirmed participants
    SELECT COUNT(*) INTO v_confirmed_count
    FROM trip_participants
    WHERE trip_id = NEW.trip_id
      AND confirmation_status = 'confirmed';

    -- If over capacity, move to waitlist instead
    IF v_confirmed_count > v_capacity THEN
      NEW.confirmation_status := 'waitlist';
      NEW.confirmed_at := NULL;
      -- Could add a note here explaining they were moved to waitlist
    ELSE
      -- Set confirmation timestamp
      NEW.confirmed_at := NOW();
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_enforce_capacity
  BEFORE INSERT OR UPDATE OF confirmation_status ON trip_participants
  FOR EACH ROW
  EXECUTE FUNCTION enforce_capacity_limit();
```

---

## RLS Policies

### trip_participants (updated policies)

```sql
-- Users can read all participants in their trips (existing)
-- No change needed

-- Users can update their own confirmation status
CREATE POLICY "Users can update own confirmation status"
  ON trip_participants FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    -- Only allow updating confirmation fields, not role
    AND role = (SELECT role FROM trip_participants WHERE trip_id = trip_participants.trip_id AND user_id = auth.uid())
  );

-- Organizers and admins can update anyone's confirmation status
CREATE POLICY "Organizers can update confirmation status"
  ON trip_participants FOR UPDATE
  USING (
    is_trip_organizer(trip_id, auth.uid()) OR
    (SELECT role FROM users WHERE id = auth.uid()) = 'admin'
  );
```

### trips (updated policies)

```sql
-- Organizers can update confirmation settings
CREATE POLICY "Organizers can update confirmation settings"
  ON trips FOR UPDATE
  USING (
    created_by = auth.uid() OR
    is_trip_organizer(id, auth.uid()) OR
    (SELECT role FROM users WHERE id = auth.uid()) = 'admin'
  );
```

---

## UI Components

### 1. ConfirmationSettingsPanel (Admin Only)
**Location**: Trip Detail → Overview tab or new "Settings" section

**Features**:
- Toggle switch: "Enable Confirmation Tracking"
- When enabled, show:
  - Rich text editor: "Confirmation Message" (what commitment means)
  - Currency selector + amount: "Estimated Accommodation Cost per Person"
  - URL input: "Full Trip Cost Details Link"
  - Number input: "Capacity Limit" (max participants)
  - Date picker: "Confirmation Deadline" (optional)
- Save/Cancel buttons
- Preview of how it looks to participants

**Component Structure**:
```typescript
interface ConfirmationSettings {
  enabled: boolean
  message: string
  accommodationCost: number
  currency: string
  fullCostLink: string
  capacityLimit: number | null
  deadline: string | null
}

<ConfirmationSettingsPanel
  tripId={trip.id}
  settings={confirmationSettings}
  onSave={handleSaveSettings}
/>
```

### 2. ConfirmationDashboard (All Participants)
**Location**: Trip Detail → People tab (replace or enhance existing participant list)

**Layout**:
```
┌─────────────────────────────────────────────────────┐
│ Confirmation Status                                  │
│                                                      │
│ [Capacity Bar: 8/10 confirmed]                      │
│                                                      │
│ ✅ Confirmed (8) - First come first serve           │
│   [User avatar] Tim - Jan 15, 10:30am               │
│   [User avatar] Sarah - Jan 15, 2:45pm              │
│   ...                                                │
│                                                      │
│ 💭 Interested (2)                                    │
│   [User avatar] Tom - "Checking work schedule"      │
│   ...                                                │
│                                                      │
│ ⏳ Conditional (3)                                   │
│   [User avatar] Emma                                 │
│     └─ Waiting for: [Sarah] [Tom]                   │
│     └─ Or will confirm by: Jan 20                   │
│   ...                                                │
│                                                      │
│ 📋 Waitlist (2)                                      │
│   [User avatar] Alex - #1                           │
│   [User avatar] Jordan - #2                         │
│                                                      │
│ ❌ Declined (1)                                      │
│   [User avatar] Chris                               │
│                                                      │
│ [Update My Status] button (prominent)               │
└─────────────────────────────────────────────────────┘
```

**Features**:
- Real-time capacity progress bar
- Collapsible sections for each status
- Visual indicators (emojis/badges)
- Conditional users show their dependencies with links
- Timestamps show confirmation priority order
- User's own row highlighted
- "Update My Status" button always visible

### 3. UpdateConfirmationModal (User Action)
**Triggered by**: User clicks "Update My Status" button

**Multi-step flow**:

#### Step 1: Choose Status
```
What's your status for this trip?

( ) Confirmed - I'm in! I commit to the accommodation cost
( ) Interested - I'm considering it but not ready to commit
( ) Conditional - I'll confirm under certain conditions
( ) Waitlist - Put me on the waitlist in case space opens
( ) Declined - I can't make this trip

[Next →]
```

#### Step 2: Confirmation Details (conditional on status)

**If Confirmed**:
```
Great! Please confirm you understand:

[Info box]
📍 Accommodation Cost: ~£800 per person
💰 You're committing to pay your share
🚫 No refunds if you cancel
👥 You're responsible for finding a substitute if needed
📄 Full cost details: [link]

☑️ I understand and commit to these terms

Optional note:
[text area]

[← Back]  [Confirm ✓]
```

**If Conditional**:
```
What conditions need to be met?

☑️ I need to confirm by a specific date
  📅 [Date picker: I'll confirm by...]

☑️ I'm waiting for other people to confirm first
  [Multi-select dropdown of trip participants]
  ├─ [ ] Sarah
  ├─ [ ] Tom
  └─ [ ] Emma

Note: You'll be notified when your conditions are met

Optional note:
[text area]

[← Back]  [Save]
```

**If Interested / Waitlist / Declined**:
```
Optional note (visible to organizers):
[text area]

[← Back]  [Save]
```

### 4. ConfirmationStatusBadge (Reusable Component)
Small badge component to show status anywhere:

```typescript
<ConfirmationStatusBadge status="confirmed" />
// Renders: ✅ Confirmed (green)

<ConfirmationStatusBadge status="conditional" />
// Renders: ⏳ Conditional (yellow)
```

### 5. ConditionalDependencyDisplay
Shows user dependencies clearly:

```typescript
<ConditionalDependencyDisplay
  userId={user.id}
  conditionalType="both"
  conditionalDate="2025-01-20"
  conditionalUserIds={['user1', 'user2']}
  participants={tripParticipants}
/>

// Renders:
// Waiting for:
// • Sarah to confirm
// • Tom to confirm
// OR
// • Will confirm by Jan 20, 2025
```

### 6. CapacityProgressBar
Visual indicator of capacity:

```typescript
<CapacityProgressBar
  confirmed={8}
  capacity={10}
/>

// Renders: [████████░░] 8 / 10 confirmed
```

---

## Implementation Phases

### Phase A: Database Foundation ✅ COMPLETE (2 hours)
**Tasks**:
1. ✅ Create new enum types (confirmation_status, conditional_type)
2. ✅ Add columns to trips table (confirmation settings)
3. ✅ Add columns to trip_participants table (confirmation tracking)
4. ✅ Create indexes for performance
5. ✅ Create database functions (get_confirmation_summary, check_conditions_met, get_confirmed_count)
6. ✅ Create triggers (notify_conditional_users, enforce_capacity_limit, clear_confirmed_timestamp)
7. ✅ Add RLS policies (3 policies for secure access)
8. ✅ Apply migrations with Supabase MCP (6 migrations total)
9. ✅ Regenerate TypeScript types

**Completed Migrations**:
1. `add_confirmation_system_enums` - Created 2 enums with 7 + 4 values
2. `add_confirmation_settings_to_trips` - Added 7 columns to trips table
3. `add_confirmation_tracking_to_participants` - Added 7 columns to trip_participants table
4. `add_confirmation_system_functions` - Created 3 helper functions
5. `add_confirmation_system_triggers` - Created 3 automatic triggers
6. `add_confirmation_system_rls_policies` - Added 3 RLS policies

**Validation**:
- ✅ All migrations applied successfully
- ✅ All new columns visible in Supabase Dashboard
- ✅ Enums appear in type list (confirmation_status, conditional_type)
- ✅ Functions created (get_confirmation_summary, check_conditions_met, get_confirmed_count)
- ✅ Triggers created (enforce_capacity_limit, notify_conditional_users, clear_confirmed_timestamp)
- ✅ RLS policies in place (users can update own, organizers can update any)
- ✅ TypeScript types regenerated (902 lines)
- ✅ Dev server compiles with zero errors

### Phase B: Core UI Components 🟡 NEXT (3-4 hours)
**Tasks**:
1. Create ConfirmationStatusBadge component
2. Create CapacityProgressBar component
3. Create ConditionalDependencyDisplay component
4. Create ConfirmationDashboard component
   - Fetch confirmation data
   - Group by status
   - Sort by priority
   - Show dependencies
5. Update TripDetail page to conditionally show ConfirmationDashboard
   - Add to People tab or create new Confirmation tab

**Validation**:
- [ ] Dashboard displays correctly with mock data
- [ ] All status groups render properly
- [ ] Dependencies display clearly
- [ ] Capacity bar shows correct progress
- [ ] Mobile responsive

### Phase C: Status Update Flow (2-3 hours)
**Tasks**:
1. Create UpdateConfirmationModal component
   - Multi-step wizard (status selection → details → confirmation)
   - Conditional logic for different status types
   - Form validation
2. Implement submission logic
   - Update trip_participants table
   - Handle errors gracefully
   - Show success feedback
3. Integrate with ConfirmationDashboard
   - "Update My Status" button
   - Refresh after update
4. Handle edge cases
   - Capacity enforcement
   - Circular dependencies warning
   - Expired deadlines

**Validation**:
- [ ] Modal opens and closes properly
- [ ] All status types can be selected
- [ ] Conditional logic works (date picker, user selector)
- [ ] Database updates correctly
- [ ] Dashboard refreshes after update
- [ ] Capacity limit enforced
- [ ] Errors handled gracefully

### Phase D: Admin Controls (1-2 hours)
**Tasks**:
1. Create ConfirmationSettingsPanel component
2. Add to Trip Detail page (Overview tab or Settings section)
3. Only visible to organizers and admin
4. Implement save/update logic
5. Add validation (capacity must be positive, valid URL, etc.)
6. Show success/error toasts

**Validation**:
- [ ] Panel only visible to organizers/admin
- [ ] Settings save correctly to database
- [ ] Changes reflect immediately in dashboard
- [ ] Validation prevents invalid data
- [ ] Error messages are clear

### Phase E: Enhancements (Optional, 2-3 hours)
**Tasks**:
1. Add email notifications when:
   - Conditions are met (optional)
   - Deadline approaching (optional)
   - Moved to waitlist (optional)
2. Add "Notify Conditional Users" button for admin
3. Export confirmation list to CSV
4. Show confirmation history (status changes over time)
5. Add real-time updates (Phase 6 integration)

---

## User Flows

### Flow 1: Admin Sets Up Confirmation System
1. Admin navigates to trip
2. Clicks "Settings" or finds Confirmation section in Overview
3. Toggles "Enable Confirmation Tracking"
4. Fills in:
   - Message: "You're committing to £800 for the chalet. No refunds, you must find your own substitute if you cancel."
   - Cost: £800 GBP
   - Link: https://docs.google.com/spreadsheets/...
   - Capacity: 10 people
   - Deadline: 2025-01-20
5. Clicks "Save"
6. System shows success message
7. All participants now see Confirmation Dashboard in People tab

### Flow 2: User Confirms Unconditionally
1. User opens trip
2. Sees People/Confirmation tab with dashboard
3. Sees current status: "Pending" with "Update My Status" button
4. Clicks "Update My Status"
5. Modal opens, selects "Confirmed"
6. Reads commitment message, checks "I understand" box
7. Adds note: "So excited!"
8. Clicks "Confirm ✓"
9. Modal closes, dashboard updates
10. User appears in "Confirmed" list with timestamp
11. Other users see the update

### Flow 3: User Confirms Conditionally (Waiting on Friends)
1. User opens trip, clicks "Update My Status"
2. Selects "Conditional"
3. In Step 2:
   - Checks "I'm waiting for other people to confirm first"
   - Selects "Sarah" and "Tom" from dropdown
   - Adds note: "I'll come if my friends are coming!"
4. Clicks "Save"
5. Appears in "Conditional" section with tags showing Sarah and Tom
6. When Sarah confirms:
   - System checks dependencies
   - User is still conditional (waiting on Tom)
7. When Tom confirms:
   - System checks dependencies again
   - Both conditions met!
   - User receives notification: "Your conditions are met!"
8. User clicks notification, modal opens with suggestion to confirm
9. User confirms with one click

### Flow 4: Capacity Reached, User Goes to Waitlist
1. Trip has capacity: 10
2. Currently confirmed: 10 users
3. User tries to confirm (11th person)
4. System automatically moves them to waitlist instead
5. Modal shows message: "Trip is at capacity. You've been added to waitlist at position #1"
6. User appears in Waitlist section
7. If someone cancels:
   - Organizer can manually promote from waitlist
   - Or system could auto-promote (future enhancement)

### Flow 5: Admin Manages Confirmations
1. Admin opens trip
2. Sees full Confirmation Dashboard
3. Can click any user to change their status manually
4. Can add notes to any participant
5. Can see who's blocking conditional users
6. Can export list for sharing
7. Can send reminders to pending users

---

## Edge Cases & Solutions

### 1. Circular Dependencies
**Problem**: User A waits for User B, who waits for User A
**Solution**:
- Detect cycles during save
- Show warning: "This creates a circular dependency with [User B]"
- Prevent save or allow with warning

### 2. Waiting on Declined User
**Problem**: User A waits for User B to confirm, but User B declined
**Solution**:
- Show warning on User A's row: "⚠️ One of your dependencies declined"
- Allow User A to update their conditions
- Suggest they confirm or decline

### 3. Deadline Passed
**Problem**: User has conditional date that's in the past
**Solution**:
- Show as "⏰ Expired" instead of "⏳ Conditional"
- Auto-suggest they update to different status
- Admin can extend deadline

### 4. Capacity Changed After Confirmations
**Problem**: Admin reduces capacity from 12 to 10, but 12 people confirmed
**Solution**:
- Don't automatically move anyone to waitlist (would be unfair)
- Show warning to admin: "⚠️ 12 confirmed but capacity is 10"
- Admin manually decides who stays/moves to waitlist

### 5. Multiple Users Confirm Simultaneously
**Problem**: 11th and 12th person confirm at exact same time, capacity is 10
**Solution**:
- Database trigger enforces limit
- Uses confirmed_at timestamp (microsecond precision)
- First one gets in, second goes to waitlist
- No data race due to database SERIALIZABLE isolation

### 6. User Changes Status Multiple Times
**Problem**: User confirms, then moves to waitlist, then confirms again
**Solution**:
- Always allowed (people change their minds)
- Updated_at tracks most recent change
- Confirmation priority based on most recent confirmed_at
- Optionally track history in separate table (future enhancement)

---

## Technical Considerations

### Performance
- **Indexes**: confirmation_status and confirmed_at for fast sorting
- **Caching**: Get confirmation summary is cacheable (use React Query)
- **Optimistic Updates**: Update UI immediately, revert on error
- **Real-time**: Ideal candidate for Supabase Realtime (Phase 6)

### Security
- **RLS**: Users can only update their own status (unless organizer/admin)
- **Validation**: Server-side checks for capacity, circular dependencies
- **Audit Trail**: Log all status changes (optional, for future)

### Data Integrity
- **Triggers**: Enforce capacity limit automatically
- **Constraints**: Check positive capacity, valid dates
- **Foreign Keys**: Conditional user IDs must reference valid participants

### Mobile UX
- **Touch-friendly**: Large buttons, easy modal navigation
- **Offline**: Cache confirmation data, sync on reconnect
- **Progressive disclosure**: Collapse sections on mobile
- **Quick actions**: One-tap confirm for simple cases

---

## Success Metrics

### MVP Success Criteria
- [ ] Admin can enable confirmation system on any trip
- [ ] Admin can set capacity, cost, message
- [ ] Users can see all participants grouped by status
- [ ] Users can confirm unconditionally
- [ ] Users can set conditional confirmations (date or users)
- [ ] System enforces capacity limit
- [ ] System checks when conditions are met
- [ ] Dashboard updates in real-time when statuses change
- [ ] Mobile responsive and usable

### User Experience Goals
- Reduce WhatsApp back-and-forth by 80%
- Provide clear visibility of trip status for all participants
- Fair, transparent first-come-first-served system
- Simple one-click confirmation for most users
- Flexible conditionals for uncertain users

---

## Future Enhancements (Post-MVP)

### Phase F: Notifications
- Email when conditions met
- Push notifications (PWA)
- Reminder emails for pending users
- Deadline countdown notifications

### Phase G: Payment Integration
- Link confirmations to expense system
- Track deposit payments
- Automatic reminders for payment due dates

### Phase H: Analytics
- Average time to fill capacity
- Confirmation funnel (pending → interested → confirmed)
- Conditional conversion rate
- Waitlist promotion rate

### Phase I: Advanced Features
- Partial confirmations (e.g., "Yes to accommodation, TBD on flights")
- Group confirmations (couples, families)
- Transfer confirmation to someone else
- Refund/credit system for cancellations

---

## Recommended Approach: MVP First

### Start with Core Features
1. ✅ Basic confirmation statuses (pending, confirmed, interested, waitlist, declined)
2. ✅ Capacity limit enforcement
3. ✅ Admin settings panel
4. ✅ User confirmation dashboard
5. ✅ Simple conditional logic (date-based first, then user-based)

### Then Add Enhancements
6. Auto-notifications for conditions met
7. Email notifications
8. Export functionality
9. History tracking

### Finally, Advanced Features
10. Payment integration
11. Analytics
12. Real-time updates (Phase 6)

---

## Implementation Status

### Phase A: Database Foundation ✅ COMPLETE
**Time Spent**: 2 hours
**Completed**: 2025-11-03

**What was built**:
- 2 new enums with 11 total values
- 14 new database columns (7 in trips, 7 in trip_participants)
- 3 helper functions for confirmation logic
- 3 smart triggers for automation
- 3 RLS policies for security
- 6 successful migrations
- Updated TypeScript types (902 lines)

**Database Schema Changes**:
```
trips table:
  + confirmation_enabled (boolean)
  + confirmation_message (text, max 1000 chars)
  + estimated_accommodation_cost (decimal)
  + accommodation_cost_currency (text, default GBP)
  + full_cost_link (text, max 500 chars)
  + capacity_limit (integer, positive)
  + confirmation_deadline (timestamptz)

trip_participants table:
  + confirmation_status (enum: pending/confirmed/interested/conditional/waitlist/declined/cancelled)
  + confirmed_at (timestamptz, for priority ordering)
  + confirmation_note (text, max 500 chars)
  + conditional_type (enum: none/date/users/both)
  + conditional_date (date)
  + conditional_user_ids (uuid array)
  + updated_at (timestamptz, auto-updated)
```

### Phase B: Core UI Components ✅ COMPLETE
**Time Spent**: 3 hours
**Completed**: 2025-11-03

**What was built**:
1. ✅ ConfirmationStatusBadge.tsx (90 lines) - Status badge with 7 statuses, count support
2. ✅ CapacityProgressBar.tsx (145 lines) - Visual capacity tracking with progress bar, smart color coding
3. ✅ ConditionalDependencyDisplay.tsx (240 lines) - Display date/user dependencies with OR logic
4. ✅ ConfirmationDashboard.tsx (400 lines) - Main dashboard with collapsible sections, participant cards

**Features implemented**:
- Badge colors mapped to statuses (confirmed=green, interested=blue, conditional=yellow, waitlist=gray, declined/cancelled=red)
- Capacity progress bar with percentage, visual indicators (full/warning/available)
- Conditional dependency display showing date countdown, user avatars, conditions met status
- Full dashboard with participant grouping, collapsible sections, avatar display, update buttons
- Mobile-responsive design following existing component patterns

### Phase C: Status Update Flow ⏭️ PENDING
**Estimated Time**: 2-3 hours

**Components to build**:
1. UpdateConfirmationModal.tsx (~350 lines)

### Phase D: Admin Controls ⏭️ PENDING
**Estimated Time**: 1-2 hours

**Components to build**:
1. ConfirmationSettingsPanel.tsx (~200 lines)

---

## Summary

This confirmation system solves a critical pain point in trip planning by:
- **Transparently** tracking who's committed vs uncertain
- **Fairly** managing capacity with first-come-first-served
- **Flexibly** handling conditional confirmations
- **Clearly** communicating financial commitments
- **Reducing** manual coordination overhead

**Total Estimated Time**: 8-10 hours
**Time Spent**: 2 hours (Phase A)
**Time Remaining**: 6-8 hours (Phases B, C, D)
**Priority**: HIGH (directly impacts your core use case)
**Dependencies**: None (builds on existing database and UI)

---

## Next Steps

**Immediate**: Start Phase B - Core UI Components
1. Create ConfirmationStatusBadge component (reusable status indicator)
2. Create CapacityProgressBar component (visual capacity tracking)
3. Create ConditionalDependencyDisplay component (show dependencies clearly)
4. Create ConfirmationDashboard component (main interface)

**Then**: Phase C - Status Update Flow (multi-step modal)
**Finally**: Phase D - Admin Controls (settings panel)
