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

class BrevoEmailSender implements EmailSender {
  readonly channel = 'email'
  readonly available = true
  #apiKey: string
  #senderEmail: string
  #senderName: string

  constructor(apiKey: string) {
    this.#apiKey = apiKey
    this.#senderEmail = Deno.env.get('BREVO_SENDER_EMAIL') ?? 'tim.chiutin.lam@gmail.com'
    this.#senderName = Deno.env.get('BREVO_SENDER_NAME') ?? "Tim's Trip Planner"
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
    // Tim's Resend account has mail.fontem.ai verified.
    this.#from = Deno.env.get('RESEND_FROM') ?? "Tim's Trip Planner <trips@mail.fontem.ai>"
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
