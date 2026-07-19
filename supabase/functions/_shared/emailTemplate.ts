/**
 * Shared branded email template for every outgoing "Tim's Trip Planner"
 * email (currently: the auto-chase digest, which bundles action-deadline
 * reminders and the other chase kinds into one email per user per day).
 *
 * Design constraints (email-client reality, not web reality):
 *  - single column, max-width 560px, table-free flexible divs except the
 *    actions table itself (a real <table> -- it IS tabular data);
 *  - all styles inline (many clients strip <style> blocks);
 *  - no images, no webfonts -- system font stack only;
 *  - one clear call-to-action button linking to the app.
 *
 * Keep this the ONLY place email chrome lives: any new outgoing email
 * should compose renderBrandedEmail() (or renderDigestEmail() for
 * digest-shaped content) rather than hand-rolling its own HTML.
 */

export const BRAND_NAME = "Tim's Trip Planner"

const COLORS = {
  ink: '#1c1917', // near-black text
  muted: '#78716c', // stone-500 secondary text
  border: '#e7e5e4', // stone-200 hairlines
  bg: '#f5f5f4', // stone-100 page background
  card: '#ffffff',
  brand: '#0f766e', // teal-700: header accent + button
  overdueBg: '#fee2e2',
  overdueText: '#b91c1c',
  dueSoonBg: '#fef3c7',
  dueSoonText: '#b45309',
  upcomingBg: '#e7e5e4',
  upcomingText: '#57534e',
}

export type StatusChipTone = 'overdue' | 'due-soon' | 'upcoming'

export interface DigestActionRow {
  title: string
  /** e.g. "Fri 1 Aug" or "Trip start (Sat 29 Aug)" */
  deadlineLabel: string
  /** e.g. "Overdue", "Due tomorrow", "Due in 6 days" */
  chipLabel: string
  chipTone: StatusChipTone
}

export interface DigestTripSection {
  tripName: string
  tripLink: string
  /** Deadline'd trip actions, rendered as a table. */
  actionRows: DigestActionRow[]
  /** Any other open loops (votes, RSVPs, settlements, ...), rendered as a list. */
  otherLines: Array<{ description: string; link: string }>
}

