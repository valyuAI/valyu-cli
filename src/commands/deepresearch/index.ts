import { readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { Command } from '@commander-js/extra-typings';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import type { GlobalOpts } from '../../lib/client.js';
import {
  ValyuClient,
  PLATFORM_URL,
  requireApiKey,
  type ResearchStatus,
  type ResearchListItem,
  type ResearchListResult,
} from '../../lib/client.js';
import { relTime, colorStatus } from '../../lib/format.js';
import { outputError, outputResult } from '../../lib/output.js';
import { renderResearch } from '../../lib/render.js';
import { createSpinner } from '../../lib/spinner.js';

const MODES = ['fast', 'standard', 'heavy', 'max'] as const;
type Mode = (typeof MODES)[number];

const MODE_DESC: Record<Mode, string> = {
  fast: '~5 min - quick lookups',
  standard: '~10-20 min - balanced (default)',
  heavy: '~60 min - in-depth analysis',
  max: 'up to ~2 hrs - maximum depth',
};

const POLL_MS = 5000;
const MAX_POLLS = 1080;

function taskId(t: Record<string, unknown>): string {
  return String(t.deepresearch_id ?? t.id ?? t.task_id ?? '');
}

const SEPARATOR = pc.dim('  ' + '\u2500'.repeat(40));

const OUTPUT_FORMATS = ['markdown', 'pdf', 'toon'] as const;
const SEARCH_TYPES = ['all', 'web', 'proprietary'] as const;
const HITL_CHECKPOINTS = {
  'planning-questions': 'planning_questions',
  'plan-review': 'plan_review',
  'source-review': 'source_review',
  'outline-review': 'outline_review',
} as const;

const collect = (value: string, prev: string[] = []): string[] => [...prev, value];

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function loadFileAttachment(filePath: string): { data: string; filename: string; mediaType: string } {
  const abs = resolve(filePath);
  const buf = readFileSync(abs);
  const ext = extname(abs).toLowerCase();
  const mediaType = MIME_TYPES[ext] ?? 'application/octet-stream';
  const data = `data:${mediaType};base64,${buf.toString('base64')}`;
  return { data, filename: basename(abs), mediaType };
}

function parseMetadata(pairs: string[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const kv of pairs) {
    const eq = kv.indexOf('=');
    if (eq <= 0) {
      throw new Error(`Invalid --metadata '${kv}'. Expected format: key=value`);
    }
    const key = kv.slice(0, eq).trim();
    const raw = kv.slice(eq + 1);
    if (!key) throw new Error(`Invalid --metadata '${kv}'. Empty key.`);
    if (raw === 'true') out[key] = true;
    else if (raw === 'false') out[key] = false;
    else if (raw !== '' && !Number.isNaN(Number(raw))) out[key] = Number(raw);
    else out[key] = raw;
  }
  return out;
}

function parseHitl(value: string): Record<string, boolean> {
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
  const out: Record<string, boolean> = {};
  for (const p of parts) {
    const key = HITL_CHECKPOINTS[p as keyof typeof HITL_CHECKPOINTS];
    if (!key) {
      throw new Error(
        `Invalid --hitl checkpoint '${p}'. Valid: ${Object.keys(HITL_CHECKPOINTS).join(', ')}`,
      );
    }
    out[key] = true;
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
    throw new Error(`Invalid JSON in ${label} file ${filePath}: ${err instanceof Error ? err.message : 'parse error'}`);
  }
}

// ─── create ─────────────────────────────────────────────────────────────────

const createCmd = new Command('create')
  .description('Start a deep research task')
  .argument('<query>', 'Research query')
  .option('-m, --mode <mode>', `Research depth: ${MODES.join(', ')} (default: standard)`, 'standard')
  .option('-w, --watch', 'Wait for completion and display result')
  // Steering
  .option('--research-strategy <text>', 'Natural language guidance for the research phase')
  .option('--report-format <text>', 'Natural language guidance for the final report format')
  // Output
  .option('--no-pdf', 'Skip PDF generation (ignored if --output-format is used)')
  .option(
    '--output-format <fmt>',
    `Output format (repeatable): ${OUTPUT_FORMATS.join(', ')}`,
    collect,
    [] as string[],
  )
  .option('--structured <schema>', 'JSON schema for structured output (inline JSON string)')
  .option('--structured-file <path>', 'Path to JSON schema file for structured output')
  // Context
  .option('--url <url>', 'Seed URL to include in research context (repeatable)', collect, [] as string[])
  .option('--file <path>', 'File to attach (repeatable, base64-encoded)', collect, [] as string[])
  .option('--previous-report <id>', 'Previous research task ID to use as context (repeatable)', collect, [] as string[])
  // Search config
  .option('--search-type <type>', `Search scope: ${SEARCH_TYPES.join(', ')}`)
  .option('--include-source <source>', 'Source to include (repeatable, advanced - usually not needed)', collect, [] as string[])
  .option('--exclude-source <source>', 'Source to exclude (repeatable, advanced)', collect, [] as string[])
  .option('--country <code>', 'ISO 3166-1 alpha-2 country code for geo-targeted search')
  .option('--start-date <date>', 'Earliest publication date (YYYY-MM-DD)')
  .option('--end-date <date>', 'Latest publication date (YYYY-MM-DD)')
  // Tools
  .option('--code-execution', 'Enable sandboxed Python code execution')
  .option('--screenshots', 'Enable visual screenshot capture of web pages')
  // Deliverables
  .option('--deliverable <desc>', 'Deliverable description (repeatable)', collect, [] as string[])
  .option('--deliverables-file <path>', 'JSON file with structured deliverables (array)')
  // Notifications
  .option('--webhook-url <url>', 'HTTPS URL to receive completion webhook (HMAC-signed)')
  .option('--alert-email <email>', 'Email to notify on completion (must belong to your organization)')
  .option(
    '--alert-email-url <url>',
    'Custom report link for the alert email. Must include {id} placeholder (replaced with the task ID)',
  )
  // Metadata
  .option('--metadata <kv>', 'Metadata entry in key=value form (repeatable)', collect, [] as string[])
  // HITL
  .option(
    '--hitl <checkpoints>',
    `HITL checkpoints (comma-separated): ${Object.keys(HITL_CHECKPOINTS).join(', ')}`,
  )
  .addHelpText(
    'after',
    `
${pc.dim('Modes:')}

${MODES.map((m) => `  ${pc.cyan(m.padEnd(10))} ${MODE_DESC[m]}`).join('\n')}

${pc.dim('Structured output:')}

  Pass a JSON schema to get structured data back instead of a markdown report.
  Use ${pc.cyan('--structured')} for inline JSON or ${pc.cyan('--structured-file')} to read from a file.
  Structured output cannot be combined with markdown or PDF.

${pc.dim('Examples:')}

  ${pc.dim('# PE / DD: target company deep-dive')}
  ${pc.dim('$ valyu deepresearch create "Dubuque Bank & Trust - DD brief: management, loan book quality, regional competitive position" --mode heavy --watch')}

  ${pc.dim('# Finance: earnings analysis with report steering')}
  ${pc.dim('$ valyu deepresearch create "NVDA Q4 earnings: guidance, datacenter segment, gross margin trajectory" \\')}
  ${pc.dim('    --report-format "2-page analyst brief with comparison table vs peers"')}

  ${pc.dim('# Life sciences: drug candidate shortlist + XLSX deliverable')}
  ${pc.dim('$ valyu deepresearch create "Clinical-stage oral GLP-1 agonists in obesity" \\')}
  ${pc.dim('    --deliverable "XLSX: molecule, mechanism, developer, phase, indication, NCT ID, ChEMBL ID"')}

  ${pc.dim('# Healthcare: clinical trial tracker CSV')}
  ${pc.dim('$ valyu deepresearch create "Phase 3 CAR-T trials in solid tumors currently recruiting" \\')}
  ${pc.dim('    --deliverable "CSV: NCT ID, sponsor, indication, target antigen, phase, enrollment, start date, status"')}

  ${pc.dim('# GTM: account list for target ICP')}
  ${pc.dim('$ valyu deepresearch create "Series A/B AI infrastructure startups in NYC hiring platform engineers" \\')}
  ${pc.dim('    --country US \\')}
  ${pc.dim('    --deliverable "CSV: company, website, founders, HQ, last round size/date/lead, product one-liner, open platform roles"')}

  ${pc.dim('# Structured JSON + TOON visual')}
  ${pc.dim('$ valyu deepresearch create "Top 10 Series C AI unicorns this year" \\')}
  ${pc.dim('    --structured-file schema.json --output-format toon')}

  ${pc.dim('# HITL - pause at plan and source review')}
  ${pc.dim('$ valyu deepresearch create "Competitive landscape of enterprise AI coding assistants" \\')}
  ${pc.dim('    --mode heavy --hitl plan-review,source-review --watch')}
`,
  )
  .action(async (query, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const fail = (message: string, code: string): void => {
      outputError({ message, code }, { json: globalOpts.json });
    };

    if (!MODES.includes(opts.mode as Mode)) {
      fail(`Invalid mode '${opts.mode}'. Must be one of: ${MODES.join(', ')}`, 'invalid_mode');
      return;
    }

    if (opts.structured && opts.structuredFile) {
      fail('Use --structured or --structured-file, not both', 'invalid_options');
      return;
    }

    // Structured output schema
    let structuredSchema: Record<string, unknown> | undefined;
    if (opts.structuredFile) {
      try {
        structuredSchema = readJsonFile<Record<string, unknown>>(opts.structuredFile, 'schema');
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Failed to read schema file', 'invalid_schema');
        return;
      }
    } else if (opts.structured) {
      try {
        structuredSchema = JSON.parse(opts.structured);
      } catch {
        fail(
          'Invalid JSON for --structured schema. Tip: use --structured-file to read from a file instead.',
          'invalid_schema',
        );
        return;
      }
    }

    // Validate --output-format values first
    for (const fmt of opts.outputFormat) {
      if (!OUTPUT_FORMATS.includes(fmt as (typeof OUTPUT_FORMATS)[number])) {
        fail(`Invalid --output-format '${fmt}'. Valid: ${OUTPUT_FORMATS.join(', ')}`, 'invalid_option');
        return;
      }
    }

    // Output formats assembly:
    // - Structured schema + markdown/pdf is not allowed (API rejects it)
    // - Structured schema + toon IS allowed (toon requires a schema)
    // - Otherwise default to markdown (+pdf unless --no-pdf)
    let outputFormats: Array<string | Record<string, unknown>>;
    if (structuredSchema) {
      const extras = Array.from(new Set(opts.outputFormat));
      const blocked = extras.filter((f) => f === 'markdown' || f === 'pdf');
      if (blocked.length > 0) {
        fail(
          `Structured JSON output cannot be combined with ${blocked.join('/')}. Use deliverables (--deliverable / --deliverables-file) if you want structured files alongside a markdown/PDF report.`,
          'invalid_options',
        );
        return;
      }
      outputFormats = [structuredSchema, ...extras.filter((f) => f === 'toon')];
    } else if (opts.outputFormat.length > 0) {
      outputFormats = Array.from(new Set(opts.outputFormat));
    } else {
      outputFormats = opts.pdf === false ? ['markdown'] : ['markdown', 'pdf'];
    }

    // Search type validation
    if (opts.searchType && !SEARCH_TYPES.includes(opts.searchType as (typeof SEARCH_TYPES)[number])) {
      fail(`Invalid --search-type '${opts.searchType}'. Valid: ${SEARCH_TYPES.join(', ')}`, 'invalid_option');
      return;
    }

    // Files: load from disk and base64-encode
    let files: Array<{ data: string; filename: string; mediaType: string }> | undefined;
    if (opts.file.length > 0) {
      try {
        files = opts.file.map(loadFileAttachment);
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Failed to load file', 'invalid_file');
        return;
      }
    }

    // Metadata
    let metadata: Record<string, string | number | boolean> | undefined;
    if (opts.metadata.length > 0) {
      try {
        metadata = parseMetadata(opts.metadata);
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Invalid metadata', 'invalid_option');
        return;
      }
    }

    // HITL
    let hitl: Record<string, boolean> | undefined;
    if (opts.hitl) {
      try {
        hitl = parseHitl(opts.hitl);
      } catch (err) {
        fail(err instanceof Error ? err.message : 'Invalid --hitl', 'invalid_option');
        return;
      }
    }

    // Deliverables: mix of --deliverable strings and structured file
    let deliverables: Array<string | Record<string, unknown>> | undefined;
    if (opts.deliverable.length > 0 || opts.deliverablesFile) {
      deliverables = [...opts.deliverable];
      if (opts.deliverablesFile) {
        try {
          const loaded = readJsonFile<unknown>(opts.deliverablesFile, 'deliverables');
          if (!Array.isArray(loaded)) {
            fail('--deliverables-file must contain a JSON array', 'invalid_option');
            return;
          }
          deliverables.push(...(loaded as Array<string | Record<string, unknown>>));
        } catch (err) {
          fail(err instanceof Error ? err.message : 'Failed to read deliverables', 'invalid_option');
          return;
        }
      }
    }

    // Search config
    const hasSearchOpts =
      opts.searchType ||
      opts.includeSource.length > 0 ||
      opts.excludeSource.length > 0 ||
      opts.country ||
      opts.startDate ||
      opts.endDate;
    const searchConfig = hasSearchOpts
      ? {
          searchType: opts.searchType,
          includedSources: opts.includeSource.length > 0 ? opts.includeSource : undefined,
          excludedSources: opts.excludeSource.length > 0 ? opts.excludeSource : undefined,
          countryCode: opts.country,
          startDate: opts.startDate,
          endDate: opts.endDate,
        }
      : undefined;

    // Tools config
    const tools =
      opts.codeExecution || opts.screenshots
        ? {
            code_execution: opts.codeExecution || undefined,
            screenshots: opts.screenshots || undefined,
          }
        : undefined;

    // Alert email: plain string, or object when --alert-email-url is supplied.
    // Validation (org membership, {id} placeholder, etc) is done server-side.
    const alertEmailValue: string | { email: string; custom_url?: string } | undefined = opts.alertEmail
      ? opts.alertEmailUrl
        ? { email: opts.alertEmail, custom_url: opts.alertEmailUrl }
        : opts.alertEmail
      : undefined;

    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Creating research task...', globalOpts.quiet);

    const { data, error } = await client.createResearch({
      query,
      mode: opts.mode,
      outputFormats,
      researchStrategy: opts.researchStrategy,
      reportFormat: opts.reportFormat,
      search: searchConfig,
      urls: opts.url.length > 0 ? opts.url : undefined,
      files,
      metadata,
      tools,
      previousReports: opts.previousReport.length > 0 ? opts.previousReport : undefined,
      webhookUrl: opts.webhookUrl,
      alertEmail: alertEmailValue,
      deliverables,
      hitl,
    });

    if (error) {
      spinner.fail('Failed to create research task');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    const task = data! as unknown as Record<string, unknown>;
    const id = taskId(task);
    spinner.stop(`Research task created: ${pc.cyan(id)}`);

    if (!opts.watch) {
      if (globalOpts.json || !process.stdout.isTTY) {
        outputResult(task, { json: true });
        return;
      }

      const stringFormats = outputFormats.filter((f): f is string => typeof f === 'string');
      const formatLabel = structuredSchema
        ? pc.green('json schema')
        : stringFormats.join(', ') || pc.dim('none');

      console.log('');
      console.log(`  ${pc.bold('Task ID:')}  ${pc.cyan(id)}`);
      console.log(`  ${pc.bold('Mode:')}     ${task.mode ?? opts.mode}`);
      console.log(`  ${pc.bold('Status:')}   ${colorStatus(String(task.status))}`);
      console.log(`  ${pc.bold('Output:')}   ${formatLabel}`);
      if (hitl) console.log(`  ${pc.bold('HITL:')}     ${Object.keys(hitl).join(', ')}`);
      if (deliverables?.length) console.log(`  ${pc.bold('Deliverables:')} ${deliverables.length}`);
      if (files?.length) console.log(`  ${pc.bold('Files:')}    ${files.length} attached`);
      if (opts.webhookUrl) console.log(`  ${pc.bold('Webhook:')}  ${pc.dim(opts.webhookUrl)}`);
      console.log('');
      console.log(`  ${pc.dim('Watch:')}  valyu deepresearch watch ${id}`);
      console.log(`  ${pc.dim('Status:')} valyu deepresearch status ${id}`);
      console.log(`  ${pc.dim('Cancel:')} valyu deepresearch cancel ${id}`);
      console.log('');
      return;
    }

    await watchResearch(client, id, globalOpts);
  });

// ─── list ───────────────────────────────────────────────────────────────────

const listCmd = new Command('list')
  .description('List all research tasks')
  .option('-n, --limit <n>', 'Max results', '20')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Loading tasks...', globalOpts.quiet);

    const { data, error } = await client.listResearch(Number(opts.limit) || 20);

    if (error) {
      spinner.fail('Failed to list tasks');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    const raw = data as ResearchListResult;
    const tasks: ResearchListItem[] = Array.isArray(raw) ? raw : (raw?.data ?? []);
    spinner.stop(`${tasks.length} task${tasks.length === 1 ? '' : 's'}`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(tasks, { json: true });
      return;
    }

    if (tasks.length === 0) {
      console.log(`\n  ${pc.dim('No research tasks found. Create one with:')} valyu deepresearch create "query"\n`);
      return;
    }

    console.log('');
    for (const t of tasks) {
      const status = colorStatus(t.status);
      const time = relTime(t.created_at);
      const title = (t as unknown as Record<string, unknown>).title as string | undefined;
      const label = title ?? t.query;
      const q = label.length > 60 ? label.slice(0, 57) + '...' : label;
      console.log(`  ${pc.cyan(t.deepresearch_id)}`);
      console.log(`  ${status}  ${pc.dim(time)}  ${q}`);
      console.log('');
    }
    console.log(`  ${pc.dim('View details:')} valyu deepresearch status <id>\n`);
  });

// ─── status ─────────────────────────────────────────────────────────────────

const statusCmd = new Command('status')
  .description('Check the status of a research task')
  .argument('<id>', 'Research task ID')
  .action(async (id, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Fetching status...', globalOpts.quiet);

    const { data, error } = await client.getResearchStatus(id);

    if (error) {
      spinner.fail('Failed to fetch status');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    const status = data!;
    spinner.stop(`Status: ${colorStatus(status.status)}`);

    if (globalOpts.json || !process.stdout.isTTY) {
      outputResult(data, { json: true });
      return;
    }

    renderResearchStatus(status);
  });

// ─── watch ──────────────────────────────────────────────────────────────────

const watchCmd = new Command('watch')
  .description('Poll a research task until complete (omit ID to watch latest)')
  .argument('[id]', 'Research task ID (default: latest running task)')
  .action(async (id, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);

    let watchId = id;

    if (!watchId) {
      const spinner = createSpinner('Finding latest task...', globalOpts.quiet);
      const { data, error } = await client.listResearch(20);
      if (error) {
        spinner.fail('Failed to list tasks');
        outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
        return;
      }
      const rawList = data as ResearchListResult;
      const allTasks: ResearchListItem[] = Array.isArray(rawList) ? rawList : (rawList?.data ?? []);
      const running = allTasks.find(
        (t: ResearchListItem) => t.status === 'running' || t.status === 'queued' || t.status === 'awaiting_input',
      );
      if (!running) {
        spinner.fail('No running research tasks found');
        outputError(
          { message: 'No running tasks. Create one with: valyu deepresearch create "query"', code: 'no_tasks' },
          { json: globalOpts.json },
        );
        return;
      }
      watchId = running.deepresearch_id;
      spinner.stop(`Watching: ${pc.cyan(watchId.slice(0, 8))} - ${running.query.slice(0, 50)}`);
    }

    await watchResearch(client, watchId, globalOpts);
  });

// ─── cancel ─────────────────────────────────────────────────────────────────

const cancelCmd = new Command('cancel')
  .description('Cancel a running research task')
  .argument('<id>', 'Research task ID')
  .action(async (id, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Cancelling task...', globalOpts.quiet);

    const { error } = await client.cancelResearch(id);

    if (error) {
      spinner.fail('Failed to cancel task');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    spinner.stop(`Task ${pc.cyan(id.slice(0, 8))} cancelled`);
  });

// ─── update ─────────────────────────────────────────────────────────────────

const updateCmd = new Command('update')
  .description('Add a follow-up instruction to a running research task')
  .argument('<id>', 'Research task ID')
  .argument('<instruction>', 'Follow-up instruction')
  .action(async (id, instruction, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);
    const spinner = createSpinner('Sending instruction...', globalOpts.quiet);

    const { data, error } = await client.updateResearch(id, instruction);

    if (error) {
      spinner.fail('Failed to update task');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    spinner.stop(`Instruction sent to task ${pc.cyan(id.slice(0, 8))}`);

    if (globalOpts.json) {
      outputResult(data, { json: true });
    }
  });

// ─── delete ─────────────────────────────────────────────────────────────────

const deleteCmd = new Command('delete')
  .description('Delete a research task')
  .argument('<id>', 'Research task ID')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);

    if (!opts.yes) {
      const confirm = await p.confirm({
        message: `Delete research task ${pc.cyan(id.slice(0, 8))}? This cannot be undone.`,
      });

      if (p.isCancel(confirm) || !confirm) {
        console.log(`  ${pc.dim('Cancelled')}`);
        return;
      }
    }

    const spinner = createSpinner('Deleting task...', globalOpts.quiet);

    const { error } = await client.deleteResearch(id);

    if (error) {
      spinner.fail('Failed to delete task');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    spinner.stop(`Task ${pc.cyan(id.slice(0, 8))} deleted`);
  });

