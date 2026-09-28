import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  SAMPLE_MS,
  CHECK_INTERVAL_MIN,
  CHECK_INTERVAL_MAX,
} from './settings.js';
import { StreamSensorAccessory } from './accessory.js';
import { StreamWorker } from './stream.js';
import { loadModel, closeModel, runInference } from './inference.js';
import { resolveSensors } from './categories.js';
import type { StreamConfig, SensorSpec } from './types.js';

export class StreamSensorsPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  private readonly workers: StreamWorker[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.api.on('shutdown', () => {
      // Stop all workers (sets running=false, kills ffmpeg, interrupts sleeps),
      // then wait for every detection loop to exit before releasing the model —
      // guarantees no runInference() call is in-flight at release.
      const draining = this.workers.map((w) => {
        w.stop();
        return w.waitForStop();
      });
      this.workers.length = 0;
      Promise.all(draining)
        .then(() => closeModel())
        .catch((err) => this.log.error('Error during shutdown:', String(err)));
    });

    this.api.on('didFinishLaunching', () => {
      // Don't load the model or spawn any workers until the plugin is configured.
      // With no streams, discoverDevices() still runs to unregister any stale
      // cached accessories (e.g. left over after the user removed every stream),
      // but it creates no workers — so nothing heavyweight starts.
      const streams: StreamConfig[] = this.config.streams ?? [];
      if (streams.length === 0) {
        this.log.info('No streams configured — nothing to detect.');
        this.discoverDevices();
        return;
      }

      loadModel()
        .then(() => this.log.info('YOLO model loaded'))
        .catch((err) => {
          this.log.error('Failed to load YOLO model:', String(err));
          throw err;
        })
        .then(() => this.discoverDevices())
        .catch((err) => this.log.error('Failed to initialize accessories:', String(err)));
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.push(accessory);
  }

  private discoverDevices(): void {
    const streams: StreamConfig[] = this.config.streams ?? [];
    const seenUUIDs = new Set<string>();
    // Sensor names are the accessory identity, so they must be unique across the
    // whole config — a collision would map two sensors onto one HomeKit accessory.
    const claimedNames = new Set<string>();

    for (const stream of streams) {
      const streamName = typeof stream.name === 'string' ? stream.name.trim() : '';
      if (!streamName) {
        this.log.error(
          `Stream ${stream.url ?? '(no url)'} is missing a required "name" — skipping this stream`,
        );
        continue;
      }

      const resolved = resolveSensors(streamName, stream.sensors ?? [], (msg) =>
        this.log.warn(msg),
      );

      // Drop sensors whose final name collides with one already claimed.
      const sensors: SensorSpec[] = [];
      for (const sensor of resolved) {
        if (claimedNames.has(sensor.name)) {
          this.log.error(
            `Duplicate sensor name "${sensor.name}" — names must be unique; skipping the duplicate`,
          );
          continue;
        }
        claimedNames.add(sensor.name);
        sensors.push(sensor);
      }

      // No sensors → nothing to detect. Don't spawn ffmpeg or run inference for
      // this stream; its stale accessories (if any) are cleaned up below.
      if (sensors.length === 0) {
        this.log.warn(`Stream "${streamName}" has no sensors — not starting it`);
        continue;
      }

      let checkInterval = stream.checkInterval ?? SAMPLE_MS / 1_000;
      if (
        !Number.isInteger(checkInterval) ||
        checkInterval < CHECK_INTERVAL_MIN ||
        checkInterval > CHECK_INTERVAL_MAX
      ) {
        this.log.warn(
          `Stream "${streamName}" checkInterval "${checkInterval}" must be a whole number ` +
            `from ${CHECK_INTERVAL_MIN} to ${CHECK_INTERVAL_MAX} seconds; using ${SAMPLE_MS / 1_000}`,
        );
        checkInterval = SAMPLE_MS / 1_000;
      }

      const sensorAccessories: StreamSensorAccessory[] = sensors.map((sensor) => {
        const uuid = this.api.hap.uuid.generate(sensor.name);
        seenUUIDs.add(uuid);

        const existing = this.accessories.find((a) => a.UUID === uuid);
        let pa: PlatformAccessory;

        if (existing) {
          this.log.info('Restoring accessory:', sensor.name);
          pa = existing;
        } else {
          this.log.info('Adding accessory:', sensor.name);
          pa = new this.api.platformAccessory(sensor.name, uuid);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [pa]);
        }

        return new StreamSensorAccessory(this, pa, sensor.name, sensor.logStatus);
      });

      const worker = new StreamWorker(
        stream.url,
        streamName,
        sensors,
        (i, active) => sensorAccessories[i]?.setMotion(active),
        // Stream health is per-pump, so fan it out to every sensor on this stream.
        (health) => sensorAccessories.forEach((a) => a.setHealth(health)),
        (frame) => runInference(frame),
        this.log,
        checkInterval * 1_000,
      );
      worker.start();
      this.workers.push(worker);
    }

    const stale = this.accessories.filter((a) => !seenUUIDs.has(a.UUID));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info('Removing stale accessories:', stale.map((a) => a.displayName).join(', '));
    }
  }
}
