# valyu deepresearch

Async multi-step research agent. Searches multiple sources, optionally executes code, generates a report with citations, and optionally produces structured deliverables (CSV / XLSX / PPTX / DOCX / PDF) alongside the report.

`create` returns immediately with a task ID. The task runs in the background — poll `status`, block on `watch`, or set `--webhook-url`.

The command is `valyu deepresearch` (not `valyu research`).

## Subcommand tree

```
valyu deepresearch
├── create <query> [options]            # start a task
├── list [--limit N]                    # list recent tasks
├── status <id>                         # check a task
├── watch [id]                          # poll until terminal (omit id → latest running)
├── update <id> <instruction>           # inject follow-up instruction mid-flight
├── cancel <id>                         # cancel a running / queued / paused task
├── delete <id>                         # remove a completed / failed / cancelled task
└── share <id>                          # toggle public share link
```

## Quick start

```bash
# Minimal fast task
valyu deepresearch create "Current state of nuclear fusion commercialization" --mode fast --watch

# Research + CSV deliverable alongside the markdown+PDF report
valyu deepresearch create "Top 15 Phase 3 CAR-T clinical trials in oncology 2024" \
  --mode standard \
  --deliverable "CSV of trials: NCT ID, sponsor, indication, phase, primary endpoint, enrollment" \
  --watch

# Structured JSON only (no markdown / PDF)
valyu deepresearch create "Top 10 Series C AI infrastructure startups 2024" \
  --mode fast \
  --structured-file schema.json \
  --watch
```

## Modes

| Mode | Time | Price | Best for |
|------|------|-------|----------|
| `fast` | ~5 min | $0.10 | Quick lookups, lists, structured extraction, high-volume batches |
| `standard` | ~10-20 min | $0.50 | Most research tasks (default) |
| `heavy` | ~60 min | $2.50 | Deep analysis, comparative reports |
| `max` | up to ~2 hrs | $15.00 | Maximum depth, exhaustive research |

## Deliverables — structured files alongside the report

Deliverables are **additional files generated alongside the markdown/PDF report**: CSVs, Excel workbooks, PowerPoint decks, Word docs, PDFs. The agent extracts structured data from its research and populates them. You get both a narrative report *and* machine-parseable data in one run.

**When to use deliverables (vs `--structured`):**

| Want | Use |
|------|-----|
| Both a narrative report AND a structured file | **deliverables** |
| Structured JSON with no report | `--structured-file` / `--structured` |

### Common deliverable recipes

| Use case | Example `--deliverable` description |
|----------|-------------------------------------|
| Drug candidate shortlist | `"XLSX of molecules: name, primary target, mechanism, phase, developer, ChEMBL ID"` |
| Clinical trial tracker | `"CSV of trials: NCT ID, sponsor, indication, phase, enrollment, primary endpoint, status, start date"` |
| Company lead list | `"CSV of companies: name, HQ city, founders, total funding, last round date, product one-liner"` |
| Competitive landscape deck | `"PPTX with one slide per competitor covering product, pricing, funding, and differentiation"` |
| Financial comparison | `"XLSX comparing Q4 2024 revenue, YoY growth, gross margin, and segment breakdown for Big Tech"` |
| Regulatory filings summary | `"DOCX brief summarizing the five most recent SEC 10-K risk-factor sections"` |
| Patent landscape | `"CSV of patents: patent number, assignee, filing date, title, abstract, forward citation count"` |

### Passing deliverables — two forms

**Form 1 — Natural language (`--deliverable`, repeatable):** agent picks the file type from your description.

```bash
valyu deepresearch create "GLP-1 receptor agonists approved since 2020" \
  --deliverable "CSV of drugs: name, manufacturer, FDA approval date, indication, MoA" \
  --deliverable "One-page PDF executive summary of the competitive landscape" \
  --deliverable "XLSX comparing efficacy, adverse events, and pricing across drugs" \
  --watch
```

