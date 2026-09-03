import {
  FAILURE_CODE_DESCRIPTIONS,
  FailureCode,
  isFailureCode,
} from './failure-code.js';

describe('FailureCode taxonomy', () => {
  it('exposes stable machine-readable string codes', () => {
    for (const code of Object.values(FailureCode)) {
      expect(typeof code).toBe('string');
      expect(code).toMatch(/^[A-Z][A-Z_]+$/);
    }
  });

  it('documents every registered code', () => {
    const codes = Object.values(FailureCode) as string[];
    const described = Object.keys(FAILURE_CODE_DESCRIPTIONS);
    expect(described).toEqual(expect.arrayContaining(codes));
    expect(described.length).toBe(codes.length);
    for (const code of codes) {
      expect(
        FAILURE_CODE_DESCRIPTIONS[code as keyof typeof FailureCode].length,
      ).toBeGreaterThan(0);
    }
  });

  it('guards values with isFailureCode', () => {
    expect(isFailureCode(FailureCode.REFERENCE_NOT_FOUND)).toBe(true);
    expect(isFailureCode('UNKNOWN')).toBe(false);
    expect(isFailureCode(42)).toBe(false);
    expect(isFailureCode(undefined)).toBe(false);
  });
});
