# valyu auth

Authentication and credential management.

## login

Authenticate the CLI. **By default this runs the browser device flow** (RFC 8628):
it mints a fresh, scoped `val_` API key for your org and stores it - nothing to
copy-paste. Use `--key` for manual / CI logins.

```
valyu login [--device] [--no-browser] [--scope <scopes>] [--profile <name>]
valyu login --key <key> [--profile <name>]
```

| Flag | Description |
|------|-------------|
| `--key <key>` | Authenticate with an existing API key (manual / CI mode) |
| `--device` | Force the device flow (default when `--key` is omitted) |
| `--no-browser` | Print the verification URL + code instead of opening a browser |
| `--scope <scopes>` | Space-separated management scopes to request (default: `account:read keys:read keys:write billing:read`; search/data access is automatic) |
| `--profile <name>` | Profile name (default: "default") |

**Device flow (default, recommended):**

```bash
valyu login
# 1. Prints a user code (e.g. WDJB-MJHT) and opens platform.valyu.ai/device
# 2. You log in + approve in the browser (choose scopes + optional budget cap)
# 3. The CLI mints + stores a scoped val_ key
```

The minted key's id is stored alongside it so `valyu logout` can revoke it
server-side. `billing:write` is NOT requested by default - tick it on the consent
screen if the key needs to move money (top-ups).

**Agent onboarding (line-delimited JSON events):** with `--json` (or in a non-TTY)
`login` streams one JSON object per line so an agent can drive the flow:

```bash
valyu login --json
{"event":"device_code","user_code":"WDJB-MJHT","verification_uri":"https://platform.valyu.ai/device","verification_uri_complete":"https://platform.valyu.ai/device?user_code=WDJB-MJHT","expires_in":900,"interval":5}
{"event":"auth_waiting","status":"authorization_pending","attempt":1}
{"event":"auth_success","profile":"default","valyu_key_id":"...","key_prefix":"val_a1b2c3d4","scope":"...","config_path":"..."}
```

Surface `verification_uri_complete` (or `user_code`) to a human, then keep reading
lines until `auth_success` (or `auth_error`). The CLI honours the server's
`interval` / `slow_down` / `expires_in` automatically.

**Manual / CI:**
```bash
valyu login --key val_xxx --profile production
# → {"success":true,"config_path":"...","profile":"production"}
```

## logout

Revokes the device-minted key server-side (best-effort) and removes stored credentials.

```
valyu logout [--profile <name>] [--no-revoke] [--yes]
```

- Without `--profile`: removes all credentials
- With `--profile`: removes only that profile
- `--no-revoke`: skip the server-side key revocation (just forget locally)
- `--yes`: skips confirmation prompt

## whoami

Show current auth status.

```
valyu whoami
```

Output:
```json
{
  "authenticated": true,
  "profile": "default",
  "api_key": "val_xxx...abcd",
  "source": "config",
  "config_path": "/Users/you/.config/valyu/credentials.json"
}
```

Source values: `"flag"` | `"env"` | `"config"`

## Key Resolution Order

1. `--api-key` flag (per-command override, not stored)
2. `VALYU_API_KEY` environment variable
3. Config file at `~/.config/valyu/credentials.json`

## For CI/CD

Never use `valyu login` in CI. Set `VALYU_API_KEY` as an environment variable:

```bash
VALYU_API_KEY=val_xxx valyu search web "query" -q
```

Or use `--api-key`:
```bash
valyu search web "query" --api-key val_xxx -q
```

## Config File Location

- macOS/Linux: `~/.config/valyu/credentials.json`
- Windows: `%APPDATA%\valyu\credentials.json`
- Override: `$XDG_CONFIG_HOME/valyu/credentials.json`

## Profile Format

```json
{
  "active_profile": "default",
  "profiles": {
    "default": { "api_key": "val_xxx", "valyu_key_id": "uuid" },
    "production": { "api_key": "val_yyy" }
  }
}
```

`valyu_key_id` is only present for device-flow logins (it lets `logout` revoke the
key server-side). Manual `--key` logins omit it - backward compatible.

## Account management

Once logged in, manage keys, budget, and usage with `valyu account ...`. See
[account.md](account.md). The headline pattern is provisioning a budget-capped key
for a sub-agent:

```bash
valyu account keys create --name agent --cap 5
```

## Custom base URL

The account + device endpoints default to `https://api.valyu.ai/v1/account`.
Point the CLI at a different deployment with `VALYU_ACCOUNT_API_BASE`:

```bash
VALYU_ACCOUNT_API_BASE=https://your-account-api.example.com/v1/account valyu login
```
