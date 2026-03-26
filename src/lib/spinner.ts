import pc from 'picocolors';
import { isInteractive, isUnicodeSupported } from './tty.js';

const TICK = isUnicodeSupported ? String.fromCodePoint(0x2714) : 'v'; // ✔
const WARN = isUnicodeSupported ? String.fromCodePoint(0x26a0) : '!'; // ⚠
const CROSS = isUnicodeSupported ? String.fromCodePoint(0x2717) : 'x'; // ✗
const INFO = isUnicodeSupported ? String.fromCodePoint(0x2139) : 'i'; // ℹ

const SPINNER_FRAMES = isUnicodeSupported
  ? ['\u2839', '\u2838', '\u2834', '\u2826', '\u2807', '\u280F', '\u2819', '\u2839']
  : ['-', '\\', '|', '/'];

const SPINNER_INTERVAL = 80;

export type Spinner = ReturnType<typeof createSpinner>;

export function createSpinner(message: string, quiet?: boolean) {
  if (quiet || !isInteractive()) {
    return {
      update(_msg: string) {},
      stop(_msg: string) {},
      warn(_msg: string) {},
      fail(_msg: string) {},
      info(_msg: string) {},
    };
  }

  let i = 0;
  let text = message;

  const timer = setInterval(() => {
    process.stderr.write(
      `\r\x1B[2K  ${pc.cyan(SPINNER_FRAMES[i++ % SPINNER_FRAMES.length])} ${text}`,
    );
  }, SPINNER_INTERVAL);

  return {
    update(msg: string) {
      text = msg;
    },
    stop(msg: string) {
      clearInterval(timer);
      process.stderr.write(`\r\x1B[2K  ${pc.green(TICK)} ${msg}\n`);
    },
    warn(msg: string) {
      clearInterval(timer);
      process.stderr.write(`\r\x1B[2K  ${pc.yellow(WARN)} ${msg}\n`);
    },
    fail(msg: string) {
      clearInterval(timer);
      process.stderr.write(`\r\x1B[2K  ${pc.red(CROSS)} ${msg}\n`);
    },
    info(msg: string) {
      clearInterval(timer);
      process.stderr.write(`\r\x1B[2K  ${pc.blue(INFO)} ${msg}\n`);
    },
  };
}

export function printCheck(status: 'pass' | 'warn' | 'fail' | 'info', msg: string): void {
  const symbols = {
    pass: pc.green(TICK),
    warn: pc.yellow(WARN),
    fail: pc.red(CROSS),
    info: pc.blue(INFO),
  };
  process.stdout.write(`  ${symbols[status]} ${msg}\n`);
}
