import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from '@commander-js/extra-typings';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import pc from 'picocolors';
import type { GlobalOpts } from '../../lib/client.js';
import { ValyuClient, requireApiKey } from '../../lib/client.js';
import { outputError, outputResult } from '../../lib/output.js';
import { parseSourceBiases } from '../../lib/parsers.js';
import { createSpinner } from '../../lib/spinner.js';
import { readStdin } from '../../lib/stdin.js';
import { isInteractive } from '../../lib/tty.js';

const ANSWER_SEARCH_TYPES = ['all', 'web', 'proprietary', 'news'] as const;
const collect = (v: string, prev: string[] = []): string[] => [...prev, v];

let markedConfigured = false;

/**
 * Strip markdown links from answer text, replace with numbered citations,
 * and collect unique sources.
 */
function processAnswer(raw: string): { text: string; sources: Array<{ title: string; url: string }> } {
  const sources: Array<{ title: string; url: string }> = [];
  const seen = new Map<string, number>();

  // Replace [Title](url) with [n] and collect sources
  let text = raw.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, title, url) => {
    let idx = seen.get(url);
    if (idx === undefined) {
      idx = sources.length + 1;
      sources.push({ title, url });
      seen.set(url, idx);
    }
    return `[${idx}]`;
  });

  // Clean up wrapping parens from (([n])) patterns left behind
  text = text.replace(/\(\[(\d+)\]\)/g, '[$1]');

  return { text, sources };
}

function formatDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
}

export const answerCommand = new Command('answer')
  .description('Get an AI-powered answer with real-time search (streams)')
  .argument('[query]', 'Question to answer')
  .option('--fast', '[advanced] Fast mode for lower latency (skips reranker, web-only, lower quality)')
  .option('--system-instructions <text>', 'Replace the default system prompt (max 2000 chars)')
  .option('--structured <json>', 'JSON schema for structured answer (inline JSON string)')
  .option('--structured-file <path>', 'JSON schema for structured answer (file)')
  .option('--search-type <type>', `[advanced] Search scope override: ${ANSWER_SEARCH_TYPES.join(', ')}`)
  .option('--include-source <src>', '[advanced] Source to include (repeatable). Usually better to let the router pick', collect, [] as string[])
  .option('--exclude-source <src>', '[advanced] Source to exclude (repeatable)', collect, [] as string[])
  .option('--source-bias <kv>', '[advanced] Bias a source by domain (repeatable). Format: <source>=<int> where int is -5..+5', collect, [] as string[])
  .option('--country <code>', '[advanced] ISO 3166-1 alpha-2 country code for geo-targeted web search')
  .option('--start-date <date>', 'Earliest publication date (YYYY-MM-DD)')
  .option('--end-date <date>', 'Latest publication date (YYYY-MM-DD)')
  .option('--data-max-price <number>', 'Max budget in USD for the search portion (default 1.0)')
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.dim('$ valyu answer "What are the latest AI research breakthroughs?"')}
  ${pc.dim('$ valyu answer "Current Bitcoin price and market trends" --fast')}
  ${pc.dim('$ valyu answer "Summarize NVDA Q4 earnings" --json')}
  ${pc.dim('$ valyu answer "Top 5 EVs by range and price" --structured-file schema.json')}
  ${pc.dim('$ valyu answer "SEC enforcement actions against crypto exchanges" \\\\')}
  ${pc.dim('    --start-date 2024-01-01 \\\\')}
  ${pc.dim('    --system-instructions "You are a regulatory analyst. Focus on penalties."')}
