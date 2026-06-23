import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import type {
  GlobalOpts,
  Workflow,
  WorkflowDeliverable,
  WorkflowDetail,
  WorkflowTools,
  WorkflowVariable,
} from '../../lib/client.js';
import { requireApiKey, ValyuClient } from '../../lib/client.js';
import { relTime } from '../../lib/format.js';
import { outputError, outputResult } from '../../lib/output.js';
import { createSpinner } from '../../lib/spinner.js';
import { readStdin } from '../../lib/stdin.js';
import { watchResearch } from '../deepresearch/index.js';

const MODES = ['fast', 'standard', 'heavy', 'max'] as const;
type Mode = (typeof MODES)[number];

const SCOPES = ['valyu', 'org', 'all'] as const;

const SEPARATOR = pc.dim('  ' + '─'.repeat(50));

const collect = (v: string, prev: string[] = []): string[] => [...prev, v];

// Parse repeatable --param key=value pairs. Values are coerced to boolean /
// number when they look like one, matching how the template variables are typed.
// Use --params-file for values that must stay strings or carry punctuation.
function parseParams(pairs: string[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const kv of pairs) {
    const eq = kv.indexOf('=');
    if (eq <= 0) throw new Error(`Invalid --param '${kv}'. Expected format: key=value`);
    const key = kv.slice(0, eq).trim();
    const raw = kv.slice(eq + 1);
    if (!key) throw new Error(`Invalid --param '${kv}'. Empty key.`);
    if (raw === 'true') out[key] = true;
    else if (raw === 'false') out[key] = false;
    else if (raw !== '' && !Number.isNaN(Number(raw))) out[key] = Number(raw);
    else out[key] = raw;
  }
  return out;
}

function readJsonFile<T>(filePath: string, label: string): T {
  try {
    const raw = readFileSync(resolve(filePath), 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw new Error(
      `Invalid JSON in ${label} file ${filePath}: ${err instanceof Error ? err.message : 'parse error'}`,
    );
  }
}

// Merge --param pairs and --params-file (file first, flags override).
async function resolveParams(
  paramPairs: string[],
  paramsFile: string | undefined,
): Promise<Record<string, unknown>> {
  let params: Record<string, unknown> = {};
  if (paramsFile) {
    const raw = paramsFile === '-' ? await readStdin() : undefined;
    const loaded =
      paramsFile === '-'
        ? (JSON.parse(raw || '{}') as unknown)
        : readJsonFile<unknown>(paramsFile, 'params');
    if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
      throw new Error('--params-file must contain a JSON object of { key: value }');
    }
    params = loaded as Record<string, unknown>;
  }
  if (paramPairs.length > 0) {
    params = { ...params, ...parseParams(paramPairs) };
  }
  return params;
}

function scopeLabel(w: { is_valyu: boolean }): string {
  return w.is_valyu ? pc.cyan('valyu') : pc.magenta('org');
}

// ─── list ─────────────────────────────────────────────────────────────────

const listCmd = new Command('list')
  .description('List available workflows (curated Valyu templates + your org)')
  .option('--vertical <vertical>', 'Filter by vertical (e.g. investment-banking, life-sciences)')
  .option('--scope <scope>', `Filter by scope: ${SCOPES.join(', ')} (default: all)`)
  .option('--search <text>', 'Free-text search over title / description')
  .option('--tag <tag>', 'Filter by tag (repeatable)', collect, [] as string[])
  .option('-n, --limit <number>', 'Max results (default 50, max 100)')
  .option('--expand', 'Include template fields (prompt, strategy, report format)')
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.dim('$ valyu workflows list')}
  ${pc.dim('$ valyu workflows list --vertical investment-banking')}
  ${pc.dim('$ valyu workflows list --scope valyu --search "company profile"')}
