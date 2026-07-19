/**
 * Pluggable EmailSender adapter (plan §14 "Email channel"). Brevo REST if
 * the BREVO_API_KEY secret is set (free tier, 300/day, verified single
 * sender); otherwise a null sender -- auto-chase then degrades gracefully by
 * logging notifications with channel='skipped' and surfacing WhatsApp-ready
 * drafts to the blockers board instead.
 */

import { BRAND_NAME } from './emailTemplate.ts'

export interface EmailMessage {
  toEmail: string
  toName?: string
  subject: string
  /** Plain-text body. */
  text: string
  /** Optional HTML body; falls back to text wrapped in <pre> if absent. */
  html?: string
}

/** Provider acknowledgement returned by send() -- proves the API accepted the message. */
export interface EmailSendReceipt {
  provider: string
  /** Provider-assigned message id, when the API returns one. */
  providerMessageId: string | null
}

export interface EmailSender {
  /** Human-readable channel name recorded in notifications.channel. */
  readonly channel: string
  readonly available: boolean
  send(message: EmailMessage): Promise<EmailSendReceipt>
}

/**
 * Sender display name is a PRODUCT decision, enforced here in code: every
 * outgoing email shows BRAND_NAME ("Tim's Trip Planner") regardless of what
 * the RESEND_FROM / BREVO_SENDER_NAME secrets say -- a stale secret set
 * before the branding landed was silently overriding the name (verified in
 * the inbox on 2026-07-19: delivered From carried no "Tim's Trip Planner").
 * Env secrets still control the ADDRESS (it must stay domain-verified with
 * the provider); only the display name is pinned.
 *
 * Accepts a raw env value of either `Some Name <addr@host>` or `addr@host`,
 * extracts the address, and re-wraps it with the brand name.
 */
export function brandedFrom(envValue: string | undefined, fallbackAddress: string): { name: string; address: string; from: string } {
  let address = fallbackAddress
  if (envValue) {
    const bracketed = envValue.match(/<([^<>\s]+@[^<>\s]+)>/)
    if (bracketed) {
      address = bracketed[1]
    } else if (/^[^<>\s]+@[^<>\s]+$/.test(envValue.trim())) {
      address = envValue.trim()
    }
    // Anything unparseable falls back to the known-verified default address.
  }
  return { name: BRAND_NAME, address, from: `${BRAND_NAME} <${address}>` }
}

class BrevoEmailSender implements EmailSender {
  readonly channel = 'email'
  readonly available = true
  #apiKey: string
  #senderEmail: string
  #senderName: string

  constructor(apiKey: string) {
    this.#apiKey = apiKey
    // Address from env (must match the Brevo-verified sender); name pinned
    // to the brand -- see brandedFrom() for why the env name is ignored.
    const branded = brandedFrom(Deno.env.get('BREVO_SENDER_EMAIL'), 'tim.chiutin.lam@gmail.com')
    this.#senderEmail = branded.address
    this.#senderName = branded.name
  }

  async send(message: EmailMessage): Promise<EmailSendReceipt> {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': this.#apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: this.#senderEmail, name: this.#senderName },
        to: [{ email: message.toEmail, ...(message.toName ? { name: message.toName } : {}) }],
        subject: message.subject,
        textContent: message.text,
        htmlContent: message.html ?? `<pre style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(message.text)}</pre>`,
      }),
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Brevo send failed (${response.status}): ${body}`)
    }
    const body = (await response.json().catch(() => ({}))) as { messageId?: string }
    return { provider: 'brevo', providerMessageId: body.messageId ?? null }
  }
}

class ResendEmailSender implements EmailSender {
  readonly channel = 'email'
  readonly available = true
  #apiKey: string
  #from: string

  constructor(apiKey: string) {
    this.#apiKey = apiKey
    // Tim's Resend account has mail.fontem.ai verified: RESEND_FROM may
    // override the ADDRESS, but the display name is always the brand
    // (a pre-branding RESEND_FROM secret was stripping the name).
    this.#from = brandedFrom(Deno.env.get('RESEND_FROM'), 'trips@mail.fontem.ai').from
  }

  async send(message: EmailMessage): Promise<EmailSendReceipt> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.#from,
        to: [message.toName ? `${message.toName} <${message.toEmail}>` : message.toEmail],
        subject: message.subject,
        text: message.text,
        html: message.html ?? `<pre style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(message.text)}</pre>`,
      }),
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Resend send failed (${response.status}): ${body}`)
    }
    const body = (await response.json().catch(() => ({}))) as { id?: string }
    return { provider: 'resend', providerMessageId: body.id ?? null }
  }
}

class NullEmailSender implements EmailSender {
  readonly channel = 'skipped'
  readonly available = false
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature required by EmailSender interface
  send(_message: EmailMessage): Promise<EmailSendReceipt> {
    return Promise.resolve({ provider: 'none', providerMessageId: null })
  }
}

export function getEmailSender(): EmailSender {
  // Resend preferred (Tim's verified mail.fontem.ai domain), Brevo kept as a
  // secondary option, else the null sender (auto-chase degrades to drafts).
  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (resendKey) return new ResendEmailSender(resendKey)
  const brevoKey = Deno.env.get('BREVO_API_KEY')
  return brevoKey ? new BrevoEmailSender(brevoKey) : new NullEmailSender()
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
