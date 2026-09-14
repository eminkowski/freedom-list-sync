# freedom-list-sync

A small CLI for syncing external domain lists into Freedom blocklists. It supports
hosts files, plain domain lists, CSV, and JSON, and shards large lists across
numbered Freedom lists when one list would get too big.

I built this after running into Freedom’s 50-site bulk-add workflow and the
practical limits of very large custom blocklists.

Pass any `--source` URL (or `--source-file`) in a supported format, and any
`--list` base name as the Freedom target. Unknown formats fail instead of being
guessed — Adblock, Excel, and odd JSON shapes are out of scope for now. The
parser cares about content shape, not the file extension.

## Status

| Capability | Status |
| --- | --- |
| Authenticated Freedom reads | Supported |
| Remote source parsing | Supported |
| Diffing | Supported |
| Dry-run sync | Supported |
| HTTP additive writes | Supported |
| Sharded logical targets | Supported |
| Automatic new-list creation | Supported (`POST /filter_lists/` `{ name }`) |
| Checkpoint/resume | Supported |
| Mirror/removal sync | Not yet supported |

## Design notes

- Unknown or ambiguous sources fail; only hosts, domains, CSV, and simple JSON are accepted
- Sync is additive only — domains can be added, not removed
- Large sources are split across `Base`, `Base 2`, `Base 3`, … with a conservative default shard size (not an official Freedom maximum)
- Missing shards are created with `POST /filter_lists/` during live sync
- Login is browser-based; no Freedom password is stored in config or env
- Very large source bodies / domain counts are rejected by default
- Prefer `--dry-run` before writing

### Write API

```http
PATCH https://freedom.to/filter_lists/{listId}
Content-Type: application/json
X-CSRF-Token: <token from Freedom page meta csrf-token>

{
  "custom_domains_to_add": ["example.com", "example.edu"]
}
```

Notes from live checks:

- Session cookies alone are not enough for writes; Rails-style `X-CSRF-Token`
  from `<meta name="csrf-token">` is required.
- Multiple domains are accepted in one request.
- Batch probes worked at 2, 10, 50, 100, and 250 domains.
- Default batch size is 50. Override with `--batch-size` (max 500).
- GET and PATCH use a 30s hard timeout.
- After a PATCH timeout, re-read Freedom and only resend still-missing domains.
- Inter-batch pacing is adaptive (~1–2s normally; longer after transient 5xx/429).

### Create API

```http
POST https://freedom.to/filter_lists/
Content-Type: application/json
X-CSRF-Token: <token from Freedom page meta csrf-token>

{
  "name": "Social Media 2"
}
```

Success observed as HTTP 201 with the new filter-list object.

## Requirements

- Node.js 22+
- Chromium (installed via Playwright)

## Install

```bash
npm install
npx playwright install chromium
npm run build
```

For local development without building first:

```bash
npm run dev -- inspect
```

## Authentication

This tool does **not** store your Freedom username or password in `.env`, config,
or CI secrets.

Sign in once through a real browser:

```bash
freedom-list-sync login
```

That command:

1. Opens Chromium in headed mode
2. Navigates to Freedom’s sign-in page
3. Lets you complete login/MFA manually in the browser
4. Detects success by polling an authenticated Freedom endpoint
5. Saves Playwright `storageState` to a user-only session file
6. Closes the browser automatically

On macOS the session file is typically:

`~/Library/Application Support/freedom-list-sync/auth.json`

Override the config directory with `FREEDOM_LIST_SYNC_HOME` if needed.

Check or clear the local session:

```bash
freedom-list-sync auth status
freedom-list-sync logout
freedom-list-sync logout --keep-legacy-profile
```

`auth status` distinguishes:

- **authenticated** — session is valid (even if `/filter_lists/` is unhealthy)
- **expired** — local session was rejected by Freedom
- **no session** — nothing saved locally
- **unavailable** — Freedom could not be reached to verify auth
- **invalid** — local `auth.json` is corrupt/unrecognized (recovery: `login --force`)

