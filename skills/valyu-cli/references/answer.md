# valyu answer

Get an AI-synthesized answer to a question, backed by real-time search.

## Syntax

```
valyu answer <query> [options]
```

## Options

| Flag | Description |
|------|-------------|
| `--fast` | Use fast mode: lower latency, web sources prioritized |

## Output (JSON)

```json
{
  "answer": "Markdown-formatted answer text...",
  "sources": [
    { "title": "Source Title", "url": "https://example.com" }
  ],
  "data_type": "unstructured",
  "cost": 0.032
}
```

## Examples

```bash
# General knowledge question
valyu answer "What are the key differences between GPT-4 and Claude 3.5?"

# Fast mode for time-sensitive queries
valyu answer "Current Federal Reserve interest rate" --fast

# Technical question
valyu answer "How does attention mechanism work in transformer models?"

# Market/financial question
valyu answer "What was Nvidia's revenue growth in FY2025?"

# Research summary
valyu answer "Summarize recent advances in protein folding prediction"
```

## Agent Tips

- `answer` uses LLM synthesis on top of search - costs more than `search` but returns a direct answer
- For structured data extraction, use `search` + parse `content` fields
- Use `--fast` when the question is about current/recent information (finance, news)
- The `answer` field is markdown - render it appropriately for the user
- `sources` array can be used to cite references
