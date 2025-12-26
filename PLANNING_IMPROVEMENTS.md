# Planning Section Improvements - Design Document

## Current System Analysis

### Database Schema
```
planning_sections
├── id, trip_id, section_type, title, description
├── status (not_started, in_progress, completed)
├── order_index, allow_multiple_selections
└── created_at, updated_at

options
├── id, section_id, title, description
├── price, currency, price_type (per_person_fixed, total_split, per_person_tiered)
├── status (draft, available, booking, booked, cancelled)
├── locked, metadata (jsonb)
└── created_at, updated_at

selections
├── id, option_id, user_id
├── metadata (jsonb)
└── selected_at
```

### Current Admin Workflow
1. Create a planning section (modal with: title, type, description, allow_multiple_selections, status)
2. Add options one by one (modal with: title, description, link, price, currency, price_type, status, locked, custom metadata fields)
3. Each option appears as a separate card in the section

### Current User Workflow
1. Expand a section to see all options
2. Scroll through option cards (each shows: title, status badge, description, link, price, selection avatars)
3. Click "Select" button to choose an option
4. For single-choice sections: previous selection is auto-removed
5. Selection avatars show who else selected that option

### Current UX Issues

**1. Ski Rental Problem (13 options = overwhelming)**
```
Level A (Novice)     → Skis Only €68 | Skis+Boots €112 | Full Kit €138
Level B (Intermediate) → Skis Only €101 | Skis+Boots €144 | Full Kit €170
Level C (High Level)  → Skis Only €122 | Skis+Boots €176 | Full Kit €202
Level D (Advanced)    → Skis Only €158 | Skis+Boots €215 | Full Kit €241
+ Not Renting option
```
Currently shows as 13 separate scrollable cards. User can't see the matrix or compare prices easily.

**2. Admin Entry is Tedious**
- Must create each option individually through a modal
- No bulk creation for common patterns (flight options, rental tiers)
- No templates for common ski trip sections

**3. No Visual Grouping**
- Options within a section are a flat list
- Can't group related options (e.g., outbound flights vs return flights)
- No way to show option variants (e.g., with/without helmet)

**4. Selection Visibility**
- Selection avatars are small and require clicking to see details
- Hard to get a "bird's eye view" of who selected what across all options
- No summary view for organizers

---

## Proposed Improvements

### Phase 1: Matrix/Grid View for Equipment Rentals

**Concept:** Instead of 13 cards, show a compact table/grid:

```
┌─────────────────┬──────────┬─────────────┬──────────┐
│ Level           │ Skis Only│ Skis+Boots  │ Full Kit │
├─────────────────┼──────────┼─────────────┼──────────┤
│ A - Novice      │   €68    │    €112     │   €138   │
│ B - Intermediate│   €101   │    €144  ●● │   €170   │
│ C - High Level  │   €122   │    €176     │   €202   │
│ D - Advanced    │   €158   │    €215     │   €241 ● │
└─────────────────┴──────────┴─────────────┴──────────┘
● = user avatars showing who selected
```

**Implementation Options:**

**Option A: Section Display Mode**
- Add `display_mode` field to `planning_sections`: 'list' | 'grid' | 'matrix'
- Add `grid_config` jsonb field to store row/column definitions
- Render differently based on display_mode

**Option B: Structured Options with Variants**
- Add `option_groups` table or use metadata to define groupings
- Options can have `row_key` and `column_key` in metadata
- UI interprets and renders as matrix

**Option C: Template-Based Sections**
- Pre-defined section templates: "Ski Rental Matrix", "Flight Options", etc.
- Template defines structure; admin just fills in prices
- Most user-friendly but least flexible

**Recommended: Option A + B hybrid**
- Section has `display_mode` to control rendering
- Options use metadata `{row: "Level A", column: "Skis+Boots"}` for grid positioning
- Fallback to list view for non-grid sections

### Phase 2: Smart Section Templates

**For Ski Trips, provide quick-setup templates:**

1. **Flights Template**
   - Creates section with outbound + return sub-groups
   - Common fields: departure airport, arrival airport, time, airline, baggage
   - Options: Flight 1, Flight 2, Drive, Self-arrange

2. **Airport Transfers Template**
   - Linked to flights (pickup time based on arrival)
   - Options: Shared transfer, Private transfer, Self-arrange
   - Auto-calculates per-person cost for shared

3. **Ski Rental Template**
   - Matrix builder: Level (rows) × Package (columns)
   - Input fields: Base prices, discount percentage
   - Auto-generates all options with proper metadata

4. **Ski Pass Template**
   - Options: 6-day, 5-day, 4-day passes
   - Shows price per day calculation
   - Discounts for groups

5. **Restaurant Template**
   - Date/time fields
   - Capacity tracking
   - Dietary requirements collection

6. **Insurance Template**
   - Options: Basic, Comprehensive, Self-arrange
   - Policy details in description

### Phase 3: Improved Selection Visualization

