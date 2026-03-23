import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type { GlobalOpts } from '../lib/client.js';
import { PLATFORM_URL, DOCS_URL } from '../lib/client.js';
import { openInBrowser } from '../lib/browser.js';
import { outputError } from '../lib/output.js';

const TARGETS: Record<string, { url: string; label: string }> = {
  platform: { url: PLATFORM_URL, label: 'Valyu Platform' },
  docs: { url: DOCS_URL, label: 'Valyu Docs' },
  keys: { url: `${PLATFORM_URL}/keys`, label: 'API Keys' },
  usage: { url: `${PLATFORM_URL}/usage`, label: 'Usage Dashboard' },
};

export const openCommand = new Command('open')
  .description('Open Valyu in the browser')
  .argument('[target]', `Where to open: ${Object.keys(TARGETS).join(', ')} (default: platform)`, 'platform')
  .addHelpText(
    'after',
    `
${pc.dim('Targets:')}

${Object.entries(TARGETS).map(([k, v]) => `  ${pc.cyan(k.padEnd(12))} ${v.url}`).join('\n')}
`,
  )
  .action(async (target, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;

    const t = TARGETS[target];
    if (!t) {
      outputError(
        {
          message: `Unknown target '${target}'. Must be one of: ${Object.keys(TARGETS).join(', ')}`,
          code: 'invalid_target',
        },
        { json: globalOpts.json },
      );
    }

    const opened = await openInBrowser(t.url);
    if (!opened) {
      console.log(`  ${t.label}: ${pc.underline(t.url)}`);
    }
  });
