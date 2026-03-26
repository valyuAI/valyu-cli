import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
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
      .join('\n     ') + (content.length > 3 ? `\n     ... (${content.length - 3} more)` : '');
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

// Strip markdown artifacts from content preview
function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, '')       // headers
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1')     // italic
    .replace(/__([^_]+)__/g, '$1')     // bold alt
    .replace(/_([^_]+)_/g, '$1')       // italic alt
    .replace(/~~([^~]+)~~/g, '$1')     // strikethrough
    .replace(/`([^`]+)`/g, '$1')       // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // images
    .replace(/^\s*[-*+]\s+/gm, '')    // list markers
    .replace(/^\s*\d+\.\s+/gm, '')    // numbered list markers
    .replace(/>\s+/g, '');             // blockquotes
}

// Truncate text at word boundaries
function truncate(text: string, max: number): string {
  const clean = stripMarkdown(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const truncated = clean.slice(0, max);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > max * 0.6) {
    return truncated.slice(0, lastSpace) + '...';
  }
  return truncated + '...';
}

// Format a cost value
function formatCost(cost?: number): string {
  if (cost == null) return '';
  return `$${cost.toFixed(4)}`;
}

// ANSI OSC 8 hyperlink - makes text clickable in modern terminals
function hyperlink(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

// Format domain from URL
function formatDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
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
  const countStr = `${results.length} result${results.length !== 1 ? 's' : ''}`;

  console.log('');
  console.log(
    `  ${pc.cyan(pc.bold(typeLabel + ' Search'))}  ${pc.dim('"' + opts.query + '"')}  ${pc.dim('·')}  ${pc.dim(countStr)}${costStr ? `  ${pc.dim('·')}  ${pc.dim(costStr)}` : ''}`,
  );
  console.log(`  ${pc.dim('\u2500'.repeat(60))}`);

  if (results.length === 0) {
    console.log('');
    console.log(`  ${pc.dim('No results found.')}`);
    console.log('');
    return;
  }

  console.log('');

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const num = pc.dim(`${String(i + 1).padStart(2)}.`);
    const titleText = r.title || 'Untitled';
    const title = r.url ? hyperlink(r.url, pc.bold(titleText)) : pc.bold(titleText);
    const domain = r.url ? formatDomain(r.url) : '';
    const snippet = truncate(contentToString(r.content), 400);
    const score =
      r.relevance_score != null ? pc.green(`${(r.relevance_score * 100).toFixed(0)}%`) : '';

    console.log(`  ${num} ${title}`);
    console.log(`      ${pc.dim(domain)}${score ? `  ${score}` : ''}`);
    if (snippet) {
      console.log(`      ${pc.dim(snippet)}`);
    }
    console.log('');
  }
}

export function renderAnswer(result: AnswerResult, opts: { quiet?: boolean }): void {
  if (opts.quiet) return;

  const text = result.answer ?? result.output ?? '';
  console.log('');

  // Render markdown to terminal
  marked.use(markedTerminal({ width: process.stdout.columns || 80 }) as any);
  const rendered = marked(text) as string;
  process.stdout.write(rendered);

  if (result.sources && result.sources.length > 0) {
    console.log('');
    console.log(`  ${pc.dim('Sources:')}`);
    for (const src of result.sources.slice(0, 5)) {
      console.log(`  ${pc.dim('\u00b7')} ${pc.dim(src.title)} ${pc.dim(src.url)}`);
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
    console.log(`  ${pc.dim('\u2500'.repeat(60))}`);
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
      const bar = '\u2588'.repeat(Math.floor(pct / 5)) + '\u2591'.repeat(20 - Math.floor(pct / 5));
      console.log(`  ${pc.cyan(bar)} ${pct}%`);
    }
    console.log('');
    return;
  }

  // Render completed research
  const queryText = status.query ?? status.input ?? '';
  console.log('');
  console.log(`  ${pc.cyan(pc.bold('Deep Research'))}  ${pc.dim('"' + queryText + '"')}`);
  console.log(`  ${pc.dim('\u2500'.repeat(60))}`);
  console.log('');

  if (status.output) {
    marked.use(markedTerminal({ width: process.stdout.columns || 80 }) as any);
    const rendered = marked(status.output) as string;
    process.stdout.write(rendered);
  }

  if (status.sources && status.sources.length > 0) {
    console.log('');
    console.log(`  ${pc.dim(`Sources (${status.sources.length}):`)}`);
    for (const src of status.sources.slice(0, 8)) {
      console.log(`  ${pc.dim('\u00b7')} ${pc.dim(src.title)} ${pc.dim(src.url)}`);
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