**Selection Summary Panel:**
```
┌─────────────────────────────────────┐
│ TRIP SELECTIONS SUMMARY             │
├─────────────────────────────────────┤
│ Flights: 8/11 people selected       │
│   ├─ TUI Option 1: Tim, Alex, Sam   │
│   ├─ TUI Option 2: Jo, Mike         │
│   └─ Driving: Chris, Pat, Kim       │
│                                     │
│ Ski Rental: 9/11 people selected    │
│   └─ [Matrix with avatars]          │
│                                     │
│ ⚠️ Pending: Sarah, Ben              │
└─────────────────────────────────────┘
```

**Selection Comparison View:**
- Toggle between "Options view" and "People view"
- People view shows: Person → Their selections across all sections
- Helps organizers see who hasn't completed all selections

**Real-time Selection Indicators:**
- Pulse animation when someone selects
- "X just selected Y" toast notifications (optional)

### Phase 4: Simplified Admin Entry

**Quick Add Options:**
```
┌─────────────────────────────────────┐
│ Quick Add Options                   │
├─────────────────────────────────────┤
│ Add multiple options at once:       │
│                                     │
│ Option 1: [TUI Flight 08:30    ]   │
│ Price:    [€299] [EUR]              │
│                                     │
│ Option 2: [EasyJet 14:00       ]   │
│ Price:    [€189] [EUR]              │
│                                     │
│ [+ Add Another] [Create All]        │
└─────────────────────────────────────┘
```

**Bulk Import:**
- Paste from spreadsheet (Tab-separated)
- CSV upload
- Copy from another trip's section

**Duplicate Section:**
- Copy a section from one trip to another
- Useful for similar trips (La Tania 2025 → Meribel 2025)

---

## Database Schema Changes

### Option 1: Minimal Changes (Recommended for Phase 1)

Add to `planning_sections`:
```sql
ALTER TABLE planning_sections ADD COLUMN display_mode TEXT DEFAULT 'list';
-- Values: 'list', 'grid', 'matrix'

ALTER TABLE planning_sections ADD COLUMN display_config JSONB DEFAULT '{}';
-- For grid: { rows: ["Level A", "Level B", ...], columns: ["Skis Only", "Skis+Boots", ...] }
```

Use existing `options.metadata` for grid positioning:
```json
{
  "grid_row": "Level A",
  "grid_column": "Skis+Boots"
}
```

### Option 2: Full Restructure (For Phase 2+)

