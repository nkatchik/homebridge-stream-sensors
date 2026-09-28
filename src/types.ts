export type Category = 'animals' | 'packages' | 'people' | 'vehicles';

// Liveness of a stream's ffmpeg pump, surfaced to HomeKit via the MotionSensor's
// StatusActive/StatusFault characteristics so a dead camera/URL is visible.
//   connecting — started, no frame decoded yet (within the startup grace window)
//   online     — decoding frames normally
//   down       — no frames past the watchdog timeout (bad URL/creds, camera offline, …)
export type StreamHealth = 'connecting' | 'online' | 'down';

// ── Config input shape (exactly what the GUI form emits; the only accepted form) ─
// A sensor fires when ANY selected category is detected at or above `threshold`.
//   { categories: [...], name?, threshold? }
// Values are untrusted JSON, so every field is optional/loose here and validated
// in resolveSensors.
export interface RawSensor {
  name?: string;
  categories?: string[];
  threshold?: number;
  logStatus?: boolean;
}

export interface StreamConfig {
  name: string;
  url: string;
  checkInterval?: number; // seconds between detection checks on this stream
  sensors: RawSensor[];
}

// ── Resolved shape (internal; produced by resolveSensors) ──────────────────────
// One HomeKit motion sensor: fires when ANY category clears the threshold.
export interface SensorSpec {
  name: string;
  categories: Category[];
  threshold: number;
  logStatus: boolean;
}

export interface Detection {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
  classId: number;
  className: string;
}
