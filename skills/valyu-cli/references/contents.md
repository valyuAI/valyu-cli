# valyu contents

Fetch one or more URLs and return clean, readable markdown - the full page text with navigation, ads and boilerplate stripped. Handles paywalls and JavaScript-rendered pages better than a plain fetch.

Use it when you already have a URL: a search result, a link the user pasted, a document to quote accurately. To find pages, use `valyu search`.

## Syntax

```
valyu contents <url>... [options]
cat urls.txt | valyu contents [options]     # whitespace- or newline-separated
```

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `-s, --summary [instructions]` | - | Return a summary instead of the full text. Pass an instruction to say what to extract (`--summary "only the methodology and results"`). Far cheaper in tokens for long documents. |
| `-l, --response-length <chars>` | `30000` | Max characters per page, 500-200000 (~7.5k tokens at the default). For a big document, fetch one URL at a time or use `--summary`. |
| `--extract-effort <effort>` | `auto` | `normal` is fastest; `high` renders JavaScript and succeeds on SPAs and difficult pages; `auto` picks per URL. |
| `--screenshot` | off | Also capture a full-page screenshot of each URL, returned as `screenshot_url` (valid about an hour). Worth it when layout carries meaning: a chart, a dashboard, a rendered table. |

At most 10 URLs per call; each must start with `http://` or `https://`.

## Output (JSON)

```json
{
  "success": true,
  "results": [
    {
      "url": "https://docs.valyu.ai/guides/datasources",
      "title": "Data Sources Catalog | Valyu",
      "content": "# Data Sources\n\nValyu gives one search interface...",
      "summary": "only present with --summary",
      "length": 1444
    }
  ],
  "urls_requested": 1,
  "urls_processed": 1,
  "urls_failed": 0,
  "total_cost_dollars": 0.001,
  "hint": "Only present when something needs acting on"
}
```

A URL that fails comes back as a result with an `error` (e.g. `"Page not found (404)"`), not as a top-level failure. `hint` appears when nothing could be extracted, or when pages were truncated at `--response-length`.

## Examples

```bash
valyu contents https://arxiv.org/abs/2104.09864
valyu contents https://a.com https://b.com --summary "key financial figures only" -q
valyu contents https://dashboard.example.com --extract-effort high --screenshot
valyu search "EU AI Act guidance" -q | jq -r '.results[:3][].url' | valyu contents --summary -q
```

## Upgrading from earlier versions

`-l, --length` with named sizes became `-l, --response-length <chars>`. `--structured`, `--structured-file`, `--async`, `--watch`, `--webhook-url`, `--max-price-dollars` and `valyu contents jobs` were removed; the limit is 10 URLs per call.
