# valyu auth

Authentication and credential management.

## login

Store a Valyu API key.

```
valyu login [--key <key>] [--profile <name>]
```

| Flag | Description |
|------|-------------|
| `--key <key>` | API key to store (required in non-interactive mode) |
| `--profile <name>` | Profile name (default: "default") |

**Interactive:** Opens browser to platform.valyu.ai/keys, then prompts for key.

**Non-interactive (CI/agents):**
```bash
valyu login --key val_xxx --profile production
# → {"success":true,"config_path":"...","profile":"production"}
```

## logout

```
valyu logout [--profile <name>] [--yes]
```

- Without `--profile`: removes all credentials
- With `--profile`: removes only that profile
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
    "default": { "api_key": "val_xxx" },
    "production": { "api_key": "val_yyy" }
  }
}
```
