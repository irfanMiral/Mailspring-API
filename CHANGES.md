# Fork Changes

This file tracks what this fork changes relative to
[1RandomDev/mailspring-api](https://github.com/1RandomDev/mailspring-api),
which had been unmaintained since 2023.

## Bug fixes

- **`manage.js` (the user-management CLI) never ran.** `package.json` declares
  `"type": "module"`, but `manage.js` used CommonJS `require()`. Every
  invocation — including `./manage.js user add`, the very first command the
  README tells a new user to run — crashed immediately with
  `ReferenceError: require is not defined in ES module scope`. Converted the
  file to ES module `import` syntax to match the rest of the codebase.
- **`manage.js` didn't create the `./data` directory.** `index.js` already
  does this (`fs.mkdirSync('./data')` if missing), but `manage.js` didn't, so
  running the CLI before the server's first start (again, exactly what the
  README's host-install instructions do) failed with `Cannot open database
  because the directory does not exist`.
- **`manage.js user delete` referenced a nonexistent table.** It deleted from
  `shares_assets`, but the table is `shared_assets` (see the `CREATE TABLE`
  in both `index.js` and `manage.js`). Deleting a user would throw partway
  through the transaction.
- **`better-sqlite3@^8.1.0` fails to compile on current Node.** Its native
  bindings use a V8 API removed in newer V8/Node releases, so `npm install`
  fails outright. Since the `Dockerfile` floated `FROM node:lts-alpine`
  (no pinned version), a fresh `docker build` of this image would hit this
  today. Bumped to `^13.0.3`, which ships prebuilt binaries for current Node,
  and pinned the Dockerfile's base image so this doesn't silently break again
  on the next Node LTS bump. Also added a build toolchain (`python3 make g++`)
  to the image as a fallback for platforms without a matching prebuilt binary.
- **`resolve-dav-hosts` forwarded every request to `id.getmailspring.com`.**
  A "self-hosted" server still depended on Foundry376's infrastructure for
  CalDAV/CardDAV account discovery. Replaced the passthrough with real RFC
  6764 DNS SRV lookups (`_caldavs._tcp.<domain>`, `_carddavs._tcp.<domain>`),
  falling back to the account's IMAP host and then the bare domain as
  candidate hosts. Verified end-to-end against `gmail.com`, which correctly
  resolves `calendar.google.com` via its real SRV record.
- **Dependency vulnerabilities**: bumped `@iamtraction/google-translate` to
  `3.0.0`, resolving several `undici` advisories (including a couple of high
  severity ones) pulled in transitively.

- **`manage.js` writes could collide with a running server.** Neither
  `index.js` nor `manage.js` enabled SQLite's WAL journal mode, so opening the
  database file from two processes at once (the running server plus a
  `manage.js user add`/`delete`/`changepw` invocation) could fail with
  `SQLITE_BUSY`/"database is locked" instead of just working. Both now set
  `journal_mode = WAL` and a 5s `busy_timeout`. Verified by running the server
  and successfully creating three users via `manage.js` while it stayed up.

## New endpoints

The Mailspring client gained these since this project's last update in 2023;
implementing them closes real gaps where the client would 404/error against
this server:

- **`POST /api/grammar/check`** — the composer's grammar-check feature always
  calls this and previously got a 404. Implemented as a proxy to a
  [LanguageTool](https://languagetool.org/)-compatible server (configurable
  via `LANGUAGETOOL_URL`, defaulting to the public LanguageTool API), matching
  the exact response shape the client expects. Verified against a live
  request ("He go to school yesterday." correctly flagged with a
  subject-verb agreement suggestion).
- **`POST /api/login-link`** — used to build "open in browser" links. This
  server has no separate SSO/billing portal, so it's implemented as a no-op
  that just echoes back the requested path.
- **`GET /dashboard`** — the client's "Account Details" and "Manage Billing"
  buttons in Preferences open this URL (via `/api/login-link`), and it
  previously just redirected to the static landing page with nothing to
  actually manage. It's now a real cookie-authenticated account page:
  account info, a change-password form (re-verifies the current password,
  signs out every other session on success), and a list of active sessions
  with per-session revoke. Backed by `POST /dashboard/change-password`,
  `POST /dashboard/sessions/revoke`, and `POST /dashboard/logout` — these
  intentionally sit outside `/api/*` so they use the browser's cookie
  session rather than the bearer-token auth the client's own API calls use.
  Verified end-to-end: login, wrong-password rejection, successful change
  invalidating the old password, and revoking a second session from the
  first session's dashboard.
- **`GET /robots.txt`** and a global `X-Robots-Tag: noindex, nofollow`
  header, plus matching `<meta name="robots">` tags on every HTML page — see
  below.

## Not implemented (by design)

- **`GET /api/info-for-email-v2/:email`** (rich contact profiles) — the
  client already handles this endpoint being unavailable gracefully (catches
  the failure and falls back to an empty result), and this was already an
  acknowledged gap in the original project's README.
- **Calendar/CalDAV sync itself** — confirmed this does not depend on
  `mailspring-api` at all. The client's Mailsync engine talks directly to the
  mail provider's own CalDAV/CardDAV server using the account's existing
  credentials, the same way it does for IMAP/SMTP; `resolve-dav-hosts` above
  is the only calendar-related call this server ever sees, and it's just a
  discovery hint.

## Privacy

Blocks search engine indexing of this instance: a `robots.txt` disallowing
everything, a `X-Robots-Tag: noindex, nofollow` header on every response, and
a matching `<meta name="robots">` tag on every HTML page (including the
thread-sharing page, which is served on a distinct domain from the rest of
the API on purpose — see `SHARE_URL` — but still shouldn't be indexed). This
server exists to sync a private mailbox; there's no reason for it to be
crawled or show up in search results.