Session detection uses a lightweight probe (`/curated_filters/` + homepage signals),
**not** `/filter_lists/`, because that endpoint can HTTP 500 when an oversized
blocklist exists even though you are still signed in. The session file stores
Playwright `storageState` plus small non-sensitive metadata (`createdAt`,
`lastValidatedAt`, and an account email only when Freedom explicitly returns one).

`inspect`, `diff`, and `sync` refuse to continue when the session is missing or
expired, and print a clean prompt to run `login` again. If Freedom itself cannot
be reached to verify auth, they fail with “Freedom unavailable; authentication
could not be verified” — not a login prompt. If you are authenticated but lists
are unavailable, those commands report the list-API failure separately.

A corrupt or unrecognized `auth.json` yields:

`Session file is invalid; run freedom-list-sync login --force.`

A legacy project-local `.freedom-profile/` directory is still loaded if present
(temporary compatibility for older installs; may be removed in a future major
version). `logout` removes both the new auth file and that legacy profile by
default (`--keep-legacy-profile` to retain it).

## Example usage

```bash
# Authenticate (one-time browser login)
freedom-list-sync login
freedom-list-sync auth status

# List Freedom blocklists
freedom-list-sync inspect

# Inspect one list
freedom-list-sync inspect --list "Social Media"

# Preview changes
freedom-list-sync diff \
  --source https://example.com/hosts \
  --list "News"

# Local file instead of URL
freedom-list-sync sync \
  --source-file ./blocklists/distracted.txt \
  --list "Distracted" \
  --source-format domains \
  --dry-run

# Additive synchronization (sharded by default)
freedom-list-sync sync \
  --source https://example.com/hosts \
  --list "Work Focus"

# Large source with explicit shard size
freedom-list-sync sync \
  --source https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/social/hosts \
  --list "Social Media" \
  --shard-size 2500 \
  --dry-run

# Custom batch size + skip large-run confirmation
freedom-list-sync sync \
  --source https://example.com/hosts \
  --list "News" \
  --batch-size 50 \
  --yes
```

Optional source format override:

```bash
--source-format hosts
--source-format domains
--source-format csv
--source-format json
--source-format auto
```

CSV / JSON column helpers:

```bash
--domain-column domain      # CSV header name
--domain-column 0           # CSV 0-based column index
--domain-field domain       # JSON object field name
```

Local files:

```bash
--source-file ./list.txt
--source-file ./list.csv --source-format csv --domain-column domain
--source-file ./list.json --source-format json
```

Provide exactly one of `--source` or `--source-file`.

`--strict` fails the run if any meaningful source line cannot be parsed.

Sources larger than **32 MiB** or producing more than **250,000** domains are rejected by default.

## Source formats

Supported formats are **text-based** (and JSON). The tool fetches the URL body and
parses it according to `--source-format` — it does not care about `.txt` vs no
extension.

Parsers live behind a `SourceParser` interface so additional formats can be added
without changing sync logic.

### Supported

| Format | Description |
| --- | --- |
| `hosts` | Hosts-file mappings such as `0.0.0.0 example.com` or `127.0.0.1 example.com` |
| `domains` | One hostname per line |
| `csv` | Comma-separated values; domain from a header or column index |
| `json` | Simple JSON arrays / wrapped arrays / object arrays |
| `auto` | Conservative detection among the formats above |

#### Hosts format

```text
0.0.0.0 example.com
127.0.0.1 another-example.net # inline comment
# comment
```