export interface DigestEmailInput {
  greetingName: string
  sections: DigestTripSection[]
  appUrl: string
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
  /**
   * Total actionable items (action rows + other lines) across the rendered
   * sections. Callers MUST NOT send the email when this is 0 -- an empty
   * "0 things need your attention" digest is noise, not a nudge.
   */
  itemCount: number
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function chipStyles(tone: StatusChipTone): { bg: string; fg: string } {
  if (tone === 'overdue') return { bg: COLORS.overdueBg, fg: COLORS.overdueText }
  if (tone === 'due-soon') return { bg: COLORS.dueSoonBg, fg: COLORS.dueSoonText }
  return { bg: COLORS.upcomingBg, fg: COLORS.upcomingText }
}

function renderChip(label: string, tone: StatusChipTone): string {
  const { bg, fg } = chipStyles(tone)
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${bg};color:${fg};font-size:12px;font-weight:600;white-space:nowrap;">${escapeHtml(label)}</span>`
}

function renderActionsTable(rows: DigestActionRow[]): string {
  const trs = rows
    .map(
      (r) => `
      <tr>
        <td style="padding:10px 12px 10px 0;border-bottom:1px solid ${COLORS.border};font-size:14px;color:${COLORS.ink};">${escapeHtml(r.title)}</td>
        <td style="padding:10px 12px 10px 0;border-bottom:1px solid ${COLORS.border};font-size:13px;color:${COLORS.muted};white-space:nowrap;">${escapeHtml(r.deadlineLabel)}</td>
        <td style="padding:10px 0;border-bottom:1px solid ${COLORS.border};text-align:right;">${renderChip(r.chipLabel, r.chipTone)}</td>
      </tr>`
    )
    .join('')
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:4px 0 8px;">
      <tr>
        <th align="left" style="padding:0 12px 6px 0;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${COLORS.muted};border-bottom:2px solid ${COLORS.border};">Action</th>
        <th align="left" style="padding:0 12px 6px 0;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${COLORS.muted};border-bottom:2px solid ${COLORS.border};">Deadline</th>
        <th align="right" style="padding:0 0 6px;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${COLORS.muted};border-bottom:2px solid ${COLORS.border};">Status</th>
      </tr>
      ${trs}
    </table>`
}

/**
 * Generic branded shell: header bar, white card with the given body HTML,
 * button, footer. `bodyHtml` is trusted template output -- escape any user
 * data BEFORE interpolating it into the fragments you pass in.
 */
export function renderBrandedEmail(opts: {
  bodyHtml: string
  ctaLabel: string
  ctaUrl: string
  footerLine: string
}): string {
  return `
  <div style="margin:0;padding:24px 12px;background:${COLORS.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="padding:14px 20px;background:${COLORS.brand};border-radius:12px 12px 0 0;">
        <span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:0.01em;">${escapeHtml(BRAND_NAME)}</span>
      </div>
      <div style="background:${COLORS.card};border:1px solid ${COLORS.border};border-top:none;border-radius:0 0 12px 12px;padding:24px 20px;">
        ${opts.bodyHtml}
        <div style="text-align:center;margin:24px 0 8px;">
          <a href="${escapeHtml(opts.ctaUrl)}" style="display:inline-block;background:${COLORS.brand};color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;">${escapeHtml(opts.ctaLabel)}</a>
        </div>
      </div>
      <div style="padding:16px 20px;text-align:center;">
        <p style="margin:0;font-size:12px;line-height:1.5;color:${COLORS.muted};">${escapeHtml(opts.footerLine)}<br>You can turn these emails off in your profile settings.</p>
      </div>
    </div>
  </div>`
}

/** Digest subject line: specific when it can be, honest when it can't. */
function digestSubject(input: DigestEmailInput): string {
  const sections = input.sections
  const totalActions = sections.reduce((n, s) => n + s.actionRows.length, 0)
  const totalOther = sections.reduce((n, s) => n + s.otherLines.length, 0)
  if (sections.length === 1) {
    const s = sections[0]
    if (totalOther === 0 && totalActions === 1) {
      return `${s.tripName}: "${s.actionRows[0].title}" is ${s.actionRows[0].chipLabel.toLowerCase()}`
    }
    return `${s.tripName}: ${totalActions + totalOther} ${totalActions + totalOther === 1 ? 'thing needs' : 'things need'} your attention`
  }
  return `${totalActions + totalOther} things waiting on you across your trips`
}

/**
 * The one digest email per user per day: per-trip sections with an actions
 * table (deadline'd trip actions) and a plain list for other open loops.
 */
export function renderDigestEmail(rawInput: DigestEmailInput): RenderedEmail {
  // Guard (a): a trip section with zero items must not render -- an empty
  // heading with a headers-only table tells the reader nothing. Guard (b)
  // lives in `itemCount` on the return value: when every section is empty
  // the whole email must not be SENT either (enforced by both the sweep
  // and test_digest paths in auto-chase).
  const input: DigestEmailInput = {
    ...rawInput,
    sections: rawInput.sections.filter((s) => s.actionRows.length + s.otherLines.length > 0),
  }
  const itemCount = input.sections.reduce((n, s) => n + s.actionRows.length + s.otherLines.length, 0)

  const sectionsHtml = input.sections
    .map((s) => {
      const others =
        s.otherLines.length > 0
          ? `<ul style="margin:4px 0 8px;padding-left:20px;">${s.otherLines
              .map(
                (l) =>
                  `<li style="margin:6px 0;font-size:14px;line-height:1.5;color:${COLORS.ink};">${escapeHtml(l.description)} <a href="${escapeHtml(l.link)}" style="color:${COLORS.brand};">Open</a></li>`
              )
              .join('')}</ul>`
          : ''
      return `
      <h2 style="margin:20px 0 8px;font-size:17px;color:${COLORS.ink};">${escapeHtml(s.tripName)}</h2>
      ${s.actionRows.length > 0 ? renderActionsTable(s.actionRows) : ''}
      ${others}`
    })
    .join('')

  const bodyHtml = `
    <p style="margin:0 0 4px;font-size:15px;color:${COLORS.ink};">Hi ${escapeHtml(input.greetingName)},</p>
    <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:${COLORS.muted};">A few things on your trips are waiting on you:</p>
    ${sectionsHtml}`

  const tripNames = input.sections.map((s) => s.tripName)
  const footerLine =
    tripNames.length === 1
      ? `You're receiving this because you're on the trip ${tripNames[0]}.`
      : `You're receiving this because you're on these trips: ${tripNames.join(', ')}.`

  const html = renderBrandedEmail({
    bodyHtml,
    ctaLabel: `Open ${BRAND_NAME}`,
    ctaUrl: input.appUrl,
    footerLine,
  })

  // Plain-text mirror for clients that prefer it.
  const textSections = input.sections
    .map((s) => {
      const actionLines = s.actionRows.map((r) => `  • ${r.title} — ${r.deadlineLabel} (${r.chipLabel})`)
      const otherLines = s.otherLines.map((l) => `  • ${l.description}\n    ${l.link}`)
      return `${s.tripName}\n${[...actionLines, ...otherLines].join('\n')}`
    })
    .join('\n\n')
  const text = `Hi ${input.greetingName},\n\nA few things on your trips are waiting on you:\n\n${textSections}\n\nOpen ${BRAND_NAME}: ${input.appUrl}\n\n${footerLine}\nYou can turn these emails off in your profile settings.`

  return { subject: digestSubject(input), html, text, itemCount }
}
