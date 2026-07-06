/**
 * Route config for the rebuilt claim experience (plan §10 #4). The
 * coordinator wires this into src/App.tsx in place of the legacy
 * `/claim/:code` -> ClaimItemsPage route (left untouched per the
 * coordination contract). Same path so every existing shared link keeps
 * working unchanged.
 */
import type { RouteObject } from 'react-router-dom'
import { ClaimPage } from './claims/ClaimPage'

export const expenseRoutes: RouteObject[] = [
  {
    path: '/claim/:code',
    element: <ClaimPage />,
  },
]