`,
  )
  .action(async (query, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;

    // Stdin fallback when no positional arg provided
    if (!query) {
      const stdinData = await readStdin();
      if (stdinData) {
        query = stdinData;
      } else {
        outputError(
          {
            message: `No query provided.\n\n  Usage: valyu answer "your question"\n         echo "your question" | valyu answer`,
            code: 'missing_query',
          },
          { json: globalOpts.json },
        );
        return;
      }
    }

    const fail = (message: string, code: string) =>
      outputError({ message, code }, { json: globalOpts.json });

    if (opts.structured && opts.structuredFile) {
      fail('Use --structured or --structured-file, not both', 'invalid_options');
      return;
    }
    if (opts.searchType && !ANSWER_SEARCH_TYPES.includes(opts.searchType as (typeof ANSWER_SEARCH_TYPES)[number])) {
      fail(`Invalid --search-type '${opts.searchType}'. Valid: ${ANSWER_SEARCH_TYPES.join(', ')}`, 'invalid_option');
      return;
    }

    let structuredOutput: Record<string, unknown> | undefined;
    if (opts.structuredFile) {
      try {
        structuredOutput = JSON.parse(readFileSync(resolve(opts.structuredFile), 'utf-8'));
      } catch (err) {
        fail(
          err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? `File not found: ${opts.structuredFile}`
            : `Invalid JSON in ${opts.structuredFile}`,
          'invalid_schema',
        );
        return;
      }
    } else if (opts.structured) {
      try {
        structuredOutput = JSON.parse(opts.structured);
      } catch {
        fail('Invalid JSON for --structured schema. Tip: use --structured-file to read from a file.', 'invalid_schema');
        return;
      }
    }

    let sourceBiases: Record<string, number> | undefined;
    if (opts.sourceBias.length > 0) {
      try {
        sourceBiases = parseSourceBiases(opts.sourceBias);
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Invalid --source-bias', 'invalid_option');
        return;
      }
    }

    const dataMaxPrice = opts.dataMaxPrice != null ? parseFloat(opts.dataMaxPrice) : undefined;
    if (dataMaxPrice != null && (!Number.isFinite(dataMaxPrice) || dataMaxPrice <= 0)) {
      fail('--data-max-price must be a positive number', 'invalid_option');
      return;
    }

    const answerParams = {
      query,
      fastMode: opts.fast,
      searchType: opts.searchType,
      includedSources: opts.includeSource.length > 0 ? opts.includeSource : undefined,
      excludedSources: opts.excludeSource.length > 0 ? opts.excludeSource : undefined,
      sourceBiases,
      countryCode: opts.country,
      startDate: opts.startDate,
      endDate: opts.endDate,
      dataMaxPrice,
      structuredOutput,
      systemInstructions: opts.systemInstructions,
    };

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);

    // Non-streaming JSON mode
    if (globalOpts.json || !isInteractive()) {
      const spinner = createSpinner('Getting answer...', globalOpts.quiet);
      let fullContent = '';
      let cost: number | undefined;
      let sources: Array<{ title: string; url: string }> = [];

      for await (const chunk of client.streamAnswer(answerParams)) {
        if (chunk.type === 'error') {
          spinner.fail('Failed to get answer');
          outputError({ message: chunk.error, code: 'answer_failed' }, { json: globalOpts.json });
          return;
        }
        if (chunk.type === 'search_results') sources = chunk.searchResults;
        if (chunk.type === 'content') fullContent += chunk.content;
        if (chunk.type === 'metadata') {
          cost = chunk.cost;
          if (!fullContent && chunk.contents) fullContent = chunk.contents;
        }
      }

      spinner.stop('Answer ready');
      outputResult({ answer: fullContent, sources, cost }, { json: true });
      return;
    }

    // Streaming TTY mode - buffer content, render clean output at end
    const spinner = createSpinner('Searching...', globalOpts.quiet);
    let content = '';
    let cost: number | undefined;
    let sourceCount = 0;

    for await (const chunk of client.streamAnswer(answerParams)) {
      if (chunk.type === 'error') {
        spinner.fail('Failed to get answer');
        outputError({ message: chunk.error, code: 'answer_failed' }, { json: false });
        return;
      }

      if (chunk.type === 'search_results') {
        sourceCount = chunk.searchResults.length;
        spinner.update(`Found ${sourceCount} sources, generating answer...`);
      }

      if (chunk.type === 'content') {
        content += chunk.content;
      }

      if (chunk.type === 'metadata') {
        cost = chunk.cost;
        if (!content && chunk.contents) content = chunk.contents;
      }
    }

    if (!content) {
      spinner.fail('No answer received');
      return;
    }

    spinner.stop(`Found ${sourceCount} sources`);

    // Process markdown links into numbered citations BEFORE marked rendering
    const { text, sources } = processAnswer(content);

    // Configure marked with terminal renderer at render time (captures current terminal width)
    if (!markedConfigured) {
      marked.use(markedTerminal({ width: Math.min(process.stdout.columns || 80, 100) }) as any);
      markedConfigured = true;
    }

    // Render answer through marked-terminal
    const rendered = marked(text) as string;
    process.stdout.write(`\n${rendered}`);

    // Render sources
    if (sources.length > 0) {
      process.stdout.write(`\n  ${pc.dim('Sources:')}\n`);
      for (let i = 0; i < sources.length; i++) {
        const s = sources[i];
        const domain = formatDomain(s.url);
        process.stdout.write(
          `  ${pc.cyan(`[${i + 1}]`)} ${pc.bold(s.title)}  ${pc.dim(domain)}\n`,
        );
      }
    }

    // Cost
    if (cost != null) {
      process.stdout.write(`\n  ${pc.dim(`Cost: $${cost.toFixed(4)}`)}\n`);
    }
    process.stdout.write('\n');
  });
