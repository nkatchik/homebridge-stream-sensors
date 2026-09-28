import type { Logger } from 'homebridge';
import { FfmpegPump } from './ffmpeg.js';
import { scoreCategories } from './detector.js';
import type { CategoryScores } from './detector.js';
import type { SensorSpec, Detection, StreamHealth } from './types.js';
import { SAMPLE_MS } from './settings.js';

export type SensorStateCallback = (sensorIndex: number, active: boolean) => void;
export type StreamHealthCallback = (health: StreamHealth) => void;
export type InferFn = (frame: Buffer) => Promise<Detection[]>;

export class StreamWorker {
  private readonly pump: FfmpegPump;
  private running = true;
  private wakeUp: (() => void) | null = null;
  private loopDone: Promise<void> = Promise.resolve();

  constructor(
    url: string,
    name: string,
    private readonly sensors: SensorSpec[],
    private readonly onSensorState: SensorStateCallback,
    onHealth: StreamHealthCallback,
    private readonly infer: InferFn,
    private readonly log: Logger,
    private readonly checkIntervalMs = SAMPLE_MS,
  ) {
    this.pump = new FfmpegPump(url, name, log, onHealth);
  }

  start(): void {
    this.pump.start();
    this.loopDone = this.loop();
  }

  stop(): void {
    this.running = false;
    this.wakeUp?.(); // interrupt any in-progress sleep immediately
    this.pump.stop();
  }

  // Resolves once the detection loop has fully exited.
  // Await this before releasing shared resources (e.g. the ONNX session).
  waitForStop(): Promise<void> {
    return this.loopDone;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const frame = this.pump.takeFrame();
      if (!frame) {
        await this.sleep(50);
        continue;
      }

      const t0 = Date.now();
      try {
        const detections = await this.infer(frame);
        const scores = scoreCategories(detections);
        this.logScores(scores);
        this.updateSensors(scores);
      } catch (e) {
        this.log.error('Detection error:', String(e));
      }

      const elapsed = Date.now() - t0;
      if (elapsed < this.checkIntervalMs) await this.sleep(this.checkIntervalMs - elapsed);
    }
  }

  // Interruptible sleep: resolves immediately if already stopped,
  // or can be cut short by stop() calling this.wakeUp().
  private sleep(ms: number): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  // Debug-only: log the best confidence seen per category this sample so users
  // tuning thresholds can see how close a detection came to firing. Quiet by
  // default (debug level); only emitted when something cleared the area filter.
  private logScores(scores: CategoryScores): void {
    if (scores.size === 0) return;
    const summary = [...scores.entries()].map(([c, s]) => `${c} ${s.toFixed(2)}`).join(', ');
    this.log.debug(`Detection scores: ${summary}`);
  }

  private updateSensors(scores: CategoryScores): void {
    // Guard: stop() may have fired while inference was in-flight.
    if (!this.running) return;

    // Level-triggered: each sample reports the sensor's current state directly —
    // detected this frame, or not. No cooldown or auto-off; the next sample
    // (at the configured interval) clears it once the subject leaves. The
    // accessory dedupes unchanged values, so this is a no-op when nothing changed.
    this.sensors.forEach((sensor, i) => {
      const detected = sensor.categories.some((c) => (scores.get(c) ?? 0) >= sensor.threshold);
      this.onSensorState(i, detected);
    });
  }
}