**Form 2 — Structured JSON (`--deliverables-file`):** pin file type, columns, and (for pptx) slide count.

```json
[
  {
    "type": "csv",
    "description": "Top 20 Series A AI startups raised in 2026",
    "columns": ["company", "founders", "hq_city", "round_size_usd", "round_date", "lead_investor", "category"]
  },
  {
    "type": "xlsx",
    "description": "Investor landscape: VCs leading the most AI Series A rounds"
  },
  {
    "type": "pptx",
    "description": "Investor briefing deck: landscape overview + top 10 founders + breakout companies",
    "slides": 12
  },
  "One-page PDF executive summary of the landscape"
]
```

```bash
valyu deepresearch create "Top 20 Series A AI startups" \
  --deliverables-file deliverables.json \
  --watch
```

Both forms combine — `--deliverable` strings and `--deliverables-file` entries merge into a single deliverables list (max 10 total).

### Deliverable object fields

| Field | Type | Notes |
|-------|------|-------|
| `type` | `"csv" \| "xlsx" \| "pptx" \| "docx" \| "pdf"` | Required |
| `description` | string (≤ 500 chars) | Required. Be specific about columns, units, filters |
| `columns` | `string[]` | Column hints for csv/xlsx |
| `slides` | number | Suggested slide count for pptx |

String-form deliverables accept up to 2000 chars. Per-request cap: 10 deliverables total.

### Deliverable pricing

Base mode price covers **1 deliverable**. Each additional deliverable adds **$0.10**. Check `cost_breakdown.deliverables` on the completed task.

### Deliverable result shape

On completion, each deliverable appears in `status.deliverables[]`:

```json
{
  "id": "del_a1b2c3d4",
  "request": "CSV of trials: NCT ID, sponsor, indication, phase",
  "type": "csv",
  "status": "completed",
  "title": "Phase 3 CAR-T Trials in Oncology 2024.csv",
  "description": "14 trials across six indications; all active or completed recruitment",
  "url": "https://api.valyu.ai/v1/deepresearch/tasks/.../assets/...?token=...",
  "row_count": 14,
  "column_count": 7,
  "created_at": 1718444640000
}
```

Download via:

```bash
URL=$(valyu deepresearch status <id> -q | jq -r '.deliverables[] | select(.type=="csv") | .url')
curl -L "$URL" -o trials.csv
```

The `url` is token-signed and tied to the task — no auth header needed.

### Writing good deliverable descriptions

Be specific about **columns and units**. The agent uses your description to design the schema.

```text
Good (specific columns, units, and filters):
"CSV of Phase 3 oncology trials 2024:
 NCT ID, sponsor (company name), indication (cancer type),
 enrollment (integer, actual not target), primary endpoint (text),
 status (recruiting/active/completed), start date (YYYY-MM-DD)"
```

```text
Less specific (will get inconsistent output):
"CSV of trials"
```

```text
Good (scoped and typed):
"XLSX of Top 20 AI Series A raises in 2024:
 company name, founders (comma-separated), HQ city,
 round size in millions USD (float), round date (YYYY-MM-DD),
 lead investor, product category (one of: infrastructure, application, tooling, model)"
```

```text
Less specific:
"Excel of AI startups and their info"
```

## create — full options

```
valyu deepresearch create <query> [options]
```

### Steering

| Flag | Description |
|------|-------------|
| `-m, --mode <mode>` | Depth: `fast` / `standard` (default) / `heavy` / `max` |
| `--research-strategy <text>` | Guide the research phase (how to search, which angles to prioritize) |
| `--report-format <text>` | Guide the final report shape (length, tone, sections, tables) |

`research_strategy` + `report_format` combined length must stay under 15,000 characters.

### Context

