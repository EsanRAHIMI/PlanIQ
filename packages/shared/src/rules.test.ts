import { describe, it, expect } from 'vitest';
import { suggestPlacements } from './rules';
import type { Room, Zone } from './types';

const room = (type: any, cx: number, cy: number, area = 0.1): Room => ({
  label: type, type, polygon: [[cx - 0.1, cy - 0.1], [cx + 0.1, cy - 0.1], [cx + 0.1, cy + 0.1], [cx - 0.1, cy + 0.1]],
  centroid: [cx, cy], area, confidence: 0.9, source: 'cv',
});

describe('rule engine', () => {
  it('places CCTV on the four building corners', () => {
    const p = suggestPlacements([room('living_room', 0.5, 0.5)], []);
    expect(p.filter((x) => x.deviceCode === 'CCTV').length).toBeGreaterThanOrEqual(4);
  });

  it('places gate motor + intercom bell at a gate zone', () => {
    const zones: Zone[] = [{ type: 'gate', geometry: { kind: 'point', coords: [[0.5, 0.95]] }, confidence: 0.8, source: 'cv' }];
    const p = suggestPlacements([room('living_room', 0.5, 0.5)], zones);
    expect(p.some((x) => x.deviceCode === 'GATE_MOTOR')).toBe(true);
    expect(p.some((x) => x.deviceCode === 'INTERCOM_BELL')).toBe(true);
  });

  it('puts the ELV rack in a service area', () => {
    const p = suggestPlacements([room('service_area', 0.2, 0.2), room('living_room', 0.6, 0.6)], []);
    const rack = p.find((x) => x.deviceCode === 'ELV_RACK');
    expect(rack).toBeDefined();
    expect(rack!.rationale).toContain('service');
  });

  it('adds a thermostat to bedrooms', () => {
    const p = suggestPlacements([room('master_bedroom', 0.3, 0.3)], []);
    expect(p.some((x) => x.deviceCode === 'THERMOSTAT')).toBe(true);
  });

  it('every placement is editable AI suggestion (source ai, unreviewed)', () => {
    const p = suggestPlacements([room('majlis', 0.5, 0.5)], []);
    expect(p.every((x) => x.source === 'ai' && x.reviewed === false)).toBe(true);
  });
});
