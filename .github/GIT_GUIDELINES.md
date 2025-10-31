# Git Guidelines

## What's in the Repository ✅

### Source Code
- All TypeScript/JavaScript files (`src/**`)
- Configuration files (tsconfig, vite, tailwind, etc.)
- HTML entry point (`index.html`)
- Public assets (`public/**`)

### Documentation
- `README.md` - Public project overview
- `.github/ROADMAP.md` - Release roadmap
- `.github/GIT_GUIDELINES.md` - This file

### Configuration
- `package.json` - Dependencies and scripts
- `package-lock.json` - Locked dependency versions
- `.env.example` - Environment variable template (no secrets!)
- `.gitignore` - Ignore rules
- ESLint, Tailwind, PostCSS configs

---

## What's NOT in the Repository ❌

### Secrets and Credentials (NEVER COMMIT!)
- `.env` - Your actual environment variables
- `.env.local`, `.env.*.local` - Local environment overrides
- `*.key`, `*.pem` - Private keys
- `credentials.json` - Service account credentials
- Any files containing:
  - API keys
  - Database passwords
  - Access tokens
  - Supabase service role key

### Build Artifacts
- `dist/` - Production build output
- `build/` - Alternative build output
- `.vite/` - Vite cache
- `*.tsbuildinfo` - TypeScript build info

### Dependencies
- `node_modules/` - All npm packages (install via `npm install`)

### IDE/Editor Files
- `.vscode/` - VS Code settings (personal preferences)
- `.idea/` - JetBrains IDE settings
- `*.swp`, `*.swo` - Vim swap files
- `.vim/` - Vim configuration
- `*.sublime-*` - Sublime Text files

### OS Files
- `.DS_Store` - macOS folder metadata
- `Thumbs.db` - Windows thumbnail cache
- `Desktop.ini` - Windows folder settings

### Testing & Coverage
- `coverage/` - Test coverage reports
- `test-results/` - Test output
- `playwright-report/` - Playwright test results

### Logs
- `*.log` - All log files
- `npm-debug.log*` - npm debug logs
- `yarn-debug.log*`, `yarn-error.log*` - Yarn logs

### Temporary Files
- `*.tmp`, `*.temp` - Temporary files
- `.cache/` - Cache directories
- `uploads/`, `receipts/`, `temp-uploads/` - Local test uploads

### Internal/Working Documentation (Kept Local)
- `CLAUDE.md` - Detailed technical specification (work in progress)
- `PROGRESS.md` - Granular progress tracking
- `PROJECT_PLAN.md` - Detailed 11-phase development plan
- `QUICK_START.md` - Developer quick reference

**Why kept local**: These are detailed working documents that change frequently and contain implementation details. The public `README.md` and `ROADMAP.md` provide sufficient project information.

### Claude Code
- `.claude/` - Claude Code state and history
- `.claude.json` - Claude Code configuration

### Supabase Local Development
- `supabase/.branches` - Local branch data
- `supabase/.temp` - Temporary Supabase files
- `.supabase/` - Local Supabase state

---

## Why This Matters

### Security
- **Never commit secrets**: Anyone with repo access can see the entire git history
- **Use environment variables**: Store secrets in `.env` (which is gitignored)
- **Check before commit**: Run `git status` to see what you're about to commit
- **If you accidentally commit a secret**:
  1. Immediately rotate/revoke the secret
  2. Use `git filter-branch` or BFG Repo-Cleaner to remove from history
  3. Force push (breaks collaborators' clones)

### Collaboration
- **Don't commit IDE settings**: Different developers use different editors
- **Don't commit OS files**: Your Mac's `.DS_Store` is useless on Linux
- **Don't commit dependencies**: Others run `npm install` to get them
- **Don't commit build artifacts**: Generated locally or in CI/CD

### Performance
- **Keep repo small**: Don't commit large binary files or generated code
- **Clone faster**: Less data = faster clones
- **Faster operations**: Git operations are faster on smaller repos

---

## Safe for Public GitHub

Since this will be hosted on GitHub Pages, the repository is public. These are **safe** to include:

✅ **All source code** - No secrets in code
✅ **Documentation** - Helps others understand the project
✅ **Configuration files** - Shows how to set up the project
✅ **Supabase project URL** - Public, used in frontend
✅ **Supabase anon key** - Public, safe to expose (protected by RLS)

These are **NOT safe** and must be excluded:

❌ **Supabase service role key** - Has admin access, bypasses RLS
❌ **Anthropic API key** - Would cost you money if others use it
❌ **Personal access tokens** - Give access to your accounts
❌ **`.env` file** - Contains your actual secrets

---

## Pre-Commit Checklist

Before every commit, verify:

- [ ] No `.env` files (only `.env.example` is okay)
- [ ] No API keys or tokens in code
- [ ] No `console.log()` with sensitive data
- [ ] No commented-out code with secrets
- [ ] No personal notes or TODOs with private info
- [ ] Run `git status` to see what's being committed
- [ ] Run `git diff --cached` to review changes

---

## Common Mistakes to Avoid

### ❌ DON'T DO THIS
```bash
# Don't commit .env
git add .env

# Don't force add ignored files
git add -f .env

# Don't disable .gitignore
git add --no-ignore .env

# Don't commit with secrets in code
git commit -m "Add API key: sk-12345..."
```

### ✅ DO THIS INSTEAD
```bash
# Always check what you're committing
git status
git diff

# Only add specific files
git add src/
git add README.md

# Or add everything (but .gitignore protects you)
git add .

# Review before committing
git status

# Commit with meaningful message
git commit -m "Add trip creation feature"
```

---

## Emergency: I Committed a Secret!

If you accidentally commit a secret:

### 1. Immediate Action (within minutes)
```bash
# If you haven't pushed yet
git reset --soft HEAD~1  # Undo the commit, keep changes
# Edit files to remove secret
git add .
git commit -m "Fix configuration"

# If you just pushed
git reset --hard HEAD~1  # Remove the commit
git push --force origin main  # Force push (dangerous!)
```

### 2. Rotate the Secret
- **Supabase**: Generate new service role key in dashboard
- **Anthropic**: Revoke and create new API key
- **Database**: Change password
- **Any token**: Invalidate and generate new one

### 3. Clean Git History (for older commits)
```bash
# Use BFG Repo-Cleaner (easier than git filter-branch)
# https://rtyley.github.io/bfg-repo-cleaner/

# Remove file from all history
bfg --delete-files .env
bfg --delete-files credentials.json

# Or remove text patterns
bfg --replace-text passwords.txt
```

### 4. Force Push and Warn Collaborators
```bash
git push --force-with-lease origin main
```

⚠️ **Warning**: Force pushing rewrites history. All collaborators must re-clone.

---

## Viewing What's Ignored

```bash
# See all ignored files
git status --ignored

# Check if a specific file is ignored
git check-ignore -v .env

# See what .gitignore rules apply
git check-ignore -v node_modules/
```

---

## Best Practices

1. **Review `.gitignore` regularly** - Add new patterns as needed
2. **Use `.env.example`** - Show others what variables are needed
3. **Document secrets in README** - Tell others where to get credentials
4. **Use git hooks** - Pre-commit hooks can catch secrets
5. **Enable GitHub secret scanning** - GitHub can detect committed secrets
6. **Regular security audits** - Review commits for accidentally exposed data

---

## Resources

- [GitHub's .gitignore templates](https://github.com/github/gitignore)
- [Git documentation](https://git-scm.com/doc)
- [BFG Repo-Cleaner](https://rtyley.github.io/bfg-repo-cleaner/)
- [How to remove sensitive data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
