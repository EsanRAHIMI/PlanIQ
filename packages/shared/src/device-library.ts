/** Seed device catalog. `null` tenant in DB = global default. Mirrors the legend symbols. */
export type DeviceCategory =
  | 'cctv' | 'network' | 'elv' | 'smart_home' | 'audio' | 'access' | 'annotation';

export interface DeviceDef {
  code: string;
  name: string;
  category: DeviceCategory;
  icon: string;          // filename in apps/web/public/icons
  color: string;         // legend color
  defaultProps: Record<string, unknown>;
  placementRules: string[]; // rule ids (see rules.ts)
  order: number;
}

const RED = '#E11D2A';
const BLUE = '#2563EB';
const GREEN = '#16A34A';
const AMBER = '#D97706';
const PURPLE = '#7C3AED';

export const DEVICE_LIBRARY: DeviceDef[] = [
  // ── CCTV ──
  { code: 'CCTV', name: 'CCTV Camera', category: 'cctv', icon: 'cctv.svg', color: RED,
    defaultProps: { mountHeight: 3.0, fov: 90, coverageRadius: 12, type: 'bullet' }, placementRules: ['cctv'], order: 10 },
  { code: 'CCTV_DOME', name: 'CCTV Dome Camera', category: 'cctv', icon: 'cctv-dome.svg', color: RED,
    defaultProps: { mountHeight: 2.7, fov: 360, coverageRadius: 8 }, placementRules: ['cctv'], order: 11 },
  { code: 'NVR', name: 'Server / NVR', category: 'cctv', icon: 'nvr.svg', color: RED,
    defaultProps: { channels: 16 }, placementRules: ['rack'], order: 12 },

  // ── Network ──
  { code: 'WIFI_AP', name: 'Wi-Fi Access Point', category: 'network', icon: 'wifi-ap.svg', color: BLUE,
    defaultProps: { mountHeight: 2.7, coverageRadius: 10, band: 'dual' }, placementRules: ['wifi'], order: 20 },
  { code: 'SWITCH', name: 'Network Switch', category: 'network', icon: 'switch.svg', color: BLUE,
    defaultProps: { ports: 24 }, placementRules: ['rack'], order: 21 },
  { code: 'DATA_SOCKET', name: 'Data Socket', category: 'network', icon: 'data.svg', color: BLUE,
    defaultProps: { mountHeight: 0.3, cat: '6A' }, placementRules: ['data'], order: 22 },

  // ── ELV ──
  { code: 'ELV_RACK', name: 'ELV Rack', category: 'elv', icon: 'rack.svg', color: AMBER,
    defaultProps: { u: 18 }, placementRules: ['rack'], order: 30 },
  { code: 'DUCT', name: 'Duct / Conduit Marker', category: 'elv', icon: 'duct.svg', color: AMBER,
    defaultProps: { diameter: 25 }, placementRules: [], order: 31 },

  // ── Access / Intercom ──
  { code: 'INTERCOM_SCREEN', name: 'Intercom Screen', category: 'access', icon: 'intercom-screen.svg', color: RED,
    defaultProps: { mountHeight: 1.4 }, placementRules: ['intercom_indoor'], order: 40 },
  { code: 'INTERCOM_BELL', name: 'Intercom Bell', category: 'access', icon: 'intercom-bell.svg', color: RED,
    defaultProps: { mountHeight: 1.4 }, placementRules: ['intercom_outdoor'], order: 41 },
  { code: 'SMART_LOCK', name: 'Smart Lock', category: 'access', icon: 'smart-lock.svg', color: RED,
    defaultProps: {}, placementRules: ['access_door'], order: 42 },
  { code: 'GATE_MOTOR', name: 'Gate Motor', category: 'access', icon: 'gate-motor.svg', color: RED,
    defaultProps: { type: 'sliding' }, placementRules: ['gate'], order: 43 },

  // ── Smart Home ──
  { code: 'THERMOSTAT', name: 'AC Thermostat', category: 'smart_home', icon: 'thermostat.svg', color: RED,
    defaultProps: { mountHeight: 1.4 }, placementRules: ['thermostat'], order: 50 },
  { code: 'SENSOR', name: 'Sensor', category: 'smart_home', icon: 'sensor.svg', color: GREEN,
    defaultProps: { kind: 'motion', mountHeight: 2.7 }, placementRules: ['sensor'], order: 51 },
  { code: 'CURTAIN_MOTOR', name: 'Curtain Motor', category: 'smart_home', icon: 'curtain-motor.svg', color: RED,
    defaultProps: {}, placementRules: ['curtain'], order: 52 },
  { code: 'LIGHT_SWITCH', name: 'Light Switch', category: 'smart_home', icon: 'switch-light.svg', color: RED,
    defaultProps: { mountHeight: 1.3, gangs: 2 }, placementRules: ['switch'], order: 53 },
  { code: 'PUSH_BUTTON', name: 'Push Button', category: 'smart_home', icon: 'push-button.svg', color: RED,
    defaultProps: { mountHeight: 1.3 }, placementRules: ['switch'], order: 54 },
  { code: 'CONTROL_PANEL', name: 'Control Panel Tablet', category: 'smart_home', icon: 'control-panel.svg', color: RED,
    defaultProps: { mountHeight: 1.4 }, placementRules: ['control_panel'], order: 55 },

  // ── Audio / AV ──
  { code: 'SPEAKER', name: 'Speaker', category: 'audio', icon: 'speaker.svg', color: PURPLE,
    defaultProps: { mountHeight: 2.7, zone: 1 }, placementRules: ['speaker'], order: 60 },
  { code: 'VOLUME_CONTROL', name: 'Volume Control', category: 'audio', icon: 'volume.svg', color: PURPLE,
    defaultProps: { mountHeight: 1.3 }, placementRules: ['volume'], order: 61 },
  { code: 'PROJECTOR', name: 'Projector', category: 'audio', icon: 'projector.svg', color: PURPLE,
    defaultProps: { mountHeight: 2.8 }, placementRules: ['projector'], order: 62 },
  { code: 'SCREEN', name: 'Screen', category: 'audio', icon: 'screen.svg', color: PURPLE,
    defaultProps: {}, placementRules: ['screen'], order: 63 },
];

export const DEVICE_BY_CODE: Record<string, DeviceDef> =
  Object.fromEntries(DEVICE_LIBRARY.map((d) => [d.code, d]));

export const DEFAULT_LAYERS = [
  { name: 'CCTV', color: RED, categories: ['cctv'] },
  { name: 'Network / Wi-Fi', color: BLUE, categories: ['network'] },
  { name: 'ELV', color: AMBER, categories: ['elv'] },
  { name: 'Smart Home', color: GREEN, categories: ['smart_home', 'access'] },
  { name: 'Audio / AV', color: PURPLE, categories: ['audio'] },
  { name: 'Annotations', color: '#475569', categories: ['annotation'] },
];
