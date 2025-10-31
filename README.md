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

## Documentation

- **[QUICK_START.md](./QUICK_START.md)** - Quick reference for developers and Claude Code
- **[CLAUDE.md](./CLAUDE.md)** - Complete technical specification
- **[PROJECT_PLAN.md](./PROJECT_PLAN.md)** - Detailed 11-phase development plan
- **[PROGRESS.md](./PROGRESS.md)** - Current implementation status and progress tracking
- **[ROADMAP.md](./.github/ROADMAP.md)** - Release timeline and future features

## Database Schema

The app uses the following main tables:

- **users** - User profiles (extends Supabase auth.users)
- **trips** - Trip information
- **trip_participants** - Links users to trips with roles

See [CLAUDE.md](./CLAUDE.md) for the complete database schema and RLS policies.

## Current Status

**Phase 3 Complete ✅** - Authentication System Ready!
**Progress**: 60% overall (Phases 1-3 complete)
**Next**: Build trip management features (Phase 4)

**What's Working:**
- ✅ Complete authentication system (login, signup, password reset)
- ✅ Invitation-based signup with custom avatar builder
- ✅ 14 UI components with Winter Clean theme
- ✅ 10 database tables with 46 RLS policies
- ✅ Protected routes and dashboard
- ✅ Welcome screen with animations

See [PROGRESS.md](./PROGRESS.md) for detailed status.

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
