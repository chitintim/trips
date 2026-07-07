import { Route } from 'react-router-dom'
import { Login } from './Login'
import { Signup } from './Signup'
import { ForgotPassword } from './ForgotPassword'
import { ResetPassword } from './ResetPassword'
import { JoinTrip } from './JoinTrip'

/**
 * Auth routes, owned entirely by workstream C per the coordination rule
 * (auth pages + their routes are the one exception to "don't add routes in
 * App.tsx yourself"). The coordinator mounts these `<Route>` elements
 * directly inside the existing public `<Routes>` block in src/App.tsx,
 * replacing the legacy src/pages/{Login,Signup,ForgotPassword,ResetPassword}
 * routes with these.
 *
 * Usage at the integration site:
 *   import { authRoutes } from './features/auth/routes'
 *   <Routes>
 *     {authRoutes}
 *     ...
 *   </Routes>
 */
export const authRoutes = [
  <Route key="login" path="/login" element={<Login />} />,
  <Route key="signup" path="/signup" element={<Signup />} />,
  <Route key="forgot-password" path="/forgot-password" element={<ForgotPassword />} />,
  <Route key="reset-password" path="/reset-password" element={<ResetPassword />} />,
  // Public invite teaser (UX_REDESIGN Part 2 "Invite → join funnel"):
  // shows the trip BEFORE signup, then hands off to /signup?code=…
  <Route key="join" path="/join/:code" element={<JoinTrip />} />,
]
