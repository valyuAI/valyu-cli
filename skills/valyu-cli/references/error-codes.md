# Error Codes

Errors print to stderr as JSON (when piped or with `--json` / `-q`) and exit with code 1:

```json
{"error":{"message":"Human-readable message, then what to do next","code":"error_code"}}
```

API errors keep the code `http_<status>`; the message carries the advice, because one status can mean several things (a 403 can be a rejected key, a dataset above the plan, or a limit the key has not been granted).

## Input errors (nothing was sent)

| Code | Cause | Fix |
|------|-------|-----|
| `missing_query` | No query or brief given | Pass it as an argument or pipe it in |
| `missing_urls` | `contents` got no URLs | Pass URLs or pipe them in |
| `invalid_url` | A URL without `http://` / `https://` | Use absolute URLs |
| `too_many_urls` | More than 10 URLs | Split into batches of 10 |
| `invalid_option` | A flag value out of range or malformed (`--limit`, `--response-length`, dates, `--country`, `--source-bias`) | The message names the flag and the accepted range |
| `invalid_options` | Flags that cannot be combined (e.g. `--structured` with `--pdf`) | Choose one |
| `invalid_mode` | Unknown deep research mode | `fast`, `standard`, `heavy`, `max` |
| `unknown_source` | An `--include-source` / `--exclude-source` value that is not a dataset id, domain, URL prefix, preset, collection or `web` | Use a suggestion from the message, or an id from `valyu sources` |
| `confirmation_required` | `deepresearch delete` without `--yes` outside a terminal | Confirm with the user, then pass `--yes` |

## Authentication

| Code | Cause | Fix |
|------|-------|-----|
| `not_authenticated` | No API key found | `valyu login`, or set `VALYU_API_KEY` |
| `invalid_key_format` | Key doesn't start with `val_` | Check the key |
| `missing_key` | `--key` required in non-interactive login | Pass `--key val_xxx` |
| `validation_failed` | Key rejected at login | Check the key is active at platform.valyu.ai |
| `http_401` | Key rejected | `valyu login`, or check the key at platform.valyu.ai |
| `http_403` with a bare `Forbidden` | Key unknown or revoked | `valyu login`, or check the key at platform.valyu.ai |

## API errors

| Code | Meaning | Fix |
|------|---------|-----|
| `http_402` | Out of credits (or the key's spend cap was reached) | **Do not retry** - every call fails until credits are added. Tell the user; `valyu account topup` or platform.valyu.ai |
| `http_403` | A scoped dataset is above the plan (the message says the plan does not include it) | Retry without `--include-source` - an unscoped search covers everything the plan includes |
| `http_403` | Sources search cannot reach (named in the message) | Remove them from `--include-source` |
| `http_403` | A limit the key has not been granted (e.g. more than 20 results) | Adjust the request, or ask for the limit to be raised |
| `http_422` | Nothing usable in the requested scope | Drop `--include-source` or dates, or broaden the query |
| `http_429` | Rate limited | Wait a few seconds and retry |
| `http_5xx` | Server error | Usually transient - retry once; check status.valyu.ai |
| `network_error` | Cannot reach api.valyu.ai | Check the connection |

## Deep research

| Code | Cause | Fix |
|------|-------|-----|
| `research_failed` | Task failed server-side | Read the message; retry with a narrower brief |
| `research_cancelled` | Task was cancelled | Start a new task |
| `timeout` | `watch` gave up after 4 hours | `valyu deepresearch status <id>` later |
| `no_tasks` | `watch` without an id found nothing running | Pass the task id |
| `no_interaction` | `respond` on a task that is not paused | Check `status`; pass `--interaction-id` if you have it |

## General

| Code | Cause | Fix |
|------|-------|-----|
| `unexpected_error` | Unhandled exception | Report at github.com/valyuAI/valyu-cli/issues |

## Exit codes

- `0` - Success (including searches with no results: read `hint`)
- `1` - Error (details in the JSON on stderr)
