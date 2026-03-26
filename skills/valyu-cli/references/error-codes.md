# Error Codes

All errors are returned as JSON with `error.message` and `error.code`:

```json
{"error":{"message":"Human-readable message","code":"error_code"}}
```

## Authentication Errors

| Code | Cause | Fix |
|------|-------|-----|
| `not_authenticated` | No API key found | Run `valyu login` or set `VALYU_API_KEY` |
| `invalid_key_format` | Key doesn't start with `val_` | Check key format |
| `missing_key` | `--key` required in non-interactive mode | Pass `--key val_xxx` |
| `validation_failed` | Key rejected by Valyu API | Check key is active at platform.valyu.ai |
| `http_401` | Unauthorized | API key invalid or expired |
| `http_403` | Forbidden | Insufficient permissions for this operation |

## Search Errors

| Code | Cause | Fix |
|------|-------|-----|
| `invalid_search_type` | Unknown search type | Use: web, paper, bio, finance, sec, patent, economics, news |
| `http_429` | Rate limit exceeded | Slow down requests |
| `http_402` | Insufficient credits | Top up at platform.valyu.ai |

## Research Errors

| Code | Cause | Fix |
|------|-------|-----|
| `invalid_model` | Unknown model | Use: fast, lite, heavy |
| `research_failed` | Task failed server-side | Retry or check query |
| `research_cancelled` | Task was cancelled | Create a new task |
| `timeout` | Watch timed out (>90 min) | Use `research status <id>` to check later |

## Network Errors

| Code | Cause | Fix |
|------|-------|-----|
| `network_error` | Cannot reach api.valyu.network | Check internet connection |
| `http_500` | Server error | Retry; check status.valyu.ai |

## Contents Errors

| Code | Cause | Fix |
|------|-------|-----|
| `too_many_urls` | >10 URLs in one request | Split into batches of 10 |

## General

| Code | Cause | Fix |
|------|-------|-----|
| `unexpected_error` | Unhandled exception | Report at github.com/valyu-network/valyu-cli/issues |

## Exit Codes

- `0` - Success
- `1` - Error (check JSON for details)