| Flag | Description |
|------|-------------|
| `--url <url>` | Seed URL to include in research (repeatable, max 10) |
| `--file <path>` | File to attach, auto base64-encoded (repeatable, max 10). PDF/TXT/MD/CSV/JSON/DOCX/XLSX/PPTX/PNG/JPG |
| `--file-context <text>` | Optional guidance for a specific file (repeatable, pairs positionally with `--file`; max 10,000 chars each) |
| `--previous-report <id>` | Previous `deepresearch_id` as context (repeatable, max 3) |

File + file-context pairing is positional — the Nth `--file-context` attaches to the Nth `--file`:

```bash
valyu deepresearch create "Brief on these two documents" \
  --file ./target-overview.pdf --file-context "Acquirer's strategic rationale memo" \
  --file ./financials-q4.xlsx --file-context "Management's own cut, not audited - highlight discrepancies"
```

### Output

| Flag | Description |
|------|-------------|
| `--output-format <fmt>` | Repeatable: `markdown`, `pdf`, `toon`. Default: `markdown`+`pdf` |
| `--no-pdf` | Skip PDF (shorthand for `--output-format markdown`) |
| `--structured <json>` | Inline JSON schema → structured JSON output (replaces markdown/PDF) |
| `--structured-file <path>` | Read JSON schema from file (same effect as `--structured`) |

`--structured` / `--structured-file` **cannot combine** with `markdown`/`pdf`/`toon`. `toon` requires a JSON schema alongside it.

### Search config

| Flag | Description |
|------|-------------|
All of these are **advanced** — the agent picks sources and scope well on its own, and hard constraints here usually shrink the usable result set and hurt quality. Only reach for them when you have a concrete reason.

| Flag | Description |
|------|-------------|
| `--search-type <type>` | [advanced] `all` (default), `web`, `proprietary` |
| `--include-source <id>` | [advanced] Source to include, repeatable (dataset IDs, domains) |
| `--exclude-source <id>` | [advanced] Source to exclude, repeatable |
| `--source-bias <src>=<int>` | [advanced] Bias a source up or down in ranking (repeatable). Integer -5 to +5; applies to every internal search the agent runs |
| `--country <code>` | [advanced] ISO 3166-1 alpha-2 code for geo-targeted web search |
| `--start-date <date>` | [advanced] Earliest publication date (`YYYY-MM-DD`) |
| `--end-date <date>` | [advanced] Latest publication date (`YYYY-MM-DD`) |

### Tools

| Flag | Description |
|------|-------------|
| `--code-execution` | Sandboxed Python execution for computations, parsing, analysis (+$0.10 per execution) |
| `--screenshots` | Visual screenshot capture of web pages, useful for dashboards/charts (+$0.05 per URL) |
| `--browser-use` | Autonomous browser navigation - lets the agent click through interactive pages / multi-step flows |
| `--mcp-config <path>` | JSON file describing up to 5 MCP servers to expose to the agent. File-based to keep auth tokens out of shell history |

**MCP config file format** — each entry describes one MCP server:

```json
[
  {
    "url": "https://mcp.example.com/tools",
    "name": "internal-tools",
    "tool_prefix": "ex",
    "auth": { "type": "bearer", "token": "..." },
    "allowed_tools": ["lookup", "query"]
  }
]
```

Auth forms: `{"type": "none"}`, `{"type": "bearer", "token": "..."}`, or `{"type": "header", "headers": { "X-Api-Key": "..." }}`.

### Deliverables

| Flag | Description |
|------|-------------|
| `--deliverable <desc>` | Natural language description (repeatable, max 10 total) |
| `--deliverables-file <path>` | JSON array of structured deliverable specs |

### Notifications

| Flag | Description |
|------|-------------|
| `--webhook-url <url>` | HTTPS URL to POST to on completion. HMAC-SHA256 signed. Response includes `webhook_secret` |
| `--alert-email <email>` | Email address to notify (must belong to your org) |

### Metadata

| Flag | Description |
|------|-------------|
| `--metadata <key=value>` | Attach metadata (repeatable). Values auto-typed: `true`/`false` → bool, numeric → number, else string |

