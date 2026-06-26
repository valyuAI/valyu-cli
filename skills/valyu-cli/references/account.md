# valyu account

Self-service account management: API keys (with budget caps),
credit balance, top-ups, usage, and dataset entitlements. Every subcommand is
`--json`-capable and human-pretty by default. Errors use the RFC 9457 + recovery
envelope (`code`, `hint`, `recovery`) so agents can branch and self-heal.

```
valyu account
├── whoami                         # org, tier, calling key + its budget
├── keys
│   ├── list                       # all keys for the org (default)
│   ├── create --name <n> [...]    # mint a key (optionally capped)
│   ├── revoke <id>                # revoke immediately (irreversible)
│   └── rotate <id>                # revoke old secret, mint a new one (same settings)
├── balance                        # credit balance + PAYG usage + tier
├── topup <amount>                 # Stripe Checkout link (NEVER charges directly)
├── usage [--start --end --group-by]  # spend over time
└── datasets                       # what this key/org can reach + tier ladder
```

All commands resolve auth like the rest of the CLI: `--api-key` > `VALYU_API_KEY`
> stored profile (`valyu login`). The calling key must hold the relevant scope
(`keys:read`/`keys:write`/`billing:read`/`billing:write`).

## The budget-capped agent key (headline pattern)

Provision a sub-key a sub-agent can burn through without risking the whole balance:

```bash
valyu account keys create --name agent --cap 5
```

```
Created key agent  val_a1b2c3d4
  id      <uuid>
  scopes  inference
  budget  $5.00 total spend cap

Save this secret now - it is shown only once:

    val_............................................................

```

The secret (`api_key`) is returned exactly once. Hand it to the sub-agent as
`VALYU_API_KEY`; when spend hits the cap the data plane returns
`402 spend_cap_reached`.

Richer example - monthly cap, search-only:

```bash
valyu account keys create \
  --name research-bot --cap 50 --window monthly \
  --scopes inference --json
```

### `keys create` options

| Flag | Description |
|------|-------------|
| `--name <name>` | Required. Human-readable key name (unique per org). |
| `--cap <usd>` | Spend cap in USD. Omit for uncapped (subject to your own remaining cap). |
| `--window <total\|monthly>` | Cap window (default `total`). `monthly` resets each month. |
| `--scopes <a,b>` | Comma-separated scopes (default `inference`; must be a subset of yours). |
| `--type <user\|service_account>` | Key type (default `user`). |
| `--rate-limit <rpm>` | Rate limit in requests per minute. |
| `--expires <iso>` | Expiry as an ISO 8601 timestamp. |

**Escalation invariants** (enforced server-side): requested `scopes` and `cap`
can never exceed the calling key's own. Violations return `403`
`scope_escalation` / `cap_escalation` with a `recovery`
block showing your ceiling.

## balance & topup

```bash
valyu account balance -q
# {"credit_balance_usd":42.18,"payg_usage_usd":7.82,...,"tier":"tier_2"}

valyu account topup 25
# Prints a Stripe Checkout URL. Top-ups NEVER charge a card directly - a human
# completes checkout; credits land via the Stripe webhook.
```

`topup` requires the `billing:write` scope (opt-in at device-login consent).
Add `--open` to open the checkout URL in a browser.

## usage & datasets

```bash
valyu account usage --start 2026-06-01 --group-by dataset -q
valyu account datasets -q   # available_datasets + tier ladder
```

`datasets` is the replanning surface: on a `403 tier_insufficient` an agent reads
`available_datasets` to pick a reachable source instead.

## JSON for agents

Add `-q` (or `--json`) to any subcommand for machine output. On error the process
exits 1 and prints `{"error":{"message","code","hint","retryable","recovery"}}` -
branch on `code`, follow `recovery` (e.g. `topup_url`, `increase_cap_url`).
