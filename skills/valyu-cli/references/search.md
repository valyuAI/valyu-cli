# valyu search

One search across the live web and Valyu's specialised datasets - open and paywalled academic journals, SEC filings, company fundamentals and insider transactions, market data, clinical trials, drug labels and biomedical databases, economic indicators, patents, UK case law and legislation, financial news and prediction markets. Returns ranked full-text results (not just links), each with a relevance score.

## Syntax

```
valyu search <query> [options]
echo "<query>" | valyu search [options]
```

Unquoted words are joined, so `valyu search nvidia datacenter revenue` works. The one exception is the form earlier versions used: exactly two arguments where the first is `web`, `paper`, `bio`, `finance`, `sec`, `patent`, `economics` or `news` is read as a search type and a query (see below).

## The default is the recommendation

Pass just a query. Routing picks the corpora, weighs the web against them, and stays within what the plan covers, so an unscoped search never fails on access. Every option below the first two is **advanced**: set it only when the user named that source, site, country or date window themselves.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `-n, --limit <n>` | `10` | Results to return, 1-100. Above 20 needs a key permission (the API says so). Raise toward 20 only for an exhaustive sweep. |
| `-l, --response-length <chars>` | `4000` | Max characters per result, 500-100000. The context-size lever: 10 results at 4000 is roughly 10k tokens. Structured records (trials, market data) come back whole. |
| `--include-source <source>` | - | **[advanced]** Hard filter, repeatable. A dataset id from `valyu sources`, a domain (`arxiv.org`), a URL prefix with scheme (`https://openai.com/index`), a preset (`academic`, `finance`, `legal`, `health`, `patent`, ...), `collection:NAME`, or `web` to keep the live web alongside a scoped dataset. Prefer one precise source over a mix. |
| `--exclude-source <source>` | - | **[advanced]** Repeatable. Dataset ids, domains or URL prefixes. Presets and collections are refused here (the API does not expand them in exclusions). |
| `--source-bias <source=n>` | - | **[advanced]** Repeatable. Ranks a domain up or down, integer -5..+5, e.g. `arxiv.org=5`, `pinterest.com=-4`. Only reorders, so it cannot empty the results - the right tool for a preference. |
| `--start-date <YYYY-MM-DD>` | - | **[advanced]** Only results published on or after this date. The option most likely to return nothing by accident. |
| `--end-date <YYYY-MM-DD>` | - | **[advanced]** Only results published on or before this date. |
| `--country <code>` | - | **[advanced]** ISO 3166-1 alpha-2, e.g. `GB`. Biases web results away from the best global match. |

Scope values are checked against the live catalog (and the datasets your plan lists) before the search runs, because one unknown value fails the whole search upstream. A bare name such as `pubmed` is **not** rewritten into an id; it is rejected with suggestions (`did you mean: valyu/valyu-pubmed?`).

## Writing the query

- One short question or focused phrase, 3-12 words, around the most distinctive term.
- No keyword stuffing: `"creatine supplementation hair loss alopecia androgenetic effects"` returns generic hair-loss papers with the rare term dropped; `"creatine hair loss evidence"` does not.
- One topic per call. Two clean searches beat one stuffed one.
- No `site:`, quotes, AND/OR, and no year. Sites go in `--include-source`, windows in `--start-date`.
- For the newest value of a data series, say "latest" and pass no dates: a monthly or quarterly figure is stamped at the **start** of its period.
- SEC filings are indexed by section: name the company, form and item (`"Apple 10-K Item 1A risk factors"`).

## Output (JSON)

```json
{
  "success": true,
  "tx_id": "tx_...",
  "query": "GLP-1 receptor agonists cardiovascular outcomes",
  "results": [
    {
      "title": "The benefits of GLP1 receptors in cardiovascular diseases",
      "url": "https://pubmed.ncbi.nlm.nih.gov/PMC10739421",
      "content": "## Introduction\nDespite major advance in treatment...",
      "source": "valyu/valyu-pubmed",
      "relevance_score": 0.94,
      "publication_date": "2023-12-08",
      "authors": ["Lamija Ferhatbegović", "Denis Mršić"],
      "doi": "10.3389/fcdhc.2023.1293926",
      "pmid": "38143794",
      "citation_count": 110
    }
  ],
  "results_by_source": { "web": 3, "proprietary": 7 },
  "total_deduction_dollars": 0.004,
  "hint": "Only present when the results need explaining - see below."
}
```

Fields vary by corpus. SEC filings carry `metadata` with the ticker, CIK, accession number, form type, item and `chunk_index`, and that is the only place their filing date appears. Results sharing a URL are sequential chunks of one document, not duplicates. `image_url` holds figure links where a corpus extracts them (presigned, valid about an hour).

### `hint`

Added only when there is something to act on:

| Situation | What to do |
|---|---|
| A backend failed (no or partial results) | Retry in a few seconds. Rewording will not help. Do not fill the gap from memory. |
| Nothing matched | Shorten the query; if you scoped, drop `--include-source` / dates. |
| Results matched but carry no data | Almost always a date filter on a structured dataset. Drop the dates, ask for "latest". Do not infer values from the titles. |
| Results were trimmed to `--response-length` | Raise it, or `valyu contents <url>` for an open-web page. Paywalled corpus documents are only reachable through search: re-search with the document's title and section. |
| A scoped dataset is outside the plan | It was likely skipped; the results cover the rest. |

## Examples

```bash
# The default: web + every dataset, routed automatically
valyu search "current state of nuclear fusion commercialization"

# Scoped to a dataset the user named (id from `valyu sources`)
valyu search "Apple 10-K Item 1A risk factors" --include-source valyu/valyu-sec-filings

# Scoped to a site
valyu search "rotary position embeddings" --include-source arxiv.org

# A preference, not a requirement
valyu search "quantum error correction review" --source-bias arxiv.org=5 --source-bias reddit.com=-4

# An explicit window the user gave
valyu search "EU AI Act enforcement actions" --start-date 2026-01-01

# More text per result, fewer results
valyu search "transformer attention mechanism survey" -n 5 -l 20000

# Pipelines
echo "latest US CPI inflation" | valyu search -q | jq -r '.results[0].content'
```

## Upgrading from earlier versions

Everything earlier versions accepted still works; it is just no longer in `--help`:

- `valyu search <type> <query>` (`web`, `paper`, `bio`, `finance`, `sec`, `patent`, `economics`, `news`) sends exactly the request it used to - the same fixed scope and default length - and prints a note to stderr. Prefer a plain query, or `--include-source` for a source the user named.
- `--max-price`, `--relevance-threshold`, `--search-type`, `--instructions`, `--fast-mode`, `--url-only` and `--no-tool-call` are passed through as before.
- `--response-length` also takes the named sizes `short`, `medium`, `large` and `max`.

What changed is a plain `valyu search "<query>"`: it used to search the web only, and now covers the web and every dataset on the plan (same price per result), returning up to 4,000 characters per result unless `-l` says otherwise.
