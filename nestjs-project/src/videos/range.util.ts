import type { ByteRange } from '../storage/storage.types';

export type RangeParseResult = ByteRange | 'unsatisfiable' | null;

const RANGE_PATTERN = /^(\d*)-(\d*)$/;

/**
 * Parses an HTTP `Range` header against an object of `totalSize` bytes.
 * Returns `null` when the header is absent or malformed (serve the full body,
 * as RFC 9110 allows), `'unsatisfiable'` when no byte of the range exists, or
 * the inclusive byte range. Multiple ranges are served as the first one.
 */
export function parseRange(
  header: string | undefined,
  totalSize: number,
): RangeParseResult {
  if (!header) return null;
  const [unit, spec] = header.split('=', 2);
  if (unit.trim().toLowerCase() !== 'bytes' || spec === undefined) return null;

  const match = RANGE_PATTERN.exec(spec.split(',')[0].trim());
  if (!match) return null;
  const [, startText, endText] = match;
  if (startText === '' && endText === '') return null;

  if (startText === '') {
    // Suffix range: the last N bytes
    const suffix = Number(endText);
    if (suffix === 0 || totalSize === 0) return 'unsatisfiable';
    return { start: Math.max(totalSize - suffix, 0), end: totalSize - 1 };
  }

  const start = Number(startText);
  if (start >= totalSize) return 'unsatisfiable';
  const end = endText === '' ? totalSize - 1 : Number(endText);
  if (end < start) return null;
  return { start, end: Math.min(end, totalSize - 1) };
}
