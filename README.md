# Tim's Super Trip Planner

A personal, invitation-only trip planning application for organizing ski trips with friends. Built with React, TypeScript, and Supabase.

## Features

- **Trip Management**: Create and manage multiple ski trips
- **Collaboration**: Real-time updates when team members make selections
- **Planning Sections**: Organize accommodation, flights, transport, equipment, and more
- **Expense Tracking**: Upload receipts with AI-powered parsing and split costs
- **Secure**: Row-level security ensures users only see their trips

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
- **trips** - Trip information and dates
- **trip_participants** - Links users to trips with roles (organizer/participant)
- **planning_sections** - Trip planning categories (accommodation, flights, transport, etc.)
- **options** - Choices within planning sections with dynamic pricing
- **selections** - User selections and votes
- **comments** - Collaboration and discussion
- **expenses** - Trip expenses with receipt storage
- **expense_splits** - Who owes what for each expense
- **invitations** - Secure invitation codes for signup
- **trip_notes** - Notes and announcements for trips

## Current Status

**Phase 5 Complete ✅** - Full Planning System with Optimistic Updates!
**Progress**: 90% overall (Core features complete)
**Next**: Real-time collaboration (Phase 6) or Expense tracking (Phase 7)

**What's Working:**
- ✅ Complete authentication system with invitation-based signup
- ✅ Custom emoji avatar builder
- ✅ Admin dashboard (Trips, Users, Invitations management)
- ✅ **Full trip planning system** with sections, options, and selections
- ✅ **Dynamic pricing** (per-person, split, tiered)
- ✅ **Optimistic UI updates** - instant selections with zero scroll jumping
- ✅ **Notes & Announcements** with filtering by category
- ✅ **Auto-redirect for single-trip users** with session tracking
- ✅ **Edit/delete** for sections and options
- ✅ Markdown support for option descriptions
- ✅ Selection avatars showing participant choices
- ✅ Mobile-optimized responsive design
- ✅ **12 database tables** with comprehensive RLS policies
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
