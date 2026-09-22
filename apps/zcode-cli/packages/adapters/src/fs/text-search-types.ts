import type { RgArg } from "ripgrep";
import type {
  FileSystemSearchTextEntry,
  FileSystemSearchTextRequest,
  FileSystemTextSearchOutputMode,
} from "@zcode/contracts";

export interface TextSearchResult {
  matchCount: number;
  entries: FileSystemSearchTextEntry[];
}

export interface LineRange {
  start: number;
  end: number;
}

export interface OnlyMatchingMatches {
  matchCount: number;
  ranges: LineRange[];
  entriesByLine: Map<number, FileSystemSearchTextEntry[]>;
}

export interface RipgrepSearchPlan {
  args: RgArg[];
  outputRoot: string;
  preopens: Record<string, string>;
}

export interface ParsedTextSearch {
  entries: FileSystemSearchTextEntry[];
  files: string[];
  numMatches: number;
}

export interface FinishTextSearchParams {
  path: string;
  pattern: string;
  mode: FileSystemTextSearchOutputMode;
  startedAt: number;
  request: FileSystemSearchTextRequest;
  files: string[];
  entries: FileSystemSearchTextEntry[];
  numMatches: number;
}
