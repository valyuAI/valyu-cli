import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import { loginCommand } from './commands/auth/login.js';
import { logoutCommand } from './commands/auth/logout.js';
import { searchCommand } from './commands/search/index.js';
import { answerCommand } from './commands/answer/index.js';
import { contentsCommand } from './commands/contents/index.js';
import { deepresearchCommand } from './commands/deepresearch/index.js';
import { workflowsCommand } from './commands/workflows/index.js';
import { batchCommand } from './commands/batch/index.js';
import { whoamiCommand } from './commands/whoami.js';
import { doctorCommand } from './commands/doctor.js';
import { openCommand } from './commands/open.js';
import { upgradeCommand } from './commands/upgrade.js';
import { sourcesCommand } from './commands/sources/index.js';
import { printBanner } from './lib/logo.js';
import { errorMessage, outputError } from './lib/output.js';
import { checkForUpdates } from './lib/update-check.js';
import { PACKAGE_NAME, VERSION } from './lib/version.js';

const program = new Command()
  .name('valyu')
  .description('The search CLI for knowledge workers — web, papers, filings, patents, financial data')
  .configureHelp({
    showGlobalOptions: true,
    styleTitle: (str) => pc.dim(str),
  })
  .configureOutput({
    writeErr: (str) => {
      process.stderr.write(str.replace(/^error:/, () => pc.red('error:')));
    },
  })
  .version(`${PACKAGE_NAME} v${VERSION}`, '-v, --version', 'Output the current version')
  .option('--api-key <key>', 'Valyu API key (overrides env/config)')
  .option('-p, --profile <name>', 'Profile to use (overrides VALYU_PROFILE)')
  .option('--json', 'Force JSON output')
  .option('-q, --quiet', 'Suppress spinners and status output (implies --json)')
  .hook('preAction', (thisCommand, actionCommand) => {
    if (actionCommand.optsWithGlobals().quiet) {
      thisCommand.setOptionValue('json', true);
    }
  })
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

- Authenticate

  ${pc.cyan('$ valyu login')}

- Search for recent AI research papers

  ${pc.cyan('$ valyu search "agentic AI systems"')}
  ${pc.cyan('$ valyu search paper "transformer attention mechanisms" -n 15')}

- Get an AI-powered answer

  ${pc.cyan('$ valyu answer "What is the current state of CRISPR therapeutics?"')}

- Extract content from a URL

  ${pc.cyan('$ valyu contents https://example.com --summary')}

- Start deep research

  ${pc.cyan('$ valyu deepresearch create "Global AI infrastructure investment trends" --watch')}

- Run a workflow (reusable research template)

  ${pc.cyan('$ valyu workflows list --scope valyu')}
  ${pc.cyan('$ valyu workflows run ib-company-profile --param company="NVIDIA (NVDA)" --watch')}
`,
  )
  .action(() => {
    if (process.stdout.isTTY) {
      printBanner();
    }
    const opts = program.opts();
    if (opts.apiKey) {
      outputError(
        {
          message:
            '--api-key is a per-command override and was not saved. Run `valyu login` to store your key.',
          code: 'missing_command',
        },
        { json: opts.json },
      );
    }
    program.help();
  })
  .addCommand(loginCommand)
  .addCommand(logoutCommand)
  .addCommand(searchCommand)
  .addCommand(answerCommand)
  .addCommand(contentsCommand)
  .addCommand(deepresearchCommand)
  .addCommand(workflowsCommand)
  .addCommand(batchCommand)
  .addCommand(sourcesCommand)
  .addCommand(whoamiCommand)
  .addCommand(doctorCommand)
  .addCommand(openCommand)
  .addCommand(upgradeCommand);

program
  .parseAsync()
  .then(() => {
    const ran = program.args[0];
    if (ran === 'login' || ran === 'logout' || ran === 'upgrade') return;
    return checkForUpdates().catch(() => {});
  })
  .catch((err) => {
    outputError({
      message: errorMessage(err, 'An unexpected error occurred'),
      code: 'unexpected_error',
    });
  });
