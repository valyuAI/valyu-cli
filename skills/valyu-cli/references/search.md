# valyu search

Synchronous search across web, academic, financial, and specialised sources. Ranked results with extracted content, ready for RAG or downstream processing.

## Syntax

```
valyu search <type> <query> [options]
valyu search <query> [options]          # defaults to web
echo "query" | valyu search -           # stdin
```

The `<type>` positional is a curated bundle that sets `search_type` + a sensible `included_sources` default. See the table below.

## Search types (positional)

| Type | Backing sources | Best for |
|------|-----------------|---------|
| `web` | Web | General lookups, news, product pages |
| `news` | News outlets | Breaking stories, recent coverage |
| `paper` | arXiv, PubMed, bioRxiv, medRxiv | Academic research |
| `bio` | PubMed, bioRxiv, medRxiv, ClinicalTrials.gov, FDA labels | Life sciences / clinical |
| `finance` | SEC filings, stocks, earnings, balance sheet, cashflow, insider, crypto, forex | Financial data |
| `sec` | SEC filings only | 10-K / 10-Q / 8-K research |
| `patent` | Global patents | IP landscape / prior art |
| `economics` | BLS, FRED, World Bank, USAspending | Macro / economic indicators |

## Options

### Core

| Flag | Description |
|------|-------------|
| `-n, --limit <number>` | Results count (1-20; higher on request). Default `10` |
| `--max-price <number>` | Max budget in CPM (cost per mille tokens retrieved) |
| `--relevance-threshold <float>` | Filter results below this score (0.0-1.0). Default `0.5` |
| `-l, --response-length <len>` | Content length per result: `short` (25k), `medium` (50k), `large` (100k), `max`, or a positive integer |
| `--instructions <text>` | Natural-language ranking instructions (max 500 chars; ignored with `--fast-mode`) |

### Scoping (overrides for the positional type)

| Flag | Description |
|------|-------------|
| `--search-type <type>` | Force `all` / `web` / `proprietary` / `news` |
| `--include-source <src>` | Include a source (repeatable). Domains, dataset IDs, or `collection:NAME` |
| `--exclude-source <src>` | Exclude a source (repeatable) |
| `--source-bias <src>=<int>` | Bias a source up or down in ranking (repeatable). Integer -5 to +5 |
| `--country <code>` | ISO 3166-1 alpha-2 country code for geo-targeted web search |
| `--start-date <date>` | Earliest publication date (`YYYY-MM-DD`) |
| `--end-date <date>` | Latest publication date (`YYYY-MM-DD`) |

### Advanced

| Flag | Description |
|------|-------------|
| `--fast-mode` | Skip query rewriting + reranking for lower latency. Forces web-only; lower-quality results. Use only when you genuinely need sub-second latency |
| `--url-only` | Return just URLs without full content extraction (`web` / `news` only). Skips reranking |
| `--no-tool-call` | Mark request as non-tool-call. Affects internal query rewriting |

## Output (JSON, shortened)

```json
{
  "success": true,
  "tx_id": "tx_...",
  "query": "the query",
  "results": [
    {
      "id": "https://arxiv.org/abs/2401.12345",
      "title": "...",
      "url": "https://arxiv.org/abs/2401.12345",
      "content": "...",
      "source": "valyu/valyu-arxiv",
      "relevance_score": 0.92,
      "data_type": "unstructured",
      "source_type": "paper",
      "publication_date": "2024-01-15",
      "doi": "10.48550/arXiv.2401.12345",
      "authors": ["J. Smith", "A. Chen"]
    }
  ],
  "results_by_source": { "web": 3, "proprietary": 2 },
  "total_deduction_dollars": 0.0075,
  "total_characters": 45230
}
```

## Examples

```bash
# Broad web search
valyu search "current state of nuclear fusion commercialization"

# Academic papers
valyu search paper "transformer attention mechanism" -n 20

# Clinical trial + FDA data
valyu search bio "GLP-1 receptor agonist obesity clinical trials"

# Financial data
valyu search finance "NVDA Q4 earnings datacenter segment guidance"

# SEC filings
valyu search sec "Apple 10-K risk factors competitive"

# Date-scoped web search
valyu search "AI model releases" --start-date 2024-01-01 --end-date 2024-12-31

# Ranking instructions for nuance
valyu search paper "CRISPR therapeutics" \
  --instructions "Prioritize Phase 3 clinical trials and safety data over in vitro studies"

# Relevance threshold for high-precision
valyu search "GLP-1 combination therapies" --relevance-threshold 0.9 -n 20

# Larger content per result (for longer articles / reports)
valyu search paper "quantum error correction" --response-length medium
```

## Agent tips

- Non-TTY auto-emits JSON; use `-q` in pipelines to force it and suppress spinners.
- `relevance_score` is 0-1; filter at `>0.7` for high precision, `>0.5` (default) for recall.
- `sec` is for filings; `finance` is for prices + fundamentals. Don't mix them for a single lookup.
- `bio` is a superset of `paper` for life sciences — it adds clinical trials and FDA drug labels.
- `--fast-mode` skips reranking entirely — results are noticeably worse. Only use for tight latency budgets.
- `--url-only` is useful when you want to pipe URLs into `valyu contents` for selective extraction.
