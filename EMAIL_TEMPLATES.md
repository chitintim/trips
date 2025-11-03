# Supabase Email Template Customization

## How to Update Email Templates

1. Go to your Supabase Dashboard: https://supabase.com/dashboard
2. Select your project
3. Navigate to: **Authentication** → **Email Templates**
4. Edit each template below

---

## 1. Confirm Signup (Email Verification)

**Subject:**
```
Confirm your email for Tim's Super Trip Planner
```

**Message Body (HTML):**
```html
<h2>Welcome to Tim's Super Trip Planner! 🎿</h2>

<p>Thanks for signing up! Please confirm your email address by clicking the link below:</p>

<p><a href="{{ .ConfirmationURL }}" style="display: inline-block; padding: 12px 24px; background-color: #0ea5e9; color: white; text-decoration: none; border-radius: 6px; font-weight: 600;">Confirm Email Address</a></p>

<p>Or copy and paste this link into your browser:</p>
<p style="color: #6b7280; font-size: 14px;">{{ .ConfirmationURL }}</p>

<p style="margin-top: 30px; color: #6b7280; font-size: 14px;">
  If you didn't create an account with Tim's Super Trip Planner, you can safely ignore this email.
</p>

<p style="margin-top: 20px; color: #9ca3af; font-size: 12px;">
  This link will expire in 24 hours.
</p>
```

---

## 2. Reset Password

**Subject:**
```
Reset your password for Tim's Super Trip Planner
```

**Message Body (HTML):**
```html
<h2>Reset Your Password 🔑</h2>

<p>We received a request to reset your password for Tim's Super Trip Planner.</p>

<p>Click the link below to create a new password:</p>

<p><a href="{{ .ConfirmationURL }}" style="display: inline-block; padding: 12px 24px; background-color: #0ea5e9; color: white; text-decoration: none; border-radius: 6px; font-weight: 600;">Reset Password</a></p>

<p>Or copy and paste this link into your browser:</p>
<p style="color: #6b7280; font-size: 14px;">{{ .ConfirmationURL }}</p>

<p style="margin-top: 30px; color: #6b7280; font-size: 14px;">
  If you didn't request a password reset, you can safely ignore this email. Your password will not be changed.
</p>

<p style="margin-top: 20px; color: #9ca3af; font-size: 12px;">
  This link will expire in 1 hour for security reasons.
</p>
```

---

## 3. Magic Link (if you use passwordless login)

**Subject:**
```
Your login link for Tim's Super Trip Planner
```

**Message Body (HTML):**
```html
<h2>Sign in to Tim's Super Trip Planner 🎿</h2>

<p>Click the link below to sign in:</p>

<p><a href="{{ .ConfirmationURL }}" style="display: inline-block; padding: 12px 24px; background-color: #0ea5e9; color: white; text-decoration: none; border-radius: 6px; font-weight: 600;">Sign In</a></p>

<p>Or copy and paste this link into your browser:</p>
<p style="color: #6b7280; font-size: 14px;">{{ .ConfirmationURL }}</p>

<p style="margin-top: 30px; color: #6b7280; font-size: 14px;">
  If you didn't request this login link, you can safely ignore this email.
</p>

<p style="margin-top: 20px; color: #9ca3af; font-size: 12px;">
  This link will expire in 1 hour.
</p>
```

---

## 4. Change Email Address

**Subject:**
```
Confirm your new email for Tim's Super Trip Planner
```

**Message Body (HTML):**
```html
<h2>Confirm Your New Email Address 📧</h2>

<p>You recently changed your email address for Tim's Super Trip Planner. Please confirm your new email by clicking the link below:</p>

<p><a href="{{ .ConfirmationURL }}" style="display: inline-block; padding: 12px 24px; background-color: #0ea5e9; color: white; text-decoration: none; border-radius: 6px; font-weight: 600;">Confirm New Email</a></p>

<p>Or copy and paste this link into your browser:</p>
<p style="color: #6b7280; font-size: 14px;">{{ .ConfirmationURL }}</p>

<p style="margin-top: 30px; color: #6b7280; font-size: 14px;">
  If you didn't request this change, please contact support immediately.
</p>

<p style="margin-top: 20px; color: #9ca3af; font-size: 12px;">
  This link will expire in 24 hours.
</p>
```

---

## Additional Customization Options

### Site URL Configuration
Make sure your Site URL is set correctly in **Authentication** → **URL Configuration**:
- **Site URL**: `https://chitintim.github.io/trips/`
- **Redirect URLs**: Add `https://chitintim.github.io/trips/**` to allow all paths

### Email Settings
In **Project Settings** → **Authentication**:
- **Sender Name**: `Tim's Super Trip Planner` (or just `Tim`)
- **Sender Email**: Uses Supabase's email by default, or configure custom SMTP

### Testing
After updating templates:
1. Test signup flow
2. Test password reset
3. Check spam folder if emails don't arrive
4. Verify links redirect correctly to your app

---

## Variables Available in Templates

Supabase provides these variables:
- `{{ .ConfirmationURL }}` - The action link (confirmation/reset)
- `{{ .Token }}` - The verification token
- `{{ .TokenHash }}` - Hashed token
- `{{ .SiteURL }}` - Your app's site URL
- `{{ .Email }}` - User's email address

---

## Notes

- Keep the `{{ .ConfirmationURL }}` variable intact - this is the actual link
- The button styling uses inline CSS for email client compatibility
- Test emails after updating to ensure they look good
- Consider adding a footer with your contact info or unsubscribe links if needed