### Human-in-the-loop

| Flag | Description |
|------|-------------|
| `--hitl <list>` | Comma-separated checkpoints: `planning-questions`, `plan-review`, `source-review`, `outline-review` |

When a HITL checkpoint fires, `status` becomes `awaiting_input` (or `paused` if timed out — still resumable). Use `valyu deepresearch watch` to respond interactively.

## status / watch response shapes

### Running

```json
{
  "deepresearch_id": "a1b2c3d4-...",
  "status": "running",
  "query": "...",
  "mode": "standard",
  "progress": { "current_step": 5, "total_steps": 15 }
}
```

### Completed (markdown report + deliverables)

```json
{
  "deepresearch_id": "a1b2c3d4-...",
  "status": "completed",
  "query": "...",
  "mode": "standard",
  "output_type": "markdown",
  "output": "# Report\n\n## Executive Summary...",
  "pdf_url": "https://storage.valyu.ai/pdfs/...",
  "sources": [ { "title": "...", "url": "...", "snippet": "...", "source": "pubmed" } ],
  "deliverables": [
    { "id": "del_...", "type": "csv", "status": "completed", "title": "...", "url": "...", "row_count": 14, "column_count": 7 }
  ],
  "images": [ { "image_id": "img_...", "image_type": "chart", "image_url": "...", "chart_type": "bar" } ],
  "cost": 0.30,
  "cost_breakdown": { "task": 0.10, "deliverables": 0.20 },
  "completed_at": "2024-06-15T10:42:00.000Z"
}
```

### Completed (structured JSON)

```json
{
  "deepresearch_id": "...",
  "status": "completed",
  "output_type": "json",
  "output": { "companies": [ {"name": "Lambda", "valuation_billions": 1.5, "hq_city": "San Jose"} ] },
  "sources": [ ... ],
  "cost": 0.10
}
```

### Awaiting HITL input

```json
{
  "status": "awaiting_input",
  "interaction": {
    "interaction_id": "int_...",
    "type": "plan_review",
    "data": {
      "plan": "...",
      "estimated_steps": 12,
      "research_areas": ["market sizing", "competitive landscape", "regulatory"]
    }
  }
}
```

## Status lifecycle

```
queued → running ─────────────┬─→ completed
                              ├─→ failed
                              └─→ cancelled
        running → awaiting_input → running  (HITL checkpoint, user responded)
                 → paused → running         (HITL timed out, still resumable)
```

## Recipes

### Drug candidate shortlist (XLSX + markdown report)

```bash
valyu deepresearch create \
  "Pre-clinical and clinical stage GLP-1 combination therapies targeting obesity" \
  --mode standard \
  --research-strategy "Prioritize primary sources: ClinicalTrials.gov, FDA drug labels, PubMed abstracts" \
  --deliverable "XLSX of candidates: molecule name, mechanism (primary + secondary targets), developer, clinical phase, lead indication, NCT IDs if applicable, ChEMBL ID if available" \
  --deliverable "One-page PDF executive summary ranking the top 5 by commercial promise" \
  --watch
```

### Clinical trial tracker (CSV)

```bash
valyu deepresearch create \
  "Phase 3 CAR-T clinical trials in solid tumors currently recruiting" \
  --mode fast \
  --deliverable "CSV of trials: NCT ID, sponsor, indication, target antigen, phase, enrollment, start date, primary endpoint, status" \
  --watch
```

### Company lead list (CSV)

```bash
valyu deepresearch create \
  "Seed and Series A AI startups in NYC building developer tools" \
  --mode standard \
  --country US \
  --deliverable "CSV of companies: name, website, founders (with LinkedIn if public), HQ address, total funding USD, last round (type + date + lead), product one-liner, tech stack hints" \
  --watch
```

### Competitive landscape (PPTX deck)

