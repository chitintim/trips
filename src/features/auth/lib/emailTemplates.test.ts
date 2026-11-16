import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The app's login and invitation signup are code-entry flows (verifyOtp with
// type 'email'). Supabase only puts the code in the email if the template
// contains {{ .Token }}; a link in the same email can be prefetched by mail
// scanners, consuming the one-time token and invalidating the code.
const root = resolve(__dirname, '../../../../supabase')
const config = readFileSync(resolve(root, 'config.toml'), 'utf8')

describe.each(['magic_link', 'confirmation'])('%s email template', (name) => {
  const html = readFileSync(resolve(root, `templates/${name}.html`), 'utf8')

  it('shows the one-time code and no one-time link', () => {
    expect(html).toContain('{{ .Token }}')
    expect(html).not.toContain('ConfirmationURL')
    expect(html).not.toContain('TokenHash')
  })

  it('is wired up in config.toml with the code in the subject', () => {
    expect(config).toContain(`[auth.email.template.${name}]`)
    expect(config).toContain(`content_path = "./supabase/templates/${name}.html"`)
  })
})

it('keeps the email OTP length at the 6 digits the UI expects', () => {
  expect(config).toMatch(/^otp_length = 6$/m)
})
