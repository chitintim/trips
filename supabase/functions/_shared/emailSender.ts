/**
 * Pluggable EmailSender adapter (plan §14 "Email channel"). Brevo REST if
 * the BREVO_API_KEY secret is set (free tier, 300/day, verified single
 * sender); otherwise a null sender -- auto-chase then degrades gracefully by
 * logging notifications with channel='skipped' and surfacing WhatsApp-ready
 * drafts to the blockers board instead.
 */

export interface EmailMessage {
  toEmail: string
  toName?: string
  subject: string
  /** Plain-text body. */
  text: string
  /** Optional HTML body; falls back to text wrapped in <pre> if absent. */
  html?: string
}

export interface EmailSender {
  /** Human-readable channel name recorded in notifications.channel. */
  readonly channel: string
  readonly available: boolean
  send(message: EmailMessage): Promise<void>
}

class BrevoEmailSender implements EmailSender {
  readonly channel = 'email'
  readonly available = true
  #apiKey: string
  #senderEmail: string
  #senderName: string

  constructor(apiKey: string) {
    this.#apiKey = apiKey
    this.#senderEmail = Deno.env.get('BREVO_SENDER_EMAIL') ?? 'tim.chiutin.lam@gmail.com'
    this.#senderName = Deno.env.get('BREVO_SENDER_NAME') ?? 'Trips'
  }

  async send(message: EmailMessage): Promise<void> {
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
  }
}

class NullEmailSender implements EmailSender {
  readonly channel = 'skipped'
  readonly available = false
  send(_message: EmailMessage): Promise<void> {
    return Promise.resolve()
  }
}

export function getEmailSender(): EmailSender {
  const apiKey = Deno.env.get('BREVO_API_KEY')
  return apiKey ? new BrevoEmailSender(apiKey) : new NullEmailSender()
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
