/**
 * AdminInvitationAccountRequest/Response: contract for the
 * `admin-invitation-account` edge function. Site-admin-only mutations on the
 * account an invitation produced (Dashboard's Invitations tab): resend the
 * confirmation email, correct a typo'd email address, explicitly mark an
 * email confirmed (without sending anything -- needed precisely because the
 * resend path can fail on a bad address), or fix a display name.
 *
 * update_email and confirm_email are deliberately SEPARATE actions rather
 * than one action with an "also confirm" flag: changing the email never
 * silently confirms it, so the admin always makes that call explicitly.
 */
import { z } from 'npm:zod@3'
import { UuidSchema } from './common.ts'

export const AdminInvitationAccountActionSchema = z.enum([
  'resend_confirmation',
  'update_email',
  'confirm_email',
  'update_full_name',
])

export const AdminInvitationAccountRequestSchema = z
  .object({
    action: AdminInvitationAccountActionSchema,
    user_id: UuidSchema,
    email: z.string().email().max(320).optional(),
    full_name: z.string().trim().min(1).max(200).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.action === 'update_email' && !val.email) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'email is required for update_email', path: ['email'] })
    }
    if (val.action === 'update_full_name' && !val.full_name) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'full_name is required for update_full_name', path: ['full_name'] })
    }
  })

export const AdminInvitationAccountResponseSchema = z.object({
  success: z.literal(true),
  action: AdminInvitationAccountActionSchema,
  user_id: UuidSchema,
  email: z.string().optional(),
  email_confirmed_at: z.string().nullable().optional(),
  full_name: z.string().optional(),
})

export type AdminInvitationAccountAction = z.infer<typeof AdminInvitationAccountActionSchema>
export type AdminInvitationAccountRequest = z.infer<typeof AdminInvitationAccountRequestSchema>
export type AdminInvitationAccountResponse = z.infer<typeof AdminInvitationAccountResponseSchema>