```bash
valyu deepresearch create \
  "Competitive landscape of enterprise AI coding assistants" \
  --mode heavy \
  --deliverable "PPTX: title slide + one slide per competitor (product, pricing, funding, customer logos, differentiators) + positioning matrix slide + conclusion slide" \
  --deliverable "CSV comparison matrix of all competitors across 12 feature dimensions" \
  --watch
```

### Follow-up research (mid-flight update)

```bash
# Kick off the task
ID=$(valyu deepresearch create "..." --mode standard -q | jq -r .deepresearch_id)

# Before the writing phase begins, inject a steering instruction
valyu deepresearch update $ID "Also cover regulatory risk and EU-specific market dynamics"

# Continue watching
valyu deepresearch watch $ID
```

### Structured output with a known schema

```bash
cat > schema.json <<'EOF'
{
  "type": "object",
  "properties": {
    "companies": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "valuation_billions", "hq_city"],
        "properties": {
          "name": { "type": "string" },
          "valuation_billions": { "type": "number" },
          "hq_city": { "type": "string" },
          "last_round_date": { "type": "string", "format": "date" }
        }
      }
    }
  },
  "required": ["companies"]
}
EOF

valyu deepresearch create "Top 10 generative AI unicorns 2024" \
  --mode fast --structured-file schema.json --watch
```

### Async with webhook

```bash
valyu deepresearch create "..." \
  --mode heavy \
  --webhook-url "https://your-app.com/valyu/webhooks" \
  --deliverable "CSV: ..."
# → returns webhook_secret for HMAC verification
```

## Troubleshooting — keyed on error strings

### `"TOON output format requires a JSON schema. Include a schema object in output_formats."`
`toon` cannot stand alone. Combine with `--structured`/`--structured-file`, or drop `toon` from `--output-format`.

### `"--structured / --structured-file cannot be combined with --output-format"`
Structured JSON replaces markdown and PDF. Remove `--output-format` when using `--structured*`. If you want both a markdown report AND structured data, use **deliverables** instead.

### `"Invalid --metadata 'foo'. Expected format: key=value"`
Each `--metadata` value must be `key=value`. Repeat the flag for multiple entries: `--metadata key1=v1 --metadata key2=v2`.

### `"Invalid --hitl checkpoint 'foo'. Valid: planning-questions, plan-review, source-review, outline-review"`
Use hyphenated names (not underscore). Multiple checkpoints are comma-separated: `--hitl plan-review,source-review`.

### `"Use --structured or --structured-file, not both"`
Mutually exclusive; choose one.

### `"File not found: <path>"` (from `--structured-file` / `--deliverables-file` / `--file`)
Path resolves relative to the working directory. Use an absolute path if unsure.

### `"No running tasks"` (from `watch` without an ID)
There are no `running` / `queued` / `awaiting_input` tasks on the current API key. Pass a specific task ID.

### Task status is `failed`
Check `status.error` for the reason. Common causes: query too ambiguous, all sources filtered out, sandbox crash during code execution. Retry with a narrower query and/or without `--code-execution`.

### Task status is `paused` (HITL)
A checkpoint timed out. State is preserved — respond via the API (`POST /deepresearch/tasks/{id}/respond`) and the task resumes, or `valyu deepresearch cancel <id>`.

## Agent protocol

- `create` returns immediately with `status: "running"` or `status: "queued"` — capture `deepresearch_id` and use it for every follow-up call.
- Don't poll `status` in a tight loop — use `valyu deepresearch watch <id>` (internally paced at 5s). For async workflows, set `--webhook-url`.
- Deliverable `url` fields are token-signed; download with plain `curl -L` (no auth header).
- `output` is a markdown string when `output_type: "markdown"` and a JSON object when `output_type: "json"`. Branch on `output_type`.
- `progress.total_steps` is an estimate — can increase mid-task.
- Costs are final on `completed`; `cost_breakdown` is only present on terminal states.
- For high-volume workflows, use **batches** (`valyu batch --help`) — shared config, parallel execution, unified tracking.