`,
  )
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const fail = (message: string, code: string) =>
      outputError({ message, code }, { json: globalOpts.json });

    if (opts.scope && !SCOPES.includes(opts.scope as (typeof SCOPES)[number])) {
      fail(`Invalid --scope '${opts.scope}'. Valid: ${SCOPES.join(', ')}`, 'invalid_option');
      return;
    }
    const limit = opts.limit ? Number(opts.limit) : undefined;
    if (limit != null && (!Number.isInteger(limit) || limit < 1)) {
      fail('--limit must be a positive integer', 'invalid_option');
      return;
    }

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Loading workflows...', globalOpts.quiet);

    const { data, error } = await client.listWorkflows({
      vertical: opts.vertical,
      scope: opts.scope,
      query: opts.search,
      tags: opts.tag.length > 0 ? opts.tag : undefined,
      limit,
      expand: opts.expand,
    });

    if (error) {
      spinner.fail('Failed to list workflows');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    const workflows = data?.workflows ?? [];
    spinner.stop(`${workflows.length} workflow${workflows.length === 1 ? '' : 's'}`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(data, { json: true });
      return;
    }

    if (workflows.length === 0) {
      console.log(
        `\n  ${pc.dim('No workflows found. Browse curated templates with:')} valyu workflows list --scope valyu\n`,
      );
      return;
    }

    console.log('');
    for (const w of workflows) {
      const badge = scopeLabel(w);
      const vertical = w.vertical ? pc.dim(w.vertical) : pc.dim('-');
      console.log(`  ${pc.bold(w.slug)}  ${badge}  ${pc.dim(`v${w.version}`)}`);
      console.log(`  ${w.title}`);
      console.log(
        `  ${vertical}  ${pc.dim('·')}  ${pc.dim(w.recommended_mode)}${w.estimated_time ? `  ${pc.dim('·')}  ${pc.dim(w.estimated_time)}` : ''}`,
      );
      console.log('');
    }
    console.log(
      `  ${pc.dim('Inspect:')} valyu workflows get <slug>   ${pc.dim('Run:')} valyu workflows run <slug> --param key=value\n`,
    );
  });

// ─── get ────────────────────────────────────────────────────────────────────

function renderVariables(variables: WorkflowVariable[]): void {
  if (!variables.length) return;
  console.log(`  ${pc.bold('Variables:')}`);
  for (const v of variables) {
    const req = v.required ? pc.red('*') : pc.dim('?');
    const type = pc.dim(`(${v.type ?? 'text'})`);
    console.log(`    ${req} ${pc.cyan(v.key)} ${type}  ${v.label}`);
    if (v.help) console.log(`        ${pc.dim(v.help)}`);
    if (v.validation?.enum?.length) {
      console.log(`        ${pc.dim('one of:')} ${pc.dim(v.validation.enum.join(', '))}`);
    }
  }
  console.log('');
}

function renderDeliverables(deliverables: WorkflowDeliverable[]): void {
  if (!deliverables.length) return;
  console.log(`  ${pc.bold('Deliverables:')}`);
  for (const d of deliverables) {
    console.log(`    ${pc.dim('·')} ${d.type.toUpperCase()}  ${d.description}`);
  }
  console.log('');
}

function renderTools(tools: WorkflowTools | undefined): void {
  if (!tools) return;
  const enabled = Object.entries(tools)
    .filter(([, on]) => on)
    .map(([k]) => k);
  if (!enabled.length) return;
  console.log(`  ${pc.bold('Tools:')}       ${enabled.join(', ')}`);
}

function renderTemplateSection(label: string, text: string | undefined): void {
  if (!text) return;
  console.log('');
  console.log(`  ${pc.bold(label)}`);
  console.log(SEPARATOR);
  for (const line of text.split('\n')) {
    console.log(`  ${pc.dim(line)}`);
  }
}

function renderWorkflowDetail(w: WorkflowDetail): void {
  console.log('');
  console.log(`  ${pc.bold(w.title)}`);
  console.log(`  ${pc.cyan(w.slug)}  ${scopeLabel(w)}  ${pc.dim(`v${w.version}`)}`);
  if (w.subtitle) console.log(`  ${pc.dim(w.subtitle)}`);
  console.log('');
  if (w.vertical) console.log(`  ${pc.bold('Vertical:')}    ${w.vertical}`);
  console.log(`  ${pc.bold('Mode:')}        ${w.recommended_mode}`);
  if (w.estimated_time) console.log(`  ${pc.bold('Est. time:')}   ${w.estimated_time}`);
  if (w.tags?.length) console.log(`  ${pc.bold('Tags:')}        ${pc.dim(w.tags.join(', '))}`);
  renderTools(w.tools);
  if (w.description) {
    console.log('');
    console.log(`  ${w.description}`);
  }
  console.log('');
  renderVariables(w.variables ?? []);
  renderDeliverables(w.deliverables ?? []);
  renderTemplateSection('Prompt', w.prompt);
  renderTemplateSection('Research strategy', w.strategy);
  renderTemplateSection('Report format', w.report_format);
  console.log('');
  const example =
    (w.variables ?? []).find((v) => v.required)?.key ?? (w.variables ?? [])[0]?.key ?? 'key';
  console.log(`  ${pc.dim('Run:')} valyu workflows run ${w.slug} --param ${example}=value\n`);
}

const getCmd = new Command('get')
  .description('Show a workflow template in detail')
  .argument('<slug>', 'Workflow slug')
  .option('--version <number>', 'Specific version (default: current)')
  .action(async (slug, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const version = opts.version ? Number(opts.version) : undefined;
    if (version != null && (!Number.isInteger(version) || version < 1)) {
      outputError(
        { message: '--version must be a positive integer', code: 'invalid_option' },
        { json: globalOpts.json },
      );
      return;
    }
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Loading workflow...', globalOpts.quiet);

    const { data, error } = await client.getWorkflow(slug, version);

    if (error) {
      spinner.fail('Failed to load workflow');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    spinner.stop(`${data!.slug}`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(data, { json: true });
      return;
    }

    renderWorkflowDetail(data!);
  });

// ─── versions ─────────────────────────────────────────────────────────────

const versionsCmd = new Command('versions')
  .description('List the version history of a workflow')
  .argument('<slug>', 'Workflow slug')
  .action(async (slug, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Loading versions...', globalOpts.quiet);

    const { data, error } = await client.listWorkflowVersions(slug);

    if (error) {
      spinner.fail('Failed to load versions');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    const versions = data?.versions ?? [];
    spinner.stop(`${versions.length} version${versions.length === 1 ? '' : 's'}`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(data, { json: true });
      return;
    }

    console.log('');
    console.log(`  ${pc.bold(`Versions of ${slug}`)}`);
    console.log(SEPARATOR);
    for (const v of versions) {
      const marker = v.is_current ? pc.green('✔ current') : pc.dim('  -');
      const changelog = v.changelog ? `  ${v.changelog}` : '';
      console.log(
        `  ${pc.cyan(`v${v.version}`)}  ${marker}  ${pc.dim(v.recommended_mode)}  ${pc.dim(relTime(v.created_at))}${changelog}`,
      );
    }
    console.log('');
  });

// ─── preview ────────────────────────────────────────────────────────────────

const previewCmd = new Command('preview')
  .description('Resolve a workflow template against params without running it (no credits)')
  .argument('<slug>', 'Workflow slug')
  .option(
    '-P, --param <kv>',
    'Template parameter in key=value form (repeatable)',
    collect,
    [] as string[],
  )
  .option('--params-file <path>', 'JSON file of { key: value } params (use "-" for stdin)')
  .option('--version <number>', 'Specific version (default: current)')
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.dim('$ valyu workflows preview ib-company-profile --param company="NVIDIA (NVDA)"')}
  ${pc.dim('$ valyu workflows preview ib-company-profile --params-file params.json')}
`,
  )
  .action(async (slug, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const fail = (message: string, code: string) =>
      outputError({ message, code }, { json: globalOpts.json });

    const version = opts.version ? Number(opts.version) : undefined;
    if (version != null && (!Number.isInteger(version) || version < 1)) {
      fail('--version must be a positive integer', 'invalid_option');
      return;
    }

    let params: Record<string, unknown>;
    try {
      params = await resolveParams(opts.param, opts.paramsFile);
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Invalid params', 'invalid_option');
      return;
    }

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Resolving template...', globalOpts.quiet);

    const { data, error } = await client.previewWorkflow(slug, params, version);

    if (error) {
      spinner.fail('Preview failed');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    spinner.stop('Resolved');

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(data, { json: true });
      return;
    }

    const r = data!.resolved;
    console.log('');
    console.log(
      `  ${pc.bold('Workflow:')}  ${pc.cyan(data!.workflow.slug)} ${pc.dim(`v${data!.workflow.version}`)}`,
    );
    console.log(`  ${pc.bold('Mode:')}      ${r.mode}`);
    renderDeliverables(r.deliverables ?? []);
    renderTemplateSection('Resolved prompt', r.input);
    renderTemplateSection('Research strategy', r.research_strategy);
    renderTemplateSection('Report format', r.report_format);
    console.log('');
    console.log(
      `  ${pc.dim('Run it:')} valyu workflows run ${data!.workflow.slug} ${opts.param.map((p) => `--param ${p}`).join(' ')}\n`,
    );
  });

