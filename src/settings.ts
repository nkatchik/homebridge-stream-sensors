export const PLATFORM_NAME = 'StreamSensors';
export const PLUGIN_NAME = 'homebridge-stream-sensors';

// Frame dimensions — must match yolo26n.onnx (non-dynamic [1,3,576,1024])
export const FRAME_WIDTH = 1024;
export const FRAME_HEIGHT = 576;

// Detection: default interval in milliseconds, config bounds in seconds.
export const SAMPLE_MS = 2_000;
export const CHECK_INTERVAL_MIN = 1;
export const CHECK_INTERVAL_MAX = 3_600;
export const THRESHOLD = 0.5;
export const THRESHOLD_KEEP = 0.05;
export const AREA_MIN_FRAC = 0.002;

// Keep decoding at 1 fps for fresh frames at the minimum check interval and
// continuous stream-health checks, even when inference runs less often.
export const FFMPEG_FPS = 1;
export const FFMPEG_TIMEOUT_FRAME_MS = 10_000;
export const FFMPEG_TIMEOUT_RESTART_MS = 60_000;

// IR normalization
export const IR_GAMMA = 0.7;
export const IR_CLIP_LOW_PCT = 0.01;
export const IR_CLIP_HIGH_PCT = 0.99;
