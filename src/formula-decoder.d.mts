export const FORMULA_MODEL_ID: string;
export const FORMULA_MODEL_FILES: string[];
export function formulaDecodingEnabled(env?: NodeJS.ProcessEnv): boolean;
export function formulaTimeoutMs(env?: NodeJS.ProcessEnv): number;
export function formulaModelDir(env?: NodeJS.ProcessEnv): string;
export function missingFormulaFiles(dir?: string): Promise<string[]>;
export function argmaxLast(
  logits: ArrayLike<number>,
  seqLen: number,
  vocab: number,
): number;
export function tidyLatex(latex: string): string;
export function resetFormulaDecoder(): void;
/** Cropped formula PNG to LaTeX. null on ANY failure — caller keeps the placeholder. */
export function decodeFormula(
  png: Buffer,
  options?: { dir?: string; timeoutMs?: number; maxTokens?: number },
): Promise<string | null>;