New `section_templates` table:
```sql
CREATE TABLE section_templates (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  section_type section_type NOT NULL,
  config JSONB NOT NULL, -- Template structure
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

New `option_groups` table:
```sql
CREATE TABLE option_groups (
  id UUID PRIMARY KEY,
  section_id UUID REFERENCES planning_sections(id),
  name TEXT NOT NULL,
  order_index INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add to options:
ALTER TABLE options ADD COLUMN group_id UUID REFERENCES option_groups(id);
```

---

## UI Component Changes

### New Component: MatrixSelector

For ski rental, transfers, and other matrix-style selections:

```tsx
<MatrixSelector
  section={section}
  options={options}
  rows={["Level A", "Level B", "Level C", "Level D"]}
  columns={["Skis Only", "Skis+Boots", "Full Kit"]}
  currentSelection={userSelection}
  onSelect={(optionId) => handleSelect(optionId)}
  showAvatars={true}
/>
```

Features:
- Compact grid layout
- Cell shows price + mini avatars
- Hover shows full details
- Tap to select (mobile friendly)
- Highlight current selection

### New Component: SectionTemplate

Wizard-style creation for common section types:

```tsx
<SectionTemplateWizard
  tripId={tripId}
  template="ski-rental"
  onComplete={(section, options) => handleCreated(section, options)}
/>
```

Steps:
1. Choose template type
2. Fill in template-specific fields (e.g., rental shop, discount %)
3. Review generated options
4. Create all at once

### Enhanced: SelectionSummary

Already exists as sidebar; enhance with:
- Per-section completion status
- "Who hasn't selected" warnings
- Organizer-only detailed view

---

## Implementation Priority

### Must Have (Phase 1)
1. **Matrix/Grid display mode** for equipment sections
2. **Grid positioning metadata** for options
3. **MatrixSelector component** for compact selection UI

### Should Have (Phase 2)
4. **Section templates** for common ski trip needs
5. **Quick add multiple options** in admin
6. **Selection summary panel** for organizers

### Nice to Have (Phase 3)
7. **Duplicate section** between trips
8. **CSV/spreadsheet import**
9. **Real-time selection notifications**
10. **People-centric view** (see all of one person's selections)

---

## Migration Strategy

1. **Backward Compatible:** All changes are additive
   - `display_mode` defaults to 'list' (current behavior)
   - Existing sections continue to work

2. **Gradual Rollout:**
   - Build MatrixSelector component
   - Add display_mode to schema
   - Update one test section to use grid
   - Refine based on feedback

3. **Admin Opt-in:**
   - Organizers choose display_mode per section
   - Templates available but optional

---

## Mobile Considerations

- Matrix view must work on narrow screens (320px+)
- Consider horizontal scroll for wide matrices
- Or stack as cards on mobile with "tap to expand"
- Selection avatars must remain tap-friendly
- Quick preview on tap, full details on tap-and-hold

---

---

## Admin Ease-of-Use Improvements

### Current Pain Points
1. **One option at a time:** Must open modal, fill fields, save, repeat for each option
2. **No bulk creation:** Adding 13 ski rental options = 13 modal interactions
3. **No copy/paste:** Can't duplicate from spreadsheet or another trip
4. **No preview:** Can't see how options look until saved

### Solution: Quick Add Panel

Instead of modals, provide an inline "Quick Add" panel at the bottom of each section:

```
┌─────────────────────────────────────────────────────────┐
│ ➕ Quick Add Options                              [×]   │
├─────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Title: [Flight BA123 - 08:30 departure        ]     │ │
│ │ Price: [299.00] [EUR ▼]  Description: [Optional]    │ │
│ └─────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Title: [Flight EJ456 - 14:00 departure        ]     │ │
│ │ Price: [189.00] [EUR ▼]  Description: [Optional]    │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ [+ Add Another Row]                                     │
│                                                         │
│ [Cancel]                        [Create X Options]      │
└─────────────────────────────────────────────────────────┘
```

### Solution: Matrix Builder for Equipment

Special UI for creating equipment rental matrices:

```
┌─────────────────────────────────────────────────────────┐
│ 🎿 Ski Rental Matrix Builder                            │
├─────────────────────────────────────────────────────────┤
│ Levels (rows):                                          │
│ [A - Novice] [B - Intermediate] [C - High Level] [+]    │
│                                                         │
│ Packages (columns):                                     │
│ [Skis Only] [Skis + Boots] [Full Kit] [+]               │
│                                                         │
│ Base Prices (enter for Level A):                        │
│   Skis Only: [€68.40]                                   │
│   Skis + Boots: [€111.60]                               │
│   Full Kit: [€137.52]                                   │
│                                                         │
│ Price increment per level: [€30-40 approx]              │
│                                                         │
│ [Preview Matrix]  [Create 12 Options + "Not Renting"]   │
└─────────────────────────────────────────────────────────┘
```

### Solution: Section Templates with Smart Defaults

When creating a new section, offer pre-configured templates:

```
┌─────────────────────────────────────────────────────────┐
│ Create New Section                                      │
├─────────────────────────────────────────────────────────┤
│ ○ Blank Section (start from scratch)                    │
│                                                         │
│ ● Use Template:                                         │
│   ┌─────────────────────────────────────────────────┐  │
│   │ 🛫 Flights                                      │  │
│   │    Creates: Outbound + Return flight sections    │  │
│   │    Options: Flight 1, Flight 2, Drive, Self-arr  │  │
│   └─────────────────────────────────────────────────┘  │
│   ┌─────────────────────────────────────────────────┐  │
│   │ 🎿 Ski Rental Matrix                            │  │
│   │    Creates: Level × Package grid                 │  │
│   │    Options: Auto-generated from your prices      │  │
│   └─────────────────────────────────────────────────┘  │
│   ┌─────────────────────────────────────────────────┐  │
│   │ 🚐 Airport Transfers                            │  │
│   │    Creates: Shared/Private/Self-arrange          │  │
│   │    Auto-calculates split costs                   │  │
│   └─────────────────────────────────────────────────┘  │
│   ┌─────────────────────────────────────────────────┐  │
│   │ 🍽️ Restaurant Booking                          │  │
│   │    Creates: Multi-select dining options          │  │
│   │    Fields: Date, time, capacity                  │  │
│   └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## Z-Index & Layer Management

### Current Hierarchy (from tailwind.config.js)
```
z-toast:    1500  (notifications)
z-tooltip:  1400  (hover tips)
z-popover:  1300  (SelectionAvatars popover, dropdowns)
z-modal:    1200  (modals, dialogs)
z-sticky:   1100  (sticky headers)
z-dropdown: 1000  (dropdown menus)
```

### Known Issues to Fix
1. **Avatar emoji overflow:** Emoji/accessory can overflow avatar circle bounds
2. **Popover positioning:** Can clip at viewport edges on mobile
3. **Stacking context:** `transform` or `relative` on parent can break z-index

### Solutions for Prototype
1. **Avatar containment:** Add `overflow-hidden` to avatar container
2. **Portal rendering:** Use React Portal for all popovers (already done for SelectionAvatars)
3. **Fixed positioning:** Use `position: fixed` with viewport-aware placement
4. **Isolation:** Add `isolation: isolate` to section cards to contain stacking context

---

## Next Steps

1. Review this plan and prioritize features
2. Design mockups for MatrixSelector component
3. Plan database migration for display_mode
4. Build MatrixSelector prototype
5. Test with Meribel ski rental section
