import pc from 'picocolors';

export const ANSWER_SUNSET_DATE = '2026-12-17';
export const ANSWER_MIGRATION_URL =
  'https://docs.valyu.ai/api-reference/endpoint/answer#migrate-from-answer';
export const ANSWER_REPLACEMENT = 'valyu deepresearch create "<question>" --mode instant --watch';

/** Plain-text deprecation notice (no colour). */
export function answerDeprecationMessage(): string {
  return `\`valyu answer\` is deprecated and stops working on ${ANSWER_SUNSET_DATE}. Use: ${ANSWER_REPLACEMENT}. Guide: ${ANSWER_MIGRATION_URL}`;
}

/** Print the deprecation notice on stderr so stdout stays machine-clean. */
export function printAnswerDeprecation(): void {
  console.error(`${pc.yellow('Deprecated:')} ${answerDeprecationMessage()}`);
}

/** Warning entry for JSON output, in the same shape as API warnings. */
export function answerDeprecationWarning(): { type: string; message: string } {
  return { type: 'deprecation', message: answerDeprecationMessage() };
}