// ─── share ──────────────────────────────────────────────────────────────────

const shareCmd = new Command('share')
  .description('Toggle public access for a research task')
  .argument('<id>', 'Research task ID')
  .action(async (id, _opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOpts;
    const resolved = requireApiKey(globalOpts);
    const client = new ValyuClient(resolved.key);

    // Get current status to check public state
    const spinnerCheck = createSpinner('Checking task...', globalOpts.quiet);
    const { data: status, error: statusError } = await client.getResearchStatus(id);

    if (statusError) {
      spinnerCheck.fail('Failed to fetch task');
      outputError({ message: statusError.message, code: statusError.code }, { json: globalOpts.json });
      return;
    }

    const currentlyPublic = status?.public === true;
    const newPublic = !currentlyPublic;
    spinnerCheck.stop(currentlyPublic ? 'Currently public - toggling off' : 'Currently private - toggling on');

    const spinner = createSpinner(newPublic ? 'Making task public...' : 'Making task private...', globalOpts.quiet);
    const { data, error } = await client.toggleResearchPublic(id, newPublic);

    if (error) {
      spinner.fail('Failed to toggle public access');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    if (newPublic) {
      const publicUrl = `${PLATFORM_URL}/playground/deepresearch/${id}`;
      spinner.stop(`Task ${pc.cyan(id.slice(0, 8))} is now ${pc.green('public')}`);
      console.log('');
      console.log(`  ${pc.bold('Public URL:')}  ${pc.cyan(publicUrl)}`);
      console.log('');
    } else {
      spinner.stop(`Task ${pc.cyan(id.slice(0, 8))} is now ${pc.dim('private')}`);
    }

    if (globalOpts.json) {
      outputResult(data, { json: true });
    }
  });

// ─── HITL interaction handlers ──────────────────────────────────────────────

interface InteractionQuestion {
  question: string;
  context?: string;
}

interface SourceDomain {
  domain: string;
  source_count: number;
  avg_relevance_score: number;
  ai_recommendation: string;
}

async function handlePlanningQuestions(
  client: ValyuClient,
  id: string,
  interactionId: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const questions = (data.questions ?? []) as InteractionQuestion[];

  console.log('');
  console.log(`  ${pc.yellow('\u26a0')} ${pc.bold('Checkpoint: Planning Questions')}`);
  console.log(SEPARATOR);
  console.log('');
  console.log('  The agent has questions before proceeding:');
  console.log('');

  const answers: Record<string, string> = {};

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (q.context) {
      console.log(`  ${pc.dim(q.context)}`);
    }

    const answer = await p.text({
      message: q.question,
    });

    if (p.isCancel(answer)) {
      console.log(`  ${pc.dim('Cancelled - task will remain paused')}`);
      return false;
    }

    answers[`q${i}`] = answer;
  }

  const { error } = await client.respondResearch(id, interactionId, { answers });

  if (error) {
    console.log(`  ${pc.red('\u2717')} Failed to submit responses: ${error.message}`);
    return false;
  }

  console.log(`  ${pc.green('\u2714')} Responses submitted`);
  return true;
}

