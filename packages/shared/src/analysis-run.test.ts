import { describe, expect, it } from 'vitest';
import { countsFromQcSummary, PROVIDER_LABELS } from './analysis-run';
import * as pkg from './index';

describe('countsFromQcSummary', () => {
  it('returns zeros when summary is missing', () => {
    expect(countsFromQcSummary(null)).toEqual({
      detectedSpaces: 0,
      acceptedSpaces: 0,
      rejectedSpaces: 0,
      acceptedDevices: 0,
      rejectedDevices: 0,
    });
  });

  it('maps placement counts from qc summary', () => {
    expect(countsFromQcSummary({
      detectedSpaces: 10,
      acceptedSpaces: 8,
      rejectedSpaces: 2,
      rawPlacements: 20,
      acceptedPlacements: 15,
      rejectedPlacements: 5,
      rejections: [],
    })).toEqual({
      detectedSpaces: 10,
      acceptedSpaces: 8,
      rejectedSpaces: 2,
      acceptedDevices: 15,
      rejectedDevices: 5,
    });
  });
});

/** Guard: public package entry must export analysis-run helpers (stale dist breaks API at runtime). */
describe('@planiq/shared package exports', () => {
  it('re-exports countsFromQcSummary from index', () => {
    expect(typeof pkg.countsFromQcSummary).toBe('function');
    expect(pkg.countsFromQcSummary({ acceptedPlacements: 1, rejectedPlacements: 0, detectedSpaces: 1, acceptedSpaces: 1, rejectedSpaces: 0, rawPlacements: 1, rejections: [] }).acceptedDevices).toBe(1);
  });

  it('exports PROVIDER_LABELS for UI', () => {
    expect(pkg.PROVIDER_LABELS.rules).toContain('rules');
  });
});
