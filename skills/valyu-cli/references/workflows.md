# valyu workflows

Reusable, versioned deep research templates. A workflow bundles a prompt template (with typed `{variables}`), a research strategy, a report format, deliverables, and a recommended mode. You fill in the variables and run it — the template expands into a normal `deepresearch` task with the same auth, billing, and lifecycle.

Two scopes:

- **Valyu (curated)** — read-only templates available to every org (`is_valyu: true`). 44+ across verticals: investment-banking, private-equity, hedge-funds, consulting, life-sciences, legal-regulatory, sales-intelligence, supply-chain.
- **Org** — templates your organization creates and versions, private to your org.

A workflow is a *template*; running one creates a single deep research **task**. This is orthogonal to `batch` (which groups many tasks).

## Subcommand tree

```
valyu workflows
├── list [options]                      # discover curated + org templates
├── get <slug> [--version N]            # full template detail (variables, prompt, deliverables)
├── versions <slug>                     # version history
├── preview <slug> [--param k=v ...]    # resolve the template against params (no credits)
├── run <slug> [--param k=v ...]        # run it → starts a deepresearch task
├── create --file <path>                # create an org workflow (JSON definition)
├── update <slug> --file <path>         # edit metadata / publish a new version
└── delete <slug> [-y]                  # delete an org workflow
```

## Quick start

```bash
# Browse curated templates
valyu workflows list --scope valyu
valyu workflows list --vertical investment-banking

# Inspect what a template needs (its variables)
valyu workflows get ib-company-profile

# Dry-run: resolve the prompt without spending credits
valyu workflows preview ib-company-profile --param company="NVIDIA (NVDA)"

# Run it and wait for the report
valyu workflows run ib-company-profile --param company="NVIDIA (NVDA)" --watch
```

## Passing parameters

Workflow variables are filled with `--param key=value` (alias `-P`), repeatable. Values that look like numbers or `true`/`false` are coerced; everything else stays a string.

```bash
valyu workflows run pe-investment-memo \
  -P company="Databricks" \
  -P thesis="Best independent data + AI platform as the lakehouse consolidates" \
  --watch
```

For values with awkward punctuation or for many params, use a JSON file (or stdin):

```bash
valyu workflows run my-org/quarterly-review --params-file params.json --watch
echo '{"company":"Stripe"}' | valyu workflows preview ib-company-profile --params-file -
```

`params.json`:

```json
{ "company": "NVIDIA (NVDA)", "peers": ["AMD", "Intel"] }
```

Required variables are marked with `*` in `valyu workflows get <slug>`. Omitting a required variable returns `validation_failed`.

## Running

`run` overrides are optional — by default the template's own recommended mode and output formats apply.

| Flag | Purpose |
|------|---------|
| `-P, --param <k=v>` | Template parameter (repeatable) |
| `--params-file <path>` | JSON object of params (`-` for stdin) |
| `--version <n>` | Pin a workflow version (default: current) |
| `-m, --mode <mode>` | Override mode: `fast`, `standard`, `heavy`, `max` |
| `-w, --watch` | Block until the task completes and print the result |
| `--webhook-url <url>` | HMAC-signed completion webhook |
| `--alert-email <email>` | Email notification on completion |
| `--alert-email-url <url>` | Custom report link for the alert email (must include `{id}`) |

`run` returns a normal deep research task. Track it with `valyu deepresearch watch <id>` / `status <id>`, exactly like a freeform task.

```bash
# Pinned version, heavy mode, JSON for scripting
ID=$(valyu workflows run ib-company-profile -P company="Apple" --version 1 -m heavy -q | jq -r .deepresearch_id)
valyu deepresearch watch "$ID"
```

## Listing and filtering

```bash
valyu workflows list                       # everything visible to you
valyu workflows list --scope valyu         # curated only
valyu workflows list --scope org           # your org only
valyu workflows list --vertical hedge-funds
valyu workflows list --search "company profile"
valyu workflows list --tag screening --expand   # include template fields
```

## Creating an org workflow

File-based. Required top-level fields: `slug`, `title`, `version`. The `version` object holds the template. Any `{variable}` used in `prompt` / `strategy` / `report_format` / deliverable descriptions must be declared in `variables`.

```bash
valyu workflows create --file workflow.json
cat workflow.json | valyu workflows create --file -
```

`workflow.json`:

```json
{
  "slug": "quarterly-company-profile",
  "title": "Quarterly Company Profile",
  "subtitle": "Standardised profile for IC screening",
  "vertical": "investment-banking",
  "tags": ["screening", "profile"],
  "version": {
    "prompt": "Build a company profile for {company}. Cover business, financials, competitors, and risks.",
    "strategy": "Prioritise filings and earnings calls over press coverage.",
    "report_format": "2-page analyst brief with a peer comparison table.",
    "variables": [
      { "key": "company", "label": "Company", "type": "text", "required": true,
        "placeholder": "Databricks", "examples": ["Stripe", "Ramp"] }
    ],
    "deliverables": [
      { "type": "xlsx", "description": "Peer comparison workbook for {company}" }
    ],
    "tools": { "charts": true },
    "recommended_mode": "standard",
    "estimated_time": "7-12 min",
    "output_formats": ["markdown", "pdf"]
  }
}
```

Variable types: `text`, `textarea`, `number`, `date`, `enum`. For `enum`, set `validation.enum`. Deliverable `type`: `csv`, `xlsx`, `pptx`, `docx`, `pdf`. Limits: ≤50 variables, ≤20 deliverables, ≤20 tags, template fields ≤64KB. Default org quota: 100 workflows.

## Updating and versioning

`update` takes a patch file. It can change metadata (`title`, `subtitle`, `description`, `vertical`, `tags`) and/or publish a new immutable version. When the patch includes a `version` object, `version.changelog` is **required**. Pass `"set_current": false` to add a version without promoting it.

```bash
# Metadata-only edit
echo '{"title":"Quarterly Company Profile (v2)"}' | valyu workflows update quarterly-company-profile --file -

# Publish a new version
valyu workflows update quarterly-company-profile --file new-version.json
```

`new-version.json`:

```json
{
  "version": {
    "prompt": "Build a company profile for {company}, including a competitive landscape section.",
    "strategy": "Prioritise filings and earnings calls.",
    "report_format": "2-page analyst brief.",
    "variables": [{ "key": "company", "label": "Company", "type": "text", "required": true }],
    "changelog": "Added a competitive landscape section."
  }
}
```

Curated Valyu workflows are read-only: `update` / `delete` on them returns `cannot_edit_valyu_workflow` / `cannot_delete_valyu_workflow` (403).

## Agent protocol

```bash
# Discover, then run — JSON for scripting
valyu workflows list --scope valyu -q | jq -r '.workflows[] | "\(.slug)\t\(.title)"'
valyu workflows get ib-company-profile -q | jq '.variables[] | {key, required, type}'

# Resolve before running to confirm the prompt (free)
valyu workflows preview ib-company-profile -P company="NVIDIA (NVDA)" -q | jq -r .resolved.input

# Run and capture the task id
valyu workflows run ib-company-profile -P company="NVIDIA (NVDA)" -q | jq -r .deepresearch_id
```

Errors return `{"error":{"message":"...","code":"..."}}` with exit code 1. Common codes: `validation_failed` (a required/typed param is wrong), `workflow_not_found`, `cannot_edit_valyu_workflow`, `changelog_required`, `workflow_quota_exceeded`.
