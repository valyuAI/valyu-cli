# valyu contents

Extract clean, structured content from web pages. Handles paywalls and dynamic content.

## Syntax

```
valyu contents <urls...> [options]
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `-s, --summary [instructions]` | - | Generate AI summary (optional custom instructions) |
| `-l, --length <length>` | `medium` | Response length: `short` (25k), `medium` (50k), `large` (100k), `max` |

## Output (JSON)

```json
{
  "results": [
    {
      "title": "Article Title",
      "url": "https://example.com",
      "content": "Full extracted text...",
      "summary": "AI-generated summary (if requested)",
      "length": 12840,
      "data_type": "unstructured"
    }
  ],
  "urls_requested": 1,
  "urls_processed": 1,
  "urls_failed": 0,
  "total_cost": 0.001
}
```

## Examples

```bash
# Extract content from a URL
valyu contents https://techcrunch.com/2026/01/ai-funding-roundup

# Extract with AI summary
valyu contents https://arxiv.org/abs/2501.00001 --summary

# Custom summary instructions
valyu contents https://sec.gov/filing.htm --summary "Extract key risk factors as bullet points"

# Multiple URLs at once (up to 10)
valyu contents https://site1.com https://site2.com https://site3.com

# Full document extraction
valyu contents https://long-report.com --length large

# JSON output for agents
valyu contents https://example.com --summary -q
```

## Agent Tips

- Maximum 10 URLs per request - batch larger lists
- Use `--length large` or `--length max` for academic papers and long-form documents
- `--summary` adds cost but returns a compact summary - use for quick extraction
- Failed URLs return `{"url":"...","error":"..."}` in results, not a top-level error
- `urls_failed > 0` in the response indicates partial failures; check individual results
