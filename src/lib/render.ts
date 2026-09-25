import pc from 'picocolors';
import type { ContentsItem, SearchResultItem } from './client.js';

/**
 * Cut a string body to `max` characters. Only strings are cut: structured
 * records (market data, filings metadata) come back whole.
 */
export function clipText(content: unknown, max: number): { content: unknown; clipped: boolean } {
  if (typeof content !== 'string' || content.length <= max) return { content, clipped: false };
  return { content: `${content.slice(0, Math.max(0, max - 1)).trimEnd()}…`, clipped: true };
}

/**
 * clipText applied to each result's content, with a count of how many were
 * cut. Structured records (a clinical trial, a filing's metadata) often arrive
 * as a JSON string, and cutting one leaves JSON that no longer parses, so they
 * are left whole.
 */
export function clipResults<T extends { content?: unknown; data_type?: string }>(
  results: T[],
  max: number,
): { results: T[]; clipped: number } {
  let clipped = 0;
  const out = results.map((r) => {
    if (r.data_type === 'structured') return r;
    const c = clipText(r.content, max);
    if (!c.clipped) return r;
    clipped++;
    return { ...r, content: c.content };
  });
  return { results: out, clipped };
}

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

function formatCost(cost?: number): string {
  if (cost == null) return '';
  return `$${cost.toFixed(4)}`;
}

// ANSI OSC 8 hyperlink - makes text clickable in modern terminals
function hyperlink(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

function formatDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function printHint(hint: string | undefined): void {
  if (!hint) return;
  for (const para of hint.split('\n\n')) {
    console.log(`  ${pc.yellow('!')} ${para}`);
  }
  console.log('');
}

export function renderSearchResults(
  results: SearchResultItem[],
  opts: { query: string; cost?: number; hint?: string; quiet?: boolean },
): void {
  if (opts.quiet) return;

  const costStr = formatCost(opts.cost);
  const countStr = `${results.length} result${results.length !== 1 ? 's' : ''}`;

  console.log('');
  console.log(
    `  ${pc.cyan(pc.bold('Search'))}  ${pc.dim('"' + opts.query + '"')}  ${pc.dim('·')}  ${pc.dim(countStr)}${costStr ? `  ${pc.dim('·')}  ${pc.dim(costStr)}` : ''}`,
  );
  console.log(`  ${pc.dim('─'.repeat(60))}`);
  console.log('');

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const num = pc.dim(`${String(i + 1).padStart(2)}.`);
    const titleText = r.title || 'Untitled';
    const title = r.url ? hyperlink(r.url, pc.bold(titleText)) : pc.bold(titleText);
    const meta = [
      r.url ? formatDomain(r.url) : '',
      r.source && r.source !== 'web' ? r.source : '',
      r.publication_date ? r.publication_date.slice(0, 10) : '',
    ].filter(Boolean);
    const score = r.relevance_score != null ? pc.green(`${(r.relevance_score * 100).toFixed(0)}%`) : '';
    const snippet = truncate(contentToString(r.content ?? r.description), 400);

    console.log(`  ${num} ${title}`);
    console.log(`      ${pc.dim(meta.join(' · '))}${score ? `  ${score}` : ''}`);
    if (snippet) console.log(`      ${pc.dim(snippet)}`);
    console.log('');
  }

  printHint(opts.hint);
}

export function renderContents(
  items: ContentsItem[],
  opts: { cost?: number; hint?: string; quiet?: boolean },
): void {
  if (opts.quiet) return;

  console.log('');
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    console.log(`  ${pc.dim(`${i + 1}.`)} ${pc.bold(item.title || item.url)}`);
    console.log(`     ${pc.dim(pc.underline(item.url))}`);

    if (item.error) {
      console.log(`     ${pc.red('Failed:')} ${item.error}`);
      console.log('');
      continue;
    }
    if (item.screenshot_url) console.log(`     ${pc.dim('Screenshot:')} ${item.screenshot_url}`);

    const summary = contentToString(item.summary);
    if (summary) {
      console.log('');
      console.log(summary);
    } else if (item.content != null) {
      console.log('');
      console.log(contentToString(item.content));
    }
    console.log('');
    console.log(`  ${pc.dim('─'.repeat(60))}`);
  }

  if (opts.cost != null) {
    console.log(`  ${pc.dim('Cost: ' + formatCost(opts.cost))}`);
    console.log('');
  }
  printHint(opts.hint);
}
