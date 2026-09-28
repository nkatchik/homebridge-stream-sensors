import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamWorker } from '../src/stream.js';
import type { SensorSpec, Detection } from '../src/types.js';

// Store each FfmpegPump instance so tests can control it.
const pumpInstances: {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  takeFrame: ReturnType<typeof vi.fn>;
}[] = [];

vi.mock('../src/ffmpeg.js', () => ({
  FfmpegPump: vi.fn(function (this: (typeof pumpInstances)[number]) {
    this.start = vi.fn();
    this.stop = vi.fn();
    this.takeFrame = vi.fn().mockReturnValue(null);
    pumpInstances.push(this);
  }),
}));

const URL = 'rtsp://test/stream';
const sensors: SensorSpec[] = [
  {
    name: 'Test Animals Sensor',
    categories: ['animals'],
    threshold: 0.5,
    logStatus: false,
  },
  {
    name: 'Test People Sensor',
    categories: ['people'],
    threshold: 0.5,
    logStatus: false,
  },
];

const fakeLog = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
} as never;

// Default infer stub: no detections.
const noDetections = (): Promise<Detection[]> => Promise.resolve([]);

beforeEach(() => {
  pumpInstances.length = 0;
  vi.clearAllMocks();
});

describe('check interval', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([undefined, 1_000, 5_000])(
    'spaces checks by %s ms, including inference time (default 2000)',
    async (interval) => {
      const infer = vi.fn(
        () => new Promise<Detection[]>((resolve) => setTimeout(() => resolve([]), 200)),
      );
      const worker = new StreamWorker(
        URL,
        'Garden',
        sensors,
        () => {},
        () => {},
        infer,
        fakeLog,
        interval,
      );
      pumpInstances[0].takeFrame.mockReturnValue(Buffer.alloc(1));
      worker.start();
      try {
        expect(infer).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync((interval ?? 2_000) - 1);
        expect(infer).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(infer).toHaveBeenCalledTimes(2);
      } finally {
        worker.stop();
        await vi.advanceTimersByTimeAsync(200);
        await worker.waitForStop();
      }
    },
  );

  it('waits for slow inference before starting the next check', async () => {
    const infer = vi.fn(
      () => new Promise<Detection[]>((resolve) => setTimeout(() => resolve([]), 1_500)),
    );
    const worker = new StreamWorker(
      URL,
      'Garden',
      sensors,
      () => {},
      () => {},
      infer,
      fakeLog,
      1_000,
    );
    pumpInstances[0].takeFrame.mockReturnValue(Buffer.alloc(1));
    worker.start();
    try {
      await vi.advanceTimersByTimeAsync(1_499);
      expect(infer).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(infer).toHaveBeenCalledTimes(2);
    } finally {
      worker.stop();
      await vi.advanceTimersByTimeAsync(1_500);
      await worker.waitForStop();
    }
  });

  it('interrupts a long configured interval immediately on shutdown', async () => {
    const infer = vi.fn(noDetections);
    const worker = new StreamWorker(
      URL,
      'Garden',
      sensors,
      () => {},
      () => {},
      infer,
      fakeLog,
      3_600_000,
    );
    pumpInstances[0].takeFrame.mockReturnValue(Buffer.alloc(1));
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    worker.stop();
    await worker.waitForStop();
    expect(infer).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('StreamWorker.stop()', () => {
  it('interrupts the sleep so the loop exits well under SAMPLE_MS', async () => {
    const worker = new StreamWorker(
      URL,
      'Front Door',
      sensors,
      () => {},
      () => {},
      noDetections,
      fakeLog,
    );
    worker.start();

    const t0 = Date.now();
    worker.stop();
    await new Promise((r) => setImmediate(r));

    expect(Date.now() - t0).toBeLessThan(200); // SAMPLE_MS is 2000ms
  });

  it('waitForStop() resolves promptly even when inference was in-flight at stop()', async () => {
    // infer that takes 100ms — longer than any reasonable loop overhead.
    const slowInfer = (): Promise<Detection[]> =>
      new Promise((res) => setTimeout(() => res([]), 100));

    const worker = new StreamWorker(
      URL,
      'Front Door',
      sensors,
      () => {},
      () => {},
      slowInfer,
      fakeLog,
    );
    pumpInstances[0]?.takeFrame.mockReturnValueOnce(Buffer.alloc(1024 * 576 * 3));
    worker.start();

    await new Promise((r) => setImmediate(r)); // let loop reach infer()
    worker.stop();

    const t0 = Date.now();
    await worker.waitForStop();

    // Must resolve within the infer duration (~100ms) plus margin,
    // NOT after SAMPLE_MS (2000ms) which the old code would have waited.
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('does not emit any sensor state when stop() fires during inference', async () => {
    // infer resolves an animal detection only after we let it.
    let resolveInfer!: () => void;
    const gatedInfer = (): Promise<Detection[]> =>
      new Promise((res) => {
        resolveInfer = () =>
          res([
            {
              x1: 0,
              y1: 0,
              x2: 200,
              y2: 200,
              score: 0.9,
              classId: 15,
            },
          ]);
      });

    const sensorEvents: Array<[number, boolean]> = [];
    const worker = new StreamWorker(
      URL,
      'Front Door',
      sensors,
      (i, active) => sensorEvents.push([i, active]),
      () => {},
      gatedInfer,
      fakeLog,
    );

    pumpInstances[0]?.takeFrame.mockReturnValueOnce(Buffer.alloc(1024 * 576 * 3));
    worker.start();

    // Give the loop time to reach the infer() await.
    await new Promise((r) => setImmediate(r));

    // stop() while inference is pending.
    worker.stop();

    // Now let inference resolve (after stop).
    resolveInfer();
    await new Promise((r) => setTimeout(r, 50));

    // updateSensors should have returned early — no state pushed at all.
    expect(sensorEvents).toHaveLength(0);
  });
});

describe('threshold gating', () => {
  // A dog detection at confidence 0.30: below the default 0.5, above a 0.25 override.
  const dogAt = (score: number): Detection[] => [
    {
      x1: 0,
      y1: 0,
      x2: 300,
      y2: 300,
      score,
      classId: 16,
    },
  ]; // 16 = dog → animals

  it('a low-threshold sensor turns on for a detection the default would miss', async () => {
    const lowThreshold: SensorSpec[] = [
      {
        name: 'Sensitive Animals',
        categories: ['animals'],
        threshold: 0.25,
        logStatus: false,
      },
    ];
    const fired: Array<[number, boolean]> = [];
    const worker = new StreamWorker(
      URL,
      'Front Door',
      lowThreshold,
      (i, a) => fired.push([i, a]),
      () => {},
      () => Promise.resolve(dogAt(0.3)),
      fakeLog,
    );

    pumpInstances[0]?.takeFrame.mockReturnValueOnce(Buffer.alloc(1024 * 576 * 3));
    worker.start();
    await new Promise((r) => setTimeout(r, 30));
    worker.stop();

    expect(fired.some(([, active]) => active)).toBe(true);
  });

  it('a default-threshold sensor stays off for the same weak detection', async () => {
    const fired: Array<[number, boolean]> = [];
    const worker = new StreamWorker(
      URL,
      'Front Door',
      sensors,
      (i, a) => fired.push([i, a]),
      () => {},
      () => Promise.resolve(dogAt(0.3)),
      fakeLog,
    );

    pumpInstances[0]?.takeFrame.mockReturnValueOnce(Buffer.alloc(1024 * 576 * 3));
    worker.start();
    await new Promise((r) => setTimeout(r, 30));
    worker.stop();

    // Level-triggered: it reports false every sample, but never true.
    expect(fired.some(([, active]) => active)).toBe(false);
  });
});
