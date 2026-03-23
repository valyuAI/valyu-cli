import { marked } from 'marked';
import pc from 'picocolors';
import type { SearchResultItem, AnswerResult, ContentsItem, ResearchStatus } from './client.js';

// Safely convert any content type to a display string
function contentToString(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number') return String(content);
  if (Array.isArray(content)) {
    // Format arrays of objects as compact key: value lines
    return content
      .slice(0, 3)
      .map((item) =>
        typeof item === 'object' && item !== null
          ? Object.entries(item as Record<string, unknown>)
              .filter(([, v]) => v !== null && v !== undefined)
              .slice(0, 4)
              .map(([k, v]) => `${k}: ${v}`)
              .join(' | ')
          : String(item),
      )
      .join('\n     ') + (content.length > 3 ? `\n     … (${content.length - 3} more)` : '');
  }
  if (typeof content === 'object') {
    return Object.entries(content as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined)
      .slice(0, 5)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' | ');
  }
  return String(content);
}

// Truncate text to a max length with ellipsis
function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 3) + '...';
}

// Format a cost value
function formatCost(cost?: number): string {
  if (cost == null) return '';
  return `$${cost.toFixed(4)}`;
}

// Render search type label with color
const SEARCH_TYPE_LABELS: Record<string, string> = {
  web: 'Web',
  paper: 'Academic',
  bio: 'Biomedical',
  finance: 'Finance',
  sec: 'SEC Filings',
  patent: 'Patents',
  economics: 'Economics',
  news: 'News',
};

export function renderSearchResults(
  results: SearchResultItem[],
  opts: { query: string; searchType: string; cost?: number; quiet?: boolean },
): void {
  if (opts.quiet) return;

  const typeLabel = SEARCH_TYPE_LABELS[opts.searchType] ?? opts.searchType;
  const costStr = formatCost(opts.cost);

  console.log('');
  console.log(
    `  ${pc.cyan(pc.bold(typeLabel + ' Search'))}  ${pc.dim('"' + opts.query + '"')}  ${costStr ? pc.dim('· ' + costStr) : ''}`,
  );
  console.log(`  ${pc.dim('─'.repeat(60))}`);
  console.log('');

  if (results.length === 0) {
    console.log(`  ${pc.dim('No results found.')}`);
    console.log('');
    return;
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const num = pc.dim(`${i + 1}.`);
    const title = pc.bold(r.title || 'Untitled');
    const url = pc.dim(pc.underline(r.url));
    const snippet = truncate(contentToString(r.content), 200);
    const score =
      r.relevance_score != null ? pc.dim(` · ${(r.relevance_score * 100).toFixed(0)}%`) : '';

    console.log(`  ${num} ${title}${score}`);
    console.log(`     ${url}`);
    if (snippet) {
      console.log(`     ${pc.dim(snippet)}`);
    }
    console.log('');
  }
}

export function renderAnswer(result: AnswerResult, opts: { quiet?: boolean }): void {
  if (opts.quiet) return;

  const text = result.answer ?? result.output ?? '';
  console.log('');

  // Try to render markdown if marked-terminal is available
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TerminalRenderer = require('marked-terminal');
    marked.use({ renderer: new TerminalRenderer({ width: process.stdout.columns || 80 }) });
    const rendered = marked(text) as string;
    process.stdout.write(rendered);
  } catch {
    console.log(text);
  }

  if (result.sources && result.sources.length > 0) {
    console.log('');
    console.log(`  ${pc.dim('Sources:')}`);
    for (const src of result.sources.slice(0, 5)) {
      console.log(`  ${pc.dim('·')} ${pc.dim(src.title)} ${pc.dim(src.url)}`);
    }
  }

  if (result.total_deduction_dollars != null) {
    console.log('');
    console.log(`  ${pc.dim('Cost: ' + formatCost(result.total_deduction_dollars))}`);
  }

  console.log('');
}

export function renderContents(items: ContentsItem[], opts: { quiet?: boolean }): void {
  if (opts.quiet) return;

  for (const item of items) {
    if (item.error) {
      console.log(`  ${pc.red('Failed:')} ${item.url} - ${item.error}`);
      continue;
    }

    console.log('');
    if (item.title) console.log(`  ${pc.bold(item.title)}`);
    console.log(`  ${pc.dim(pc.underline(item.url))}`);
    if (item.length) console.log(`  ${pc.dim(`${item.length.toLocaleString()} chars`)}`);
    console.log('');

    if (item.summary) {
      console.log(item.summary);
    } else if (item.content) {
      console.log(truncate(item.content, 500));
    }
    console.log('');
    console.log(`  ${pc.dim('─'.repeat(60))}`);
  }
  console.log('');
}

export function renderResearch(status: ResearchStatus, opts: { quiet?: boolean }): void {
  if (opts.quiet) return;

  if (status.status !== 'completed') {
    console.log('');
    const statusColor =
      status.status === 'failed'
        ? pc.red(status.status)
        : status.status === 'running'
          ? pc.yellow(status.status)
          : pc.dim(status.status);
    console.log(`  Status: ${statusColor}`);

    if (status.progress) {
      const pct = Math.round((status.progress.current_step / status.progress.total_steps) * 100);
      const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
      console.log(`  ${pc.cyan(bar)} ${pct}%`);
    }
    console.log('');
    return;
  }

  // Render completed research
  const queryText = status.query ?? status.input ?? '';
  console.log('');
  console.log(`  ${pc.cyan(pc.bold('Deep Research'))}  ${pc.dim('"' + queryText + '"')}`);
  console.log(`  ${pc.dim('─'.repeat(60))}`);
  console.log('');

  if (status.output) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const TerminalRenderer = require('marked-terminal');
      marked.use({ renderer: new TerminalRenderer({ width: process.stdout.columns || 80 }) });
      const rendered = marked(status.output) as string;
      process.stdout.write(rendered);
    } catch {
      console.log(status.output);
    }
  }

  if (status.sources && status.sources.length > 0) {
    console.log('');
    console.log(`  ${pc.dim(`Sources (${status.sources.length}):`)}`);
    for (const src of status.sources.slice(0, 8)) {
      console.log(`  ${pc.dim('·')} ${pc.dim(src.title)} ${pc.dim(src.url)}`);
    }
  }

  if (status.pdf_url) {
    console.log('');
    console.log(`  ${pc.dim('PDF:')} ${pc.underline(status.pdf_url)}`);
  }

  if (status.usage) {
    console.log('');
    console.log(
      `  ${pc.dim('Cost: ' + formatCost(status.usage.total_cost) + ' (search: ' + formatCost(status.usage.search_cost) + ', ai: ' + formatCost(status.usage.ai_cost) + ')')}`,
    );
  }

  console.log('');
}
