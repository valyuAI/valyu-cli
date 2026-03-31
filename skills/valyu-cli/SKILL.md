---
name: valyu-cli
description: >
  Use the Valyu CLI to search the web, academic papers, financial data, SEC filings,
  patents, biomedical research, and more. Get AI-powered answers, extract web content,
  and run deep research reports — all from the terminal via the `valyu` command.
  Use when the user wants to search for information, research a topic, or extract content
  from URLs. Always load this skill before running `valyu` commands.
license: MIT
metadata:
  author: valyu
  version: "1.0.3"
  homepage: https://valyu.ai
  source: https://github.com/valyu-network/valyu-cli
inputs:
  - name: VALYU_API_KEY
    description: Valyu API key for authenticating CLI commands. Get yours at https://platform.valyu.ai
    required: true
references:
  - references/search.md
  - references/answer.md
  - references/contents.md
  - references/research.md
  - references/auth.md
  - references/error-codes.md
---

# Valyu CLI

## Agent Protocol

The CLI auto-detects non-TTY environments and outputs JSON — no `--json` flag needed in pipelines.

**Rules for agents:**
- Supply `VALYU_API_KEY` or use `--api-key`. Never rely on interactive login.
- Pass `-q` / `--quiet` to suppress spinners and get clean JSON.
- Exit `0` = success, `1` = error.
- Error JSON:
  ```json
  {"error":{"message":"...","code":"..."}}
  ```
- All commands produce structured JSON output when stdout is not a TTY.

## Authentication

Auth resolves: `--api-key` flag > `VALYU_API_KEY` env > config file (`valyu login`).

## Global Flags

| Flag | Description |
|------|-------------|
| `--api-key <key>` | Override API key for this invocation |
| `-p, --profile <name>` | Select stored profile |
| `--json` | Force JSON output |
| `-q, --quiet` | Suppress spinners/status (implies `--json`) |

## Available Commands

| Command | What it does |
|---------|-------------|
| `search <type> <query>` | Search web, paper, bio, finance, sec, patent, economics, news |
| `answer <query>` | AI-powered answer with real-time search integration |
| `contents <urls...>` | Extract clean content from web pages |
| `research create <query>` | Start a deep research task |
| `research status <id>` | Check research task status |
| `research watch <id>` | Poll until research completes |
| `login` | Save API key |
| `logout` | Remove API key |
| `whoami` | Show authentication status |
| `doctor` | Check setup and API connectivity |
| `open [target]` | Open Valyu in browser |

## Common Patterns

**Search for recent papers:**
```bash
VALYU_API_KEY=val_xxx valyu search paper "quantum error correction 2025" --limit 15 -q
```

**Get an AI answer:**
```bash
VALYU_API_KEY=val_xxx valyu answer "What are the latest FDA drug approvals?" -q
```

**Extract and summarize a URL:**
```bash
VALYU_API_KEY=val_xxx valyu contents https://arxiv.org/abs/2501.12345 --summary -q
```

**Deep research (async):**
```bash
# Create task
valyu deepresearch create "AI infrastructure investment landscape 2025" --mode standard -q
# Returns: {"deepresearch_id":"abc-123","status":"running",...}

# Check/watch
valyu deepresearch watch abc-123 -q
```

**Financial data:**
```bash
valyu search finance "NVDA Q4 2024 earnings revenue" -q
```

**SEC filings:**
```bash
valyu search sec "Tesla 10-K 2024 risk factors" --limit 5 -q
```

## Common Mistakes

| # | Mistake | Fix |
|---|---------|-----|
| 1 | Running without API key in CI | Set `VALYU_API_KEY` env var |
| 2 | Not using `-q` in pipelines | Spinners go to stderr but use `-q` for clean output |
| 3 | Wrong search type | Use `web` for general, `paper` for academic, `bio` for biomedical |
| 4 | Polling research too fast | `research watch` handles polling - don't loop manually |
| 5 | Expecting synchronous research | `research create` returns immediately; use `--watch` or poll `research status` |

## When to Load References

- **Searching** → [references/search.md](references/search.md)
- **Getting AI answers** → [references/answer.md](references/answer.md)
- **Extracting web content** → [references/contents.md](references/contents.md)
- **Deep research reports** → [references/research.md](references/research.md)
- **Auth and profiles** → [references/auth.md](references/auth.md)
- **Error codes** → [references/error-codes.md](references/error-codes.md)