// ─── run ──────────────────────────────────────────────────────────────────

const runCmd = new Command('run')
  .description('Run a workflow - resolves the template and starts a deep research task')
  .argument('<slug>', 'Workflow slug')
  .option(
    '-P, --param <kv>',
    'Template parameter in key=value form (repeatable)',
    collect,
    [] as string[],
  )
  .option('--params-file <path>', 'JSON file of { key: value } params (use "-" for stdin)')
  .option('--version <number>', 'Pin a workflow version (default: current)')
  .option('-m, --mode <mode>', `Override the template's recommended mode: ${MODES.join(', ')}`)
  .option('-w, --watch', 'Wait for completion and display the result')
  .option('--webhook-url <url>', 'HTTPS URL to receive completion webhook (HMAC-signed)')
  .option(
    '--alert-email <email>',
    'Email to notify on completion (must belong to your organization)',
  )
  .option(
    '--alert-email-url <url>',
    'Custom report link for the alert email. Must include {id} placeholder',
  )
  .addHelpText(
    'after',
    `
${pc.dim('Examples:')}

  ${pc.dim('$ valyu workflows run ib-company-profile --param company="NVIDIA (NVDA)" --watch')}
  ${pc.dim('$ valyu workflows run ib-company-profile -P company="Apple" -m heavy')}
  ${pc.dim('$ valyu workflows run my-org/quarterly-review --params-file params.json --watch')}
`,
  )
  .action(async (slug, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const fail = (message: string, code: string) =>
      outputError({ message, code }, { json: globalOpts.json });

    if (opts.mode && !MODES.includes(opts.mode as Mode)) {
      fail(`Invalid mode '${opts.mode}'. Must be one of: ${MODES.join(', ')}`, 'invalid_mode');
      return;
    }

    const version = opts.version ? Number(opts.version) : undefined;
    if (version != null && (!Number.isInteger(version) || version < 1)) {
      fail('--version must be a positive integer', 'invalid_option');
      return;
    }

    let params: Record<string, unknown>;
    try {
      params = await resolveParams(opts.param, opts.paramsFile);
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Invalid params', 'invalid_option');
      return;
    }

    if (opts.alertEmailUrl && !opts.alertEmail) {
      fail('--alert-email-url requires --alert-email', 'invalid_option');
      return;
    }

    const alertEmailValue: string | { email: string; custom_url?: string } | undefined =
      opts.alertEmail
        ? opts.alertEmailUrl
          ? { email: opts.alertEmail, custom_url: opts.alertEmailUrl }
          : opts.alertEmail
        : undefined;

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Starting workflow...', globalOpts.quiet);

    const { data, error } = await client.runWorkflow({
      slug,
      workflowParams: params,
      version,
      mode: opts.mode,
      webhookUrl: opts.webhookUrl,
      alertEmail: alertEmailValue,
    });

    if (error) {
      spinner.fail('Failed to start workflow');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    const task = data! as unknown as Record<string, unknown>;
    const id = String(task.deepresearch_id ?? task.id ?? task.task_id ?? '');
    if (!id) {
      spinner.fail('Workflow started but no task id was returned');
      outputError(
        { message: 'Workflow run returned no task id', code: 'unexpected_response' },
        { json: globalOpts.json },
      );
      return;
    }
    spinner.stop(`Workflow started: ${pc.cyan(id)}`);

    if (!opts.watch) {
      if (globalOpts.json || !process.stdout.isTTY) {
        outputResult(task, { json: true });
        return;
      }
      // Mode is template-defined; only assert it when the API echoed it back.
      const modeLabel = task.mode ?? opts.mode ?? pc.dim('template default');
      console.log('');
      console.log(`  ${pc.bold('Task ID:')}  ${pc.cyan(id)}`);
      console.log(`  ${pc.bold('Mode:')}     ${modeLabel}`);
      console.log(`  ${pc.bold('Status:')}   ${task.status ?? 'queued'}`);
      console.log('');
      console.log(`  ${pc.dim('Watch:')}  valyu deepresearch watch ${id}`);
      console.log(`  ${pc.dim('Status:')} valyu deepresearch status ${id}`);
      console.log('');
      return;
    }

    await watchResearch(client, id, globalOpts);
  });

// ─── create ─────────────────────────────────────────────────────────────────

const createCmd = new Command('create')
  .description('Create an org workflow from a JSON definition file')
  .option('--file <path>', 'JSON file with the workflow definition (use "-" for stdin)')
  .addHelpText(
    'after',
    `
${pc.dim('The file must contain the full create body. Required: slug, title, version.')}
${pc.dim('The version object holds the template (prompt, strategy, report_format) and variables.')}

${pc.dim('Example file:')}

  ${pc.dim('{')}
  ${pc.dim('  "slug": "quarterly-company-profile",')}
  ${pc.dim('  "title": "Quarterly Company Profile",')}
  ${pc.dim('  "vertical": "investment-banking",')}
  ${pc.dim('  "version": {')}
  ${pc.dim('    "prompt": "Produce a company profile for {company}.",')}
  ${pc.dim('    "strategy": "Prioritise filings and earnings calls.",')}
  ${pc.dim('    "report_format": "2-page analyst brief.",')}
  ${pc.dim('    "variables": [{ "key": "company", "label": "Company", "type": "text", "required": true }],')}
  ${pc.dim('    "recommended_mode": "standard",')}
  ${pc.dim('    "output_formats": ["markdown", "pdf"]')}
  ${pc.dim('  }')}
  ${pc.dim('}')}

${pc.dim('Examples:')}

  ${pc.dim('$ valyu workflows create --file workflow.json')}
  ${pc.dim('$ cat workflow.json | valyu workflows create --file -')}
`,
  )
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const fail = (message: string, code: string) =>
      outputError({ message, code }, { json: globalOpts.json });

    if (!opts.file) {
      fail(
        'Provide a workflow definition with --file <path> (or --file - for stdin)',
        'missing_file',
      );
      return;
    }

    let body: Record<string, unknown>;
    try {
      if (opts.file === '-') {
        const piped = await readStdin();
        if (!piped) {
          fail('No workflow definition provided on stdin', 'missing_file');
          return;
        }
        body = JSON.parse(piped) as Record<string, unknown>;
      } else {
        body = readJsonFile<Record<string, unknown>>(opts.file, 'workflow');
      }
    } catch (err) {
      fail(
        err instanceof Error ? err.message : 'Failed to read workflow definition',
        'invalid_file',
      );
      return;
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      fail('Workflow definition must be a JSON object', 'invalid_file');
      return;
    }
    for (const required of ['slug', 'title', 'version'] as const) {
      if (!body[required]) {
        fail(`Workflow definition is missing required field '${required}'`, 'invalid_file');
        return;
      }
    }

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Creating workflow...', globalOpts.quiet);

    const { data, error } = await client.createWorkflow(body);

    if (error) {
      spinner.fail('Failed to create workflow');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    spinner.stop(`Workflow created: ${pc.cyan(data!.slug)} ${pc.dim(`v${data!.version}`)}`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(data, { json: true });
      return;
    }
    console.log('');
    console.log(`  ${pc.dim('Inspect:')} valyu workflows get ${data!.slug}`);
    console.log(`  ${pc.dim('Run:')}     valyu workflows run ${data!.slug} --param key=value`);
    console.log('');
  });

// ─── update ─────────────────────────────────────────────────────────────────

const updateCmd = new Command('update')
  .description('Update an org workflow, or publish a new version, from a JSON file')
  .argument('<slug>', 'Workflow slug')
  .option('--file <path>', 'JSON file with the patch body (use "-" for stdin)')
  .addHelpText(
    'after',
    `
${pc.dim('The file may contain metadata fields (title, subtitle, description, vertical, tags)')}
${pc.dim('and/or a "version" object to publish a new immutable version. When publishing a new')}
${pc.dim('version, "version.changelog" is required. Pass "set_current": false to add a version')}
${pc.dim('without promoting it to current.')}

${pc.dim('Examples:')}

  ${pc.dim('$ valyu workflows update my-flow --file patch.json')}
  ${pc.dim('$ echo \'{"title":"New Title"}\' | valyu workflows update my-flow --file -')}
`,
  )
  .action(async (slug, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const fail = (message: string, code: string) =>
      outputError({ message, code }, { json: globalOpts.json });

    if (!opts.file) {
      fail('Provide the patch body with --file <path> (or --file - for stdin)', 'missing_file');
      return;
    }

    let body: Record<string, unknown>;
    try {
      if (opts.file === '-') {
        const piped = await readStdin();
        if (!piped) {
          fail('No patch body provided on stdin', 'missing_file');
          return;
        }
        body = JSON.parse(piped) as Record<string, unknown>;
      } else {
        body = readJsonFile<Record<string, unknown>>(opts.file, 'patch');
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Failed to read patch body', 'invalid_file');
      return;
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      fail('Patch body must be a JSON object', 'invalid_file');
      return;
    }

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Updating workflow...', globalOpts.quiet);

    const { data, error } = await client.updateWorkflow(slug, body);

    if (error) {
      spinner.fail('Failed to update workflow');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    spinner.stop(`Workflow updated: ${pc.cyan(data!.slug)} ${pc.dim(`v${data!.version}`)}`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(data, { json: true });
    }
  });

// ─── delete ─────────────────────────────────────────────────────────────────

const deleteCmd = new Command('delete')
  .description('Delete an org workflow')
  .argument('<slug>', 'Workflow slug')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (slug, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);

    if (!opts.yes) {
      const confirm = await p.confirm({
        message: `Delete workflow ${pc.cyan(slug)}? This cannot be undone.`,
      });
      if (p.isCancel(confirm) || !confirm) {
        console.log(`  ${pc.dim('Cancelled')}`);
        return;
      }
    }

    const spinner = createSpinner('Deleting workflow...', globalOpts.quiet);

    const { data, error } = await client.deleteWorkflow(slug);

    if (error) {
      spinner.fail('Failed to delete workflow');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    spinner.stop(`Workflow ${pc.cyan(slug)} deleted`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(data, { json: true });
    }
  });

// ─── export ─────────────────────────────────────────────────────────────────

export const workflowsCommand = new Command('workflows')
  .description('Reusable, versioned deep research templates')
  .addHelpText(
    'after',
    `
${pc.dim('Workflows are templated deep research starting points. Pick one, fill in its typed')}
${pc.dim('variables, and run it - the template expands into a normal deep research task.')}
${pc.dim('Curated Valyu workflows are read-only; workflows you create are private to your org.')}

${pc.dim('Quick start:')}

  ${pc.dim('$ valyu workflows list --scope valyu')}
  ${pc.dim('$ valyu workflows get ib-company-profile')}
  ${pc.dim('$ valyu workflows run ib-company-profile --param company="NVIDIA (NVDA)" --watch')}
`,
  )
  .addCommand(listCmd)
  .addCommand(getCmd)
  .addCommand(versionsCmd)
  .addCommand(previewCmd)
  .addCommand(runCmd)
  .addCommand(createCmd)
  .addCommand(updateCmd)
  .addCommand(deleteCmd);
