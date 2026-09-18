export interface Run {
  str: string;
  size: number;
  x: number;
  y: number;
  width: number;
  eol: boolean;
}
export interface Line {
  text: string;
  size: number;
  x: number;
  xEnd: number;
  y: number;
  hardBreak: boolean;
}
export type BlockKind = "title" | "heading" | "paragraph" | "placeholder";
export interface Block { kind: BlockKind; text: string; size?: number; top: number; bottom: number; left?: number; right?: number }
export interface PageBlocks { page: number; blocks: Block[] }
export const HEADING_RATIO: number;
export const TITLE_RATIO: number;
export const PARAGRAPH_GAP: number;
export const GLUE_GAP: number;
export const FIGURE_LABEL_MAX_CHARS: number;
export function runFromItem(item: { str: string; transform: number[]; width: number; hasEOL: boolean }): Run;
export function linesFromRuns(runs: Run[]): Line[];
export function bodySize(lines: Line[]): number;
export function blocksFromLines(lines: Line[], body: number): Block[];
export function renderBlock(block: Block): string;
export function documentToBlocks(pages: Run[][]): { pages: PageBlocks[]; bodySize: number };
export function spliceTables(
  blocks: Block[],
  tables: { top: number; bottom: number; left: number; right: number; markdown: string }[],
): Block[];
export function renderPages(pageBlocks: PageBlocks[]): string;
export function absorbFigureText(
  blocks: Block[],
  box: { t: number; b: number; l: number; r: number },
  maxChars?: number,
): { kept: Block[]; caption: string | null; labels: string[] };
export function insertFigurePlaceholders<F extends { kind: "picture" | "formula"; page: number; box: { t: number; b: number; l: number; r: number } | null }>(
  pageBlocks: PageBlocks[],
  figures: F[],
  placeholders: { picture: string; formula: string },
): { markdown: string; placed: (F & { caption?: string })[]; unplaced: F[] };
export function pageToMarkdown(runs: Run[], body: number): string;
export function documentToMarkdown(pages: Run[][]): { markdown: string; text: string; bodySize: number; headings: number };
