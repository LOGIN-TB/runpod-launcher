/**
 * Machine-readable reasons a model cannot run, with the numbers needed to
 * phrase them.
 *
 * The service must not return finished sentences: it has no idea which language
 * the person reading them speaks. It reports what is wrong and the values
 * involved; the app turns that into a sentence in the user's language. Without
 * this the German UI shows English explanations, which is exactly what happened
 * before this existed.
 */
export type ProblemCode =
  | 'format-engine-mismatch'
  | 'fp8-unsupported-gpu'
  | 'does-not-fit'
  | 'tight-headroom'
  | 'repo-gated'
  | 'repo-missing'
  | 'hub-error'

export interface Problem {
  code: ProblemCode
  /** Substituted into the translated message. Numbers stay numbers so the app can format them. */
  params: Record<string, string | number>
}

export const problem = (code: ProblemCode, params: Problem['params'] = {}): Problem => ({ code, params })