async function handlePlanReview(
  client: ValyuClient,
  id: string,
  interactionId: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const plan = (data.plan ?? '') as string;
  const researchAreas = (data.research_areas ?? []) as string[];
  const estimatedSteps = (data.estimated_steps ?? 0) as number;

  console.log('');
  console.log(`  ${pc.yellow('\u26a0')} ${pc.bold('Checkpoint: Plan Review')}`);
  console.log(SEPARATOR);
  console.log('');

  if (researchAreas.length > 0) {
    console.log(`  ${pc.bold('Research areas:')}`);
    for (const area of researchAreas) {
      console.log(`    ${pc.dim('\u00b7')} ${area}`);
    }
    console.log('');
  }

  if (estimatedSteps > 0) {
    console.log(`  ${pc.bold('Estimated steps:')} ${estimatedSteps}`);
    console.log('');
  }

  console.log(`  ${pc.bold('Plan:')}`);
  console.log('');
  for (const line of plan.split('\n')) {
    console.log(`  ${line}`);
  }
  console.log('');

  const approved = await p.confirm({
    message: 'Approve this research plan?',
  });

  if (p.isCancel(approved)) {
    console.log(`  ${pc.dim('Cancelled - task will remain paused')}`);
    return false;
  }

  if (approved) {
    const { error } = await client.respondResearch(id, interactionId, { approved: true });
    if (error) {
      console.log(`  ${pc.red('\u2717')} Failed to submit: ${error.message}`);
      return false;
    }
    console.log(`  ${pc.green('\u2714')} Plan approved`);
    return true;
  }

  const modifications = await p.text({
    message: 'What modifications would you like?',
  });

  if (p.isCancel(modifications)) {
    console.log(`  ${pc.dim('Cancelled - task will remain paused')}`);
    return false;
  }

  const { error } = await client.respondResearch(id, interactionId, {
    approved: false,
    modifications,
  });

  if (error) {
    console.log(`  ${pc.red('\u2717')} Failed to submit: ${error.message}`);
    return false;
  }

  console.log(`  ${pc.green('\u2714')} Modifications submitted`);
  return true;
}

