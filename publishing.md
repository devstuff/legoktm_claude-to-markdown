# Persistent local installation

This document covers how to sign the extension using Mozilla's Add-on signing
service and install it permanently in Firefox. The signed `.xpi` file survives
browser restarts without requiring Firefox Developer Edition or any `about:config`
changes.

The approach used here is an **unlisted** self-distribution signing. Mozilla
signs the extension so Firefox accepts it, but it is never publicly listed or
searchable on addons.mozilla.org (AMO). This is the correct path for a personal
or patched build.

> **Why the manifest changes matter:** The upstream extension has a specific
> gecko add-on ID (`{518f7e4f-a2c6-4587-af34-e06f3dbbf523}`) registered against
> the original author's AMO account. Signing a build with that same ID under a
> different account would create a conflict — Mozilla's signing API ties IDs to
> accounts. The `personal` branch therefore uses a distinct gecko ID, version,
> and `homepage_url` so the two builds are independent and can coexist without
> interfering with each other or with the upstream author's AMO listing.

## Manifest changes in this branch

The following fields in `manifest.json` differ from the upstream `fix-blank-popup`
branch:

| Field | Upstream value | This branch |
| :--- | :--- | :--- |
| `version` | `2025.3.11` | `2026.03.25` |
| `homepage_url` | `https://legoktm.com/view/Claude_to_Markdown` | `https://github.com/devstuff/legoktm_claude-to-markdown` |
| `browser_specific_settings.gecko.id` | `{518f7e4f-a2c6-4587-af34-e06f3dbbf523}` | `{4731b079-b110-40bf-8767-f29694be51e8}` |

## Prerequisites

- macOS with Node.js installed (`node --version` ≥ 18 recommended)
- `npm` (bundled with Node.js)
- `jq` (`brew install jq` if not already present)

## Step 1 — Create a Mozilla account

1. Go to <https://addons.mozilla.org> and click **Register or Log in**.
2. Create an account with your email address and confirm it.

This is the same account used to access the AMO Developer Hub. No extension
needs to be submitted publicly; the account is only needed to generate API
credentials.

## Step 2 — Generate API credentials

1. Log in and go to <https://addons.mozilla.org/en-US/developers/addon/api/key/>.
2. Click **Generate new credentials**.
3. You will receive two values — keep them private and treat them like passwords:
   - **JWT issuer** — looks like `user:12345:67`
   - **JWT secret** — a long hex string

These credentials are used to authenticate `web-ext` against Mozilla's signing
API. They do not expire but can be regenerated at any time from the same page.

Store them as environment variables in your shell profile (e.g. `~/.zshrc`):

```sh
export WEB_EXT_API_KEY="user:12345:67"
export WEB_EXT_API_SECRET="634f34bee43611d2f3c0fd8c06220ac780cff681a578092001183ab62c04e009"
```

Reload your shell (`source ~/.zshrc`) before proceeding.

## Step 3 — Install web-ext

`web-ext` is Mozilla's official command-line tool for building and signing
extensions.

```bash
npm install -g web-ext
web-ext --version   # verify install
```

## Step 4 — Clone the personal branch and build

```bash
git clone --branch personal https://github.com/devstuff/legoktm_claude-to-markdown.git
cd legoktm_claude-to-markdown
bash build.sh
```

`build.sh` produces a zip file one level up from the repo, named after the
version in `manifest.json`, e.g. `../claude-to-markdown-2026.03.25.zip`.

## Step 5 — Sign the extension

Run `web-ext sign` from inside the repo directory. With the environment variables
set in Step 2, no credentials need to be passed on the command line. The
`--channel=unlisted` flag signs the extension for self-distribution only —
nothing is published publicly.

```bash
web-ext sign --channel=unlisted
```

`web-ext` packages the source directory automatically, submits it to Mozilla's
API, waits for automated validation to pass (typically under a minute), and
downloads the signed file. The output will look like:

```
Your extension was validated and should be available for download:
web-ext-artifacts/claude_to_markdown-2026.03.25-an+fx.xpi
```

The `.xpi` file in `web-ext-artifacts/` is your signed, installable extension.

## Step 6 — Install permanently in Firefox

1. Open Firefox and navigate to `about:addons`.
2. Click the gear icon ⚙ → **Install Add-on From File…**.
3. Select the `.xpi` file from `web-ext-artifacts/`.
4. Click **Add** when prompted.

The extension is now permanently installed and will persist across Firefox
restarts. It appears in `about:addons` like any other extension and can be
enabled, disabled, or removed from there.

## Updating after future changes

When you pull new changes and need to reinstall:

1. Pull the latest changes: `git pull`
2. Re-run `web-ext sign --channel=unlisted` — Mozilla recognises the gecko ID
   and signs a new version automatically.
3. Reinstall the new `.xpi` via `about:addons` → gear → **Install Add-on From
   File…**. Firefox replaces the previous version.

If the upstream PR is eventually merged and a new version is released on AMO,
uninstall the self-signed build and reinstall the official version from
<https://addons.mozilla.org/en-US/firefox/addon/claude-to-markdown/>.