Popular public hosts files work with `--source-format hosts`. For a real-world
example, see the Steven Black [social](https://github.com/StevenBlack/hosts/tree/master/alternates/social)
alternate:

`https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/social/hosts`

#### Plain domain format

```text
example.com
foo.example.org
bar.net
```

Inline comments (`domain # comment`) are supported. Bare URL-per-line lists are
**not** accepted by the domains parser.

#### CSV format

```text
domain,category
facebook.com,social
instagram.com,social
```

```bash
--source-format csv
--domain-column domain   # or --domain-column 0
```

If `--domain-column` is omitted, the parser only proceeds when a known header is
present (`domain`, `hostname`, `host`, `website`, `site`, or `url`). It will
**not** silently guess column 0. Auto-detection also requires that known header.

#### JSON format

Supported shapes:

```json
["facebook.com", "instagram.com"]
```

```json
{ "domains": ["facebook.com", "instagram.com"] }
```

```json
[
  { "domain": "facebook.com" },
  { "domain": "instagram.com" }
]
```

```bash
--source-format json
--domain-field domain
```

`auto` only accepts JSON when it is valid and matches one of those shapes.
Malformed JSON-looking documents are rejected instead of being re-parsed as
domain lists.

### Unsupported today (detected and rejected)

- Adblock / uBlock filter syntax (`||example.com^`)
- Wildcard domains (`*.example.com`)
- URL-per-line lists (`https://example.com/path`) as a dedicated format
- Excel / binary spreadsheets
- Arbitrary nested JSON schemas beyond the shapes above
- CSV without a recognizable domain header (unless `--domain-column` is set)
When `auto` cannot confidently choose a format:

```text
Unable to confidently detect source format.

Use one of:

  --source-format hosts
  --source-format domains
  --source-format csv
  --source-format json
```

## Sync modes

- `additive` (default): add missing domains only; never delete
- `mirror`: intended to make Freedom match the source exactly — removals are
  **not supported yet** and will be reported instead of approximated

Always review with `--dry-run` first.

Large additive syncs (>1000 additions) prompt for confirmation unless `--yes`
is supplied.

## Sharding

Large sources are automatically split across multiple Freedom lists that share one
logical base name:

```text
Social Media
Social Media 2
Social Media 3
...
```

Freedom appears to become unreliable with very large individual custom blocklists.
Sharding keeps individual lists within a conservative application safety default
while treating them as one logical synchronization target.

This tool does **not** claim an official Freedom maximum of 2,500 domains. The
default `--shard-size 2500` is a conservative operational limit chosen after
observed failures at much larger sizes. Adjust it if needed:

```bash
--shard-size 2000
--shard-size 2500
--allow-unsafe-shard-size   # required below 100 or above 5000
```

### Behavior

- `--list "Social Media"` is the logical base name; shard 1 keeps that exact name.
- Managed shards match only `Base` and `Base 2`, `Base 3`, … — not `Base Backup`.
- Presence is global: a domain already on any managed shard is not duplicated.
- Oversized shards are frozen for writes (`OVERSIZED`); later shards receive adds.
  This defensive behavior stays even after a wipe/rebuild.
- Live Freedom capacity drives allocation; theoretical sort/chunk assignment is
  documented for future mirror stability, but additive sync does not move domains.
- Missing shards are created automatically via `POST /filter_lists/` during live
  sync. Dry-run still shows **Will create:** without calling Freedom.

## After Locked Mode expires

If an oversized blocklist broke `GET /filter_lists/`:

1. Delete the oversized blocklist in the Freedom UI.
2. Run:

   ```bash
   npx tsx scripts/wait-and-validate-after-cleanup.ts
   ```

3. If validation passes, run the full sharded dry-run before rebuilding.

## Development

```bash
npm test
npm run lint
npm run build
```

CLI helpers for inspecting live Freedom traffic:

```bash
freedom-list-sync debug:network
freedom-list-sync debug:network --action create --list "Work Focus Probe"
freedom-list-sync debug:probe-batch --list "Social Media" --sizes 2,10,50,100
```

One-off probe scripts live under `scripts/debug/` and are not part of the CLI.

Sensitive headers (cookies, authorization, CSRF token values) are redacted from
logs.

## Disclaimer

- Unofficial third-party project; not affiliated with Freedom.
- Freedom’s private/internal endpoints may change.
- Review planned changes with `--dry-run` before writing.
