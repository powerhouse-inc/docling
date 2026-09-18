export interface TableRun {
  str: string;
  x: number;
  y: number;
  width: number;
  size: number;
}
export interface DetectedTable {
  top: number;
  bottom: number;
  left: number;
  right: number;
  grid: string[][];
}
export interface TableOptions {
  rowTolerance: number;
  columnGap: number;
  minColumns: number;
  minRows: number;
  minValueShare: number;
  maxCellChars: number;
  maxRowsBetween: number;
  narrowColumns: number;
  minRowsNarrow: number;
  minValueShareNarrow: number;
}
export const DEFAULT_TABLE_OPTIONS: TableOptions;
export function groupRows(runs: TableRun[], tolerance?: number): { y: number; runs: TableRun[] }[];
export function columnBands(rows: { runs: { x: number; width: number }[] }[], gap?: number): { left: number; right: number }[];
export function detectTables(runs: TableRun[], options?: Partial<TableOptions>): DetectedTable[];
export function renderTable(grid: string[][], options?: Partial<TableOptions>): string;