async function handleSourceReview(
  client: ValyuClient,
  id: string,
  interactionId: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const domains = (data.domains ?? []) as SourceDomain[];
  const totalSources = domains.reduce((sum, d) => sum + d.source_count, 0);

  console.log('');
  console.log(`  ${pc.yellow('\u26a0')} ${pc.bold(`Checkpoint: Source Review (${totalSources} sources found)`)}`);
  console.log(SEPARATOR);
  console.log('');

  // Table header
  const domainCol = 18;
  const sourcesCol = 9;
  const relCol = 11;
  const recCol = 10;

  console.log(
    `  ${pc.bold('Domain'.padEnd(domainCol))}${pc.bold('Sources'.padEnd(sourcesCol))}${pc.bold('Relevance'.padEnd(relCol))}${pc.bold('AI says'.padEnd(recCol))}`,
  );

  for (const d of domains) {
    const domainStr = d.domain.length > domainCol - 2 ? d.domain.slice(0, domainCol - 3) + '..' : d.domain;
    const relevance = `${Math.round(d.avg_relevance_score * 100)}%`;
    const recColor = d.ai_recommendation === 'include' ? pc.green : pc.red;
    console.log(
      `  ${domainStr.padEnd(domainCol)}${String(d.source_count).padEnd(sourcesCol)}${relevance.padEnd(relCol)}${recColor(d.ai_recommendation.padEnd(recCol))}`,
    );
  }

  console.log('');

  const excludeInput = await p.text({
    message: 'Domains to exclude (comma-separated, or Enter to accept AI recommendations)',
    defaultValue: '',
  });

  if (p.isCancel(excludeInput)) {
    console.log(`  ${pc.dim('Cancelled - task will remain paused')}`);
    return false;
  }

  const excluded = (excludeInput ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const { error } = await client.respondResearch(id, interactionId, {
    excluded_domains: excluded,
  });

  if (error) {
    console.log(`  ${pc.red('\u2717')} Failed to submit: ${error.message}`);
    return false;
  }

  if (excluded.length > 0) {
    console.log(`  ${pc.green('\u2714')} Excluded ${excluded.length} domain${excluded.length === 1 ? '' : 's'}`);
  } else {
    console.log(`  ${pc.green('\u2714')} AI recommendations accepted`);
  }
  return true;
}

async function handleOutlineReview(
  client: ValyuClient,
  id: string,
  interactionId: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const outline = (data.outline ?? '') as string;
  const sections = (data.sections ?? []) as string[];

  console.log('');
  console.log(`  ${pc.yellow('\u26a0')} ${pc.bold('Checkpoint: Outline Review')}`);
  console.log(SEPARATOR);
  console.log('');

  if (sections.length > 0) {
    console.log(`  ${pc.bold('Sections:')}`);
    for (let i = 0; i < sections.length; i++) {
      console.log(`    ${pc.dim(`${i + 1}.`)} ${sections[i]}`);
    }
    console.log('');
  }

  if (outline) {
    console.log(`  ${pc.bold('Outline:')}`);
    console.log('');
    for (const line of outline.split('\n')) {
      console.log(`  ${line}`);
    }
    console.log('');
  }

  const approved = await p.confirm({
    message: 'Approve this outline?',
  });

  if (p.isCancel(approved)) {
    console.log(`  ${pc.dim('Cancelled - task will remain paused')}`);
    return false;
  }

  if (approved) {
    const { error } = await client.respondResearch(id, interactionId, { approved: true });
    if (error) {
      console.log(`  ${pc.red('\u2717')} Failed to submit: ${error.message}`);
      return false;
    }
    console.log(`  ${pc.green('\u2714')} Outline approved`);
    return true;
  }

  const modifications = await p.text({
    message: 'What modifications would you like?',
  });

  if (p.isCancel(modifications)) {
    console.log(`  ${pc.dim('Cancelled - task will remain paused')}`);
    return false;
  }

  const { error } = await client.respondResearch(id, interactionId, {
    approved: false,
    modifications,
  });

  if (error) {
    console.log(`  ${pc.red('\u2717')} Failed to submit: ${error.message}`);
    return false;
  }

  console.log(`  ${pc.green('\u2714')} Modifications submitted`);
  return true;
}

async function handleInteraction(
  client: ValyuClient,
  id: string,
  interaction: NonNullable<ResearchStatus['interaction']>,
): Promise<boolean> {
  const { interaction_id, type, data } = interaction;

  switch (type) {
    case 'planning_questions':
      return handlePlanningQuestions(client, id, interaction_id, data);
    case 'plan_review':
      return handlePlanReview(client, id, interaction_id, data);
    case 'source_review':
      return handleSourceReview(client, id, interaction_id, data);
    case 'outline_review':
      return handleOutlineReview(client, id, interaction_id, data);
    default:
      console.log(`  ${pc.yellow('\u26a0')} Unknown checkpoint type: ${type}`);
      return false;
  }
}

// ─── watch loop ─────────────────────────────────────────────────────────────

async function watchResearch(
  client: ValyuClient,
  id: string,
  globalOpts: GlobalOpts,
): Promise<void> {
  let polls = 0;
  let spinner = createSpinner('Waiting for research to complete...', globalOpts.quiet);

  while (polls < MAX_POLLS) {
    const { data, error } = await client.getResearchStatus(id);

    if (error) {
      spinner.fail('Failed to fetch status');
      outputError({ message: error.message, code: error.code }, { json: globalOpts.json });
      return;
    }

    const status = data as ResearchStatus;

    if (status.status === 'completed') {
      spinner.stop('Research complete');
      if (globalOpts.json || !process.stdout.isTTY) {
        outputResult(status, { json: true });
        return;
      }
      renderResearchStatus(status);
      return;
    }

    if (status.status === 'failed' || status.status === 'cancelled') {
      spinner.fail(`Research ${status.status}`);
      outputError(
        {
          message: status.error ?? `Research task ${status.status}`,
          code: `research_${status.status}`,
        },
        { json: globalOpts.json },
      );
      return;
    }

    // HITL: handle interactive checkpoints
    if ((status.status === 'awaiting_input' || status.status === 'paused') && status.interaction) {
      spinner.warn(`Task paused - input required`);

      const responded = await handleInteraction(client, id, status.interaction);

      if (!responded) {
        // User cancelled the interaction - exit watch
        return;
      }

      // Restart spinner and continue polling
      spinner = createSpinner('Waiting for research to continue...', globalOpts.quiet);
      await new Promise((r) => setTimeout(r, POLL_MS));
      polls++;
      continue;
    }

    if (status.progress) {
      const { current_step, total_steps } = status.progress;
      spinner.update(`Researching... step ${current_step}/${total_steps}`);
    } else {
      spinner.update(`Researching... (${status.status})`);
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
    polls++;
  }

  spinner.fail('Timed out waiting for research');
  outputError(
    { message: `Use 'valyu deepresearch status ${id}' to check later.`, code: 'timeout' },
    { json: globalOpts.json },
  );
}

// ─── render ─────────────────────────────────────────────────────────────────

function renderResearchStatus(status: ResearchStatus): void {
  const id = status.deepresearch_id ?? status.id ?? status.task_id ?? '';

  console.log('');
  console.log(`  ${pc.bold('Task ID:')}    ${pc.cyan(id)}`);
  console.log(`  ${pc.bold('Status:')}     ${colorStatus(status.status)}`);
  if (status.mode) console.log(`  ${pc.bold('Mode:')}       ${status.mode}`);
  if (status.query) console.log(`  ${pc.bold('Query:')}      ${status.query}`);
  if (status.progress) {
    const { current_step, total_steps } = status.progress;
    const pct = Math.round((current_step / total_steps) * 100);
    console.log(`  ${pc.bold('Progress:')}   ${current_step}/${total_steps} (${pct}%)`);
  }

  if (status.status === 'completed') {
    // Structured output
    if (status.structured_output && typeof status.structured_output === 'object') {
      console.log('');
      console.log(`  ${pc.bold('Structured Output:')}`);
      console.log(SEPARATOR);
      console.log('');
      const formatted = JSON.stringify(status.structured_output, null, 2);
      for (const line of formatted.split('\n')) {
        console.log(`  ${line}`);
      }
    }

    // Output - render full report
    if (status.output && typeof status.output === 'string') {
      console.log('');
      console.log(pc.dim('  ' + '\u2500'.repeat(40)));
      console.log('');
      console.log(status.output);
    }

    // PDF
    if (status.pdf_url) {
      console.log('');
      console.log(`  ${pc.bold('PDF:')}        ${pc.cyan(status.pdf_url)}`);
    }

    // Deliverables
    if (status.deliverables?.length) {
      console.log('');
      console.log(`  ${pc.bold('Deliverables:')}`);
      for (const d of status.deliverables) {
        const icon = d.status === 'completed' ? pc.green('\u2713') : pc.red('\u2717');
        console.log(`    ${icon} ${d.type.toUpperCase()} - ${d.title ?? d.type}${d.url ? `  ${pc.cyan(d.url)}` : ''}${d.error ? `  ${pc.red(d.error)}` : ''}`);
      }
    }

    // Sources
    if (status.sources?.length) {
      console.log('');
      console.log(`  ${pc.bold('Sources:')}    ${pc.dim(`${status.sources.length} used`)}`);
      for (const s of status.sources.slice(0, 10)) {
        console.log(`    ${pc.dim('\u00b7')} ${s.title.slice(0, 70)}${s.title.length > 70 ? '...' : ''}`);
      }
      if (status.sources.length > 10) {
        console.log(`    ${pc.dim(`... and ${status.sources.length - 10} more`)}`);
      }
    }

    // Cost
    const cost = status.cost ?? status.usage?.total_cost;
    if (cost != null) {
      console.log('');
      console.log(`  ${pc.bold('Cost:')}       ${pc.dim('$' + cost.toFixed(4))}`);
    }
  }

  console.log('');
}

// ─── export ─────────────────────────────────────────────────────────────────

export const deepresearchCommand = new Command('deepresearch')
  .description('Deep research - AI-synthesized reports with sources')
  .addCommand(createCmd)
  .addCommand(listCmd)
  .addCommand(statusCmd)
  .addCommand(watchCmd)
  .addCommand(cancelCmd)
  .addCommand(updateCmd)
  .addCommand(deleteCmd)
  .addCommand(shareCmd);
