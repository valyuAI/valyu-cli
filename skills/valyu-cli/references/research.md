# valyu research

Async deep research with AI-synthesized reports. Spawns a background task and returns a task ID.

## Subcommands

| Subcommand | Description |
|-----------|-------------|
| `create <query>` | Start a new research task |
| `status <id>` | Check task status |
| `watch <id>` | Poll until complete, then display result |

## create

```
valyu research create <query> [options]
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `-m, --model <model>` | `lite` | Research depth: `fast`, `lite`, `heavy` |
| `--pdf` | - | Generate PDF output |
| `-w, --watch` | - | Wait for completion inline |

### Model comparison

| Model | Time | Use case |
|-------|------|---------|
| `fast` | ~5 min | Quick lookups, simple factual questions |
| `lite` | ~10-20 min | Balanced - most use cases (default) |
| `heavy` | ~90 min | Deep analysis, comprehensive reports |

### Output (JSON)

```json
{
  "id": "f992a8ab-4c91-4322-905f-190107bd5a5b",
  "status": "queued",
  "query": "AI infrastructure landscape",
  "model": "lite",
  "created_at": 1759617800000
}
```

## status / watch

```
valyu research status <id>
valyu research watch <id>
```

### Output (JSON) - completed

```json
{
  "id": "f992a8ab-4c91-4322-905f-190107bd5a5b",
  "status": "completed",
  "query": "AI infrastructure landscape",
  "output": "# AI Infrastructure...\n\n## Overview...",
  "pdf_url": "https://storage.valyu.ai/reports/...",
  "sources": [
    { "title": "Source Title", "url": "https://...", "snippet": "..." }
  ],
  "progress": { "current_step": 5, "total_steps": 5 },
  "usage": {
    "search_cost": 0.0075,
    "ai_cost": 0.15,
    "total_cost": 0.1575
  },
  "completed_at": 1759617836483
}
```

### Status lifecycle

```
queued → running → completed | failed | cancelled
```

## Examples

```bash
# Quick research
valyu research create "Current state of nuclear fusion commercialization" --model fast -q

# Balanced research with watch
valyu research create "Competitive landscape: AI search APIs 2025" --watch

# Deep analysis with PDF
valyu research create "Global semiconductor supply chain risks and mitigations" --model heavy --pdf -q

# Check status
valyu research status f992a8ab-4c91-4322-905f-190107bd5a5b -q

# Wait for completion
valyu research watch f992a8ab-4c91-4322-905f-190107bd5a5b -q
```

## Agent Tips

- **Don't poll manually** - use `research watch` or `--watch` flag
- Save the task `id` immediately - use it to check status later
- `output` field is markdown - render for users or process programmatically
- `heavy` model is expensive - use for genuinely complex research only
- Research tasks persist server-side; you can check status hours later
- `pdf_url` is only present when `--pdf` was used and task is completed
