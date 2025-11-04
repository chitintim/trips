# Tim's Super Trip Planner

A personal, invitation-only trip planning application for organizing ski trips with friends. Built with React, TypeScript, and Supabase.

## Features

- **Trip Management**: Create and manage multiple ski trips with public visibility options
- **Confirmation System**: Track participant commitments with conditional logic, waitlists, and capacity management
- **Collaboration**: Share planning decisions with team members
- **Planning Sections**: Organize accommodation, flights, transport, equipment, and more
- **Expense Tracking**: Multi-currency expenses with flexible splitting (even/custom/percentage), receipt uploads with HEIC conversion, and debt minimization
- **Balance Tracking**: See who owes what with optimized settlement suggestions
- **Notes & Announcements**: Markdown-supported communications for trip updates
- **Secure**: Row-level security ensures users only see authorized trips

## Tech Stack

- **Frontend**: React 18 + TypeScript + Vite
- **Styling**: Tailwind CSS
- **Backend**: Supabase (Auth, Database, Storage, Realtime)
- **Deployment**: GitHub Pages

## Getting Started

### Prerequisites

- Node.js 18+
- A Supabase account ([supabase.com](https://supabase.com))

### Installation

1. Clone the repository:
```bash
git clone https://github.com/chitintim/trips.git
cd trips
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
```

Edit `.env` and add your Supabase credentials:
```
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

4. Start the development server:
```bash
npm run dev
```

5. Open [http://localhost:5173](http://localhost:5173) in your browser.

## Project Structure

```
src/
├── components/      # React components
├── pages/          # Page components
├── lib/
│   └── supabase.ts # Supabase client
├── types/          # TypeScript types
├── hooks/          # Custom React hooks
│   └── useAuth.ts  # Authentication hook
├── App.tsx         # Main app component
└── main.tsx        # Entry point
```

## Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm run lint` - Run ESLint

## Database Schema

The app uses the following main tables:

- **users** - User profiles (extends auth.users) with custom avatar data
- **trips** - Trip information with confirmation settings, public visibility, and enhanced status workflow
- **trip_participants** - Links users to trips with roles and confirmation status tracking
- **planning_sections** - Trip planning categories (accommodation, flights, transport, etc.)
- **options** - Choices within planning sections with dynamic pricing
- **selections** - User selections and votes
- **comments** - Collaboration and discussion
- **expenses** - Trip expenses with multi-currency support, FX conversion, and receipt storage
- **expense_splits** - Flexible splitting (equal/custom/percentage)
- **settlements** - Payment tracking between users
- **invitations** - Secure invitation codes for signup with lifecycle tracking
- **trip_notes** - Notes and announcements for trips (Markdown supported)

## Current Status

**Phase 9 Complete ✅** - Confirmation System, Public Trips, Markdown Support, UI Polish!
**Phase 8 Complete ✅** - Enhanced Invitation System with Status Tracking!
**Phase 7 Complete ✅** - Full Expense Tracking with Multi-Currency & Receipt Uploads!
**Phase 5 Complete ✅** - Full Planning System with Optimistic Updates!
**Progress**: 99% overall (Core features complete, production ready)
**Next**: Testing & QA (Phase 10) or Real-time collaboration (Phase 6)

**What's Working:**
- ✅ **Complete authentication system** with invitation-based signup
  - Multi-step signup flow (invitation validation → account creation → welcome)
  - Email verification with automatic status tracking
  - Invitation lifecycle management (active→pending→completed)
  - Auto-fill invitation codes from URL
  - SECURITY DEFINER functions for RLS bypass
- ✅ Custom emoji avatar builder
- ✅ Admin dashboard (Trips, Users, Invitations management)
- ✅ **Full trip planning system** with sections, options, and selections
- ✅ **Dynamic pricing** (per-person, split, tiered)
- ✅ **Optimistic UI updates** - instant selections with zero scroll jumping
- ✅ **Expense tracking** with comprehensive features:
  - Multi-currency support (GBP, EUR, USD, CHF, JPY, AUD, CAD) with automatic FX conversion
  - Three split types: equal, custom amounts, percentage-based
  - Receipt uploads with HEIC/HEIF conversion and compression (70-80% reduction)
  - Balance tracking showing net positions
  - Debt minimization algorithm for optimal settlements
  - Category filtering (accommodation, transport, food, activities, equipment, other)
  - Admin delete capabilities
- ✅ **Trip Confirmation System** - Complete commitment tracking
  - 7 confirmation statuses (pending, confirmed, interested, conditional, waitlist, declined, cancelled)
  - Conditional confirmations (date-based, user-based, or either)
  - Automatic waitlist when capacity reached
  - Circular dependency detection
  - Effective deadline calculations
  - Commitment terms agreement
  - FIFO waitlist with timestamps
- ✅ **Public Trip Visibility** - Discovery for authenticated users
  - is_public toggle for trip organizers
  - Dashboard separation (My Trips vs Other Public Trips)
  - Greyed-out cards for non-participant trips
- ✅ **Markdown Support** - Rich text formatting
  - Confirmation messages with live preview
  - Trip notes and announcements
  - Bold, italic, lists, line breaks
- ✅ **Notes & Announcements** with filtering by category
- ✅ **Auto-redirect for single-trip users** with session tracking
- ✅ **Edit/delete** for sections, options, and expenses
- ✅ Selection avatars showing participant choices
- ✅ Mobile-optimized responsive design with tab structure (People → Planning → Expenses → Notes)
- ✅ **14 database tables** with comprehensive RLS policies
- ✅ **Supabase Storage** for receipt uploads (3MB limit, RLS protected)
- ✅ **10+ SECURITY DEFINER functions** for complex operations
- ✅ **Character limits** on all text fields for data protection
- ✅ GitHub Pages deployment: **https://chitintim.github.io/trips/**

## Authentication

Users sign up and log in with email and password. All features require authentication.

## Contributing

This is a personal project, but suggestions and feedback are welcome! Please open an issue to discuss proposed changes.

## License

MIT

## Author

**Tim** - Creator & Admin
[GitHub](https://github.com/chitintim)

**Note**: This is an invitation-only app. Contact Tim for access.
