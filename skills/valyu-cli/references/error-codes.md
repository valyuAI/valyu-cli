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
| `invalid_model` | Unknown model | Use: instant, fast, standard, heavy, max |
| `research_failed` | Task failed server-side | Retry or check query |
| `research_cancelled` | Task was cancelled | Create a new task |
| `timeout` | Watch timed out (>3 hrs) | Use `research status <id>` to check later |

## Report Editing Errors

`valyu deepresearch edit`, `edit-status`, `versions` and `restore` pass the API's own codes through:

| Code | Cause | Fix |
|------|-------|-----|
| `edit.invalid_request` | Invalid flag value or instruction | Fix the input; don't retry unchanged |
| `edit.task_not_completed` | Task is not finished yet | Wait for `completed`, then edit |
| `edit.in_progress` | Another edit or restore is running on the task | Retry when it finishes |
| `edit.revision_conflict` | `--base-version` is behind the current version | Re-read `status` and resend with the new version |
| `edit.unsupported_task` | Output is not an editable markdown report | Check `editable` in `status` |
| `focus.not_found` | `--section` / `--text` / offsets matched nothing | Check the heading or passage |
| `focus.ambiguous` | `--text` matched more than once; `candidates` lists the matches | Resend with `--start-char`/`--end-char` or `--prefix`/`--suffix` |
| `edit.busy` | Temporarily at capacity | Retry with backoff |

A declined edit is not an error: it returns the edit record with `status: "declined"` and exits with code 2.

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
- `2` - `valyu deepresearch edit` / `edit-status`: the edit was declined (see `decline.code`)
