import { parseRange } from './range.util';

const TOTAL = 1000;

describe('parseRange', () => {
  it('should return null without a header', () => {
    expect(parseRange(undefined, TOTAL)).toBeNull();
  });

  it('should parse a closed range', () => {
    expect(parseRange('bytes=0-99', TOTAL)).toEqual({ start: 0, end: 99 });
  });

  it('should parse an open-ended range to the last byte', () => {
    expect(parseRange('bytes=900-', TOTAL)).toEqual({ start: 900, end: 999 });
  });

  it('should parse a suffix range as the last N bytes', () => {
    expect(parseRange('bytes=-100', TOTAL)).toEqual({ start: 900, end: 999 });
  });

  it('should clamp a suffix larger than the object to the whole object', () => {
    expect(parseRange('bytes=-5000', TOTAL)).toEqual({ start: 0, end: 999 });
  });

  it('should clamp an end beyond the object to the last byte', () => {
    expect(parseRange('bytes=500-99999', TOTAL)).toEqual({
      start: 500,
      end: 999,
    });
  });

  it('should serve only the first of multiple ranges', () => {
    expect(parseRange('bytes=0-9, 20-29', TOTAL)).toEqual({ start: 0, end: 9 });
  });

  it('should report a start beyond the object as unsatisfiable', () => {
    expect(parseRange('bytes=1000-', TOTAL)).toBe('unsatisfiable');
    expect(parseRange('bytes=99999999999-', TOTAL)).toBe('unsatisfiable');
  });

  it('should report a zero-length suffix as unsatisfiable', () => {
    expect(parseRange('bytes=-0', TOTAL)).toBe('unsatisfiable');
  });

  it.each(['items=0-9', 'bytes=abc', 'bytes=-', 'bytes=9-0', 'bytes'])(
    'should ignore the malformed header %p',
    (header) => {
      expect(parseRange(header, TOTAL)).toBeNull();
    },
  );
});
