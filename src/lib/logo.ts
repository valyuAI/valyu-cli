import pc from 'picocolors';

// Block letter VALYU - generated as code points to avoid encoding issues
const LOGO_LINES = [
  '  ██╗   ██╗ █████╗ ██╗  ██╗   ██╗██╗   ██╗',
  '  ██║   ██║██╔══██╗██║  ╚██╗ ██╔╝██║   ██║',
  '  ██║   ██║███████║██║   ╚████╔╝ ██║   ██║',
  '  ╚██╗ ██╔╝██╔══██║██║    ╚██╔╝  ██║   ██║',
  '   ╚████╔╝ ██║  ██║███████╗██║   ╚██████╔╝',
  '    ╚═══╝  ╚═╝  ╚═╝╚══════╝╚═╝    ╚═════╝ ',
];

const TAGLINE = 'the search CLI for knowledge workers';

export function printBanner(): void {
  process.stdout.write('\n');
  for (const line of LOGO_LINES) {
    process.stdout.write(`${pc.cyan(line)}\n`);
  }
  process.stdout.write(`\n  ${pc.dim(TAGLINE)}\n\n`);
}

export function printBannerPlain(): void {
  process.stdout.write('\n');
  for (const line of LOGO_LINES) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write(`\n  ${TAGLINE}\n\n`);
}

export function printInlineLogo(): string {
  return pc.cyan('valyu');
}
