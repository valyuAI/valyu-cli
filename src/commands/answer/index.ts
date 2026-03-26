import { Command } from '@commander-js/extra-typings';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import pc from 'picocolors';
import type { GlobalOpts } from '../../lib/client.js';
import { ValyuClient, requireApiKey } from '../../lib/client.js';
import { outputError, outputResult } from '../../lib/output.js';
import { createSpinner } from '../../lib/spinner.js';
import { readStdin } from '../../lib/stdin.js';
import { isInteractive } from '../../lib/tty.js';

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
  .option('--fast', 'Use fast mode (lower latency)')
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.dim('$ valyu answer "What are the latest AI research breakthroughs?"')}
  ${pc.dim('$ valyu answer "Current Bitcoin price and market trends" --fast')}
  ${pc.dim('$ valyu answer "Summarize TSLA Q4 2024 earnings" --json')}
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

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);

    // Non-streaming JSON mode
    if (globalOpts.json || !isInteractive()) {
      const spinner = createSpinner('Getting answer...', globalOpts.quiet);
      let fullContent = '';
      let cost: number | undefined;
      let sources: Array<{ title: string; url: string }> = [];

      for await (const chunk of client.streamAnswer({ query, fastMode: opts.fast })) {
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

    for await (const chunk of client.streamAnswer({ query, fastMode: opts.fast })) {
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
