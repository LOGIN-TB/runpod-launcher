import type { Problem } from '@runpod-launcher/shared';
import type { MessageKey, Vars } from '@runpod-launcher/i18n';
/**
 * Turns a problem from the service into a sentence in the user's language.
 *
 * The service reports codes and numbers precisely so this step exists: it does
 * not know who is reading. Numbers arrive as numbers and are formatted here, so
 * German sees `18,1` and English `18.1`.
 */
export declare function describeProblem(problem: Problem, t: (key: MessageKey, vars?: Vars) => string, formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string): string;
//# sourceMappingURL=problems.d.ts.map