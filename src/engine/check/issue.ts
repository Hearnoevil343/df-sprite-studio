// Shared issue shape for the finder, validator and style checker, used by
// both the app and the command line.
export type Severity = 'error' | 'warn' | 'info';

export type Issue = {
  rule: string;
  severity: Severity;
  message: string;
  mod?: string;
  file?: string;
  creature?: string;
  caste?: string;
  key?: string;
  value?: string;
  band?: [number, number];
  pixels?: { x: number; y: number }[]; // sprite-local, for canvas highlighting
};
