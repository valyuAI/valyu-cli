# valyu sources

Finds the dataset ids you pass to `valyu search --include-source` (and `deepresearch create --include-source`), and shows whether your plan covers each one.

## Syntax

```
valyu sources "<the data you need>"     # best matches, ranked
valyu sources                           # the whole catalog, grouped by category
valyu sources --category <id>           # one category
```

Cheap, and worth running before scoping a search to papers, filings, data series, trials, patents or case law. The ranked view includes each dataset's **example queries** - the phrasing it answers. Structured datasets (economic series, fundamentals, filings metadata) answer plain-language questions and return nothing for the series codes and ticker-style phrasing a model reaches for unprompted: `"CPI inflation data since 2020"` finds the series where `"CPIAUCSL consumer price index all urban consumers"` does not.

Scoping gives precision; an unscoped search (the live web plus every dataset) gives breadth. Listing datasets and then not searching wastes the call: search the top dataset **and** run an unscoped search, then combine.

## Options

| Flag | Description |
|------|-------------|
| `-c, --category <id>` | Only datasets in this category (the listing shows each category's id) |

## Output (JSON)

Ranked:

```json
{
  "query": "peer-reviewed medical literature",
  "match": "semantic",
  "plan": "Serious Business",
  "results": [
    {
      "id": "valyu/valyu-pubmed",
      "name": "PubMed",
      "category": "research",
      "description": "The PubMed dataset is a collection of Open Access papers...",
      "example_queries": ["Latest research on CRISPR gene editing safety", "..."],
      "score": 0.55,
      "locked": false
    }
  ]
}
```

`match` is `semantic` normally and `lexical` if the ranking service is unavailable. A low position means a weak match, not a confirmed fit.

Listing: `{ "plan", "categories": { "<id>": { "name", "description", "count" } }, "datasources": [ ... ] }`. Each datasource carries `id`, `name`, `description`, `category`, `type`, `topics`, `example_queries`, `pricing`, `update_frequency`, `coverage`, `access_modes` and `locked`.

## Plan coverage

`locked: true` marks a dataset outside the current plan. An unscoped search never fails on this - it is restricted to what the plan covers automatically. A locked dataset may still have been granted to your organisation separately; scope a search to it to find out. `plan` and `locked` are omitted when the plan cannot be read. Plans are described at https://www.valyu.ai/pricing.

`valyu sources list` (the earlier form) still works.
