# valyu search

Search across 8 specialized data sources with a single command.

## Syntax

```
valyu search <type> <query> [options]
```

## Search Types

| Type | Sources | Best for |
|------|---------|---------|
| `web` | General web index | News, blogs, product pages, general knowledge |
| `paper` | arXiv, PubMed, bioRxiv, medRxiv | Academic research, scientific papers |
| `bio` | PubMed, clinical trials, drug labels, FDA | Biomedical research, drug info, clinical data |
| `finance` | Stock prices, earnings, SEC, insider trading | Financial analysis, company data |
| `sec` | SEC EDGAR 10-K, 10-Q, 8-K filings | Regulatory filings, risk factors, financials |
| `patent` | Global patent databases | Prior art, patent landscapes, IP research |
| `economics` | BLS, FRED, World Bank | Economic indicators, labor data, macro |
| `news` | News sources | Breaking news, recent events |

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `-n, --limit <number>` | 10 | Number of results to return |
| `--max-price <number>` | - | Maximum cost cap in USD |

## Output (JSON)

```json
{
  "results": [
    {
      "title": "Article Title",
      "url": "https://example.com",
      "content": "Full extracted content...",
      "source": "web",
      "relevance_score": 0.94
    }
  ],
  "total_results": 10,
  "search_type": "web",
  "query": "the query",
  "cost": 0.025
}
```

## Examples

```bash
# General web search
valyu search web "Anthropic Claude 4 release" --limit 10

# Academic papers on a topic
valyu search paper "large language model reasoning benchmarks 2025" --limit 20

# Biomedical research
valyu search bio "GLP-1 receptor agonist obesity clinical trials 2024"

# Financial data
valyu search finance "Microsoft Azure revenue growth Q4 2024"

# SEC filings
valyu search sec "Apple 10-K 2024 risk factors competitive"

# Patent search
valyu search patent "CRISPR base editing Broad Institute" --limit 15

# Economic data
valyu search economics "US unemployment rate 2024 Federal Reserve"

# News
valyu search news "AI regulation EU Act implementation" --limit 20
```

## Agent Tips

- Use `-q` for clean JSON output in pipelines
- `relevance_score` ranges 0-1; filter at >0.7 for high quality
- For multi-source research, run parallel searches: web + paper simultaneously
- `sec` type is best for specific company filings; `finance` for market data
- `bio` is broader than `paper` - includes clinical trials and drug labels
