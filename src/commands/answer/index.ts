import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { GlobalOpts } from '../../lib/client.js';
import { ValyuClient, requireApiKey } from '../../lib/client.js';
import { outputError, outputResult } from '../../lib/output.js';
import { createSpinner } from '../../lib/spinner.js';
import { isInteractive } from '../../lib/tty.js';

export const answerCommand = new Command('answer')
  .description('Get an AI-powered answer with real-time search (streams)')
  .argument('<query>', 'Question to answer')
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
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);

    // Non-streaming JSON mode - collect everything then output
    if (globalOpts.json || !isInteractive()) {
      const spinner = createSpinner('Getting answer...', globalOpts.quiet);
      let fullContent = '';
      let cost: number | undefined;
      let sources: Array<{ title: string; url: string }> = [];

      for await (const chunk of client.streamAnswer({ query, fastMode: opts.fast })) {
        if (chunk.type === 'error') {
          spinner.fail('Failed to get answer');
          outputError({ message: chunk.error, code: 'answer_failed' }, { json: globalOpts.json });
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

    // Streaming TTY mode - write content as it arrives
    const spinner = createSpinner('Searching...', globalOpts.quiet);
    let started = false;
    let cost: number | undefined;

    for await (const chunk of client.streamAnswer({ query, fastMode: opts.fast })) {
      if (chunk.type === 'error') {
        spinner.fail('Failed to get answer');
        outputError({ message: chunk.error, code: 'answer_failed' }, { json: false });
      }

      if (chunk.type === 'search_results' && !started) {
        spinner.stop(`Found ${chunk.searchResults.length} sources`);
        process.stdout.write('\n');
        started = true;
      }

      if (chunk.type === 'content') {
        if (!started) {
          spinner.stop('');
          process.stdout.write('\n');
          started = true;
        }
        process.stdout.write(chunk.content);
      }

      if (chunk.type === 'metadata') {
        cost = chunk.cost;
        if (!started && chunk.contents) {
          spinner.stop('');
          process.stdout.write('\n' + chunk.contents);
          started = true;
        }
      }
    }

    if (cost != null) {
      process.stdout.write(`\n\n${pc.dim('Cost: $' + cost.toFixed(4))}\n`);
    } else {
      process.stdout.write('\n');
    }
  });
