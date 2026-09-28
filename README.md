# homebridge-stream-sensors

[![verified-by-homebridge](https://img.shields.io/badge/_-verified-blueviolet?color=%23491F59&style=flat&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![CI](https://github.com/nikitakatchik/homebridge-stream-sensors/actions/workflows/ci.yml/badge.svg)](https://github.com/nikitakatchik/homebridge-stream-sensors/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/homebridge-stream-sensors)](https://www.npmjs.com/package/homebridge-stream-sensors)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-stream-sensors)](https://www.npmjs.com/package/homebridge-stream-sensors)
[![GitHub stars](https://img.shields.io/github/stars/nikitakatchik/homebridge-stream-sensors?style=flat)](https://github.com/nikitakatchik/homebridge-stream-sensors/stargazers)
[![license](https://img.shields.io/npm/l/homebridge-stream-sensors)](./LICENSE)


**Turn any camera stream into HomeKit motion sensors with local YOLO object** <br />
**detection for `🐶 Animals`, `📦 Packages`, `🧍 People`, `🚗 Vehicles`.**

## Installation

### Homebridge UI

1. Open the **Plugins** tab in the Homebridge UI.
1. Search for `homebridge-stream-sensors`.
1. Click **Install**.

### Command line

```bash
npm install -g homebridge-stream-sensors
```

## Configuration

### Homebridge UI

Configure everything from the plugin settings form.
1. Add a **video stream**.
2. Paste your **camera/stream URL**.
3. Tick the **categories** you want.
4. Click **Save**.

### Manual (config.json)

Add a `StreamSensors` platform to your Homebridge config. Each **stream** is one camera; each **sensor** fires when any of its selected categories is detected.

```json
{
  "platforms": [
    {
      "platform": "StreamSensors",
      "streams": [
        {
          "name": "Front Door",
          "url": "rtsp://user:password@192.168.1.50:8554/stream",
          "checkInterval": 2,
          "sensors": [
            { "categories": ["people", "packages"] },
            { "categories": ["vehicles"], "threshold": 0.6 }
          ]
        }
      ]
    }
  ]
}
```

- **`name`** — used as a prefix for auto-named sensors (e.g. `Front Door People & Packages Sensor`).
- **`url`** — any ffmpeg-readable stream URL (RTSP is typical).
- **`checkInterval`** *(optional, per stream)* — whole seconds between detection checks, from 1–3600 (default `2`). Set to `1` for more frequent checks. All sensors on the stream share this interval; shorter intervals use more CPU. If inference takes longer, the next check starts when it finishes. Sensors clear on the next check without a matching detection.
- **`categories`** — one or more of `animals`, `packages`, `people`, `vehicles`. The sensor triggers on any of them.
- **`threshold`** *(optional)* — detection confidence from 0–1 (default `0.5`). Lower is more sensitive.

## Camera setup examples

Most cameras expose an RTSP URL — paste it as the stream **URL**. The exact path varies by brand, model, and firmware, so when in doubt look your model up in a community database like the [iSpy camera connection database](https://www.ispyconnect.com/cameras) or your camera's manual.

Common RTSP URL patterns (replace `user`, `pass`, and the IP address):

| Brand | Main stream | Substream (low-res) |
| --- | --- | --- |
| **Reolink** | `rtsp://user:pass@IP:554/h264Preview_01_main` | `rtsp://user:pass@IP:554/h264Preview_01_sub` |
| **Hikvision** | `rtsp://user:pass@IP:554/Streaming/Channels/101` | `rtsp://user:pass@IP:554/Streaming/Channels/102` |
| **Dahua / Amcrest** | `rtsp://user:pass@IP:554/cam/realmonitor?channel=1&subtype=0` | `rtsp://user:pass@IP:554/cam/realmonitor?channel=1&subtype=1` |
| **TP-Link Tapo** | `rtsp://user:pass@IP:554/stream1` | `rtsp://user:pass@IP:554/stream2` |

- **UniFi Protect** — enable **RTSP** on the camera in the Protect app (Settings → Advanced), which generates a per-camera `rtsps://…:7441/…` URL to paste here.
- **ONVIF cameras** — if you can't find the path, an ONVIF discovery tool (e.g. ONVIF Device Manager) will report the exact RTSP URL.
- **Wyze** — RTSP requires Wyze's separate RTSP firmware, which is unofficial and unmaintained; a standalone bridge that re-exposes the camera as RTSP is more reliable.
- **Docker** — no special config needed: the plugin forces RTSP over **TCP**, which avoids the dropped-UDP-media problem common on Docker's bridge network.

### Prefer the substream

Point the plugin at your camera's **substream** (the low-resolution secondary stream) when one is available. Every frame is downscaled to a fixed size before inference, so a substream doesn't lower the inference cost — but it does cut the ffmpeg **decode** and **network** load, which is the main per-stream CPU cost on a busy host. Switch to the main stream only if the substream is too low-resolution to detect your subjects reliably.

### Running multiple cameras

Detection is CPU-intensive and each stream runs its own decode + inference loop. As soon as you add a second or third camera, run this plugin as a [child bridge](https://github.com/homebridge/homebridge/wiki/Child-Bridges): it isolates the plugin in its own process, so a busy detection loop can't slow the rest of Homebridge down — and a crash can't take Homebridge with it.

## Requirements

- **Homebridge** v1.8 or newer
- **Node.js** v20 or newer
- A **supported platform** (see below)
- A camera or video stream URL that ffmpeg can open (RTSP, etc.)
- Enough CPU headroom for inference — each camera stream runs one detection pass per sampling interval

A bundled static **ffmpeg** binary and the **ONNX** runtime are installed automatically; there's no separate setup.

### Supported platforms

The on-device detector uses [`onnxruntime-node`](https://www.npmjs.com/package/onnxruntime-node), which ships prebuilt native binaries only for:

| OS | Architectures |
| --- | --- |
| macOS | x64, arm64 |
| Linux | x64, arm64 |
| Windows | x64, arm64 |

There is **no build for 32-bit ARM (armv7/armhf)** — including the legacy 32-bit Raspberry Pi OS. On a Raspberry Pi, install the **64-bit (arm64) Raspberry Pi OS**. On an unsupported platform the plugin logs a clear error and stays idle rather than crashing Homebridge.

## Performance & privacy

- Frames are decoded with ffmpeg and analyzed with a local **YOLO26n ONNX** model, entirely inside your Homebridge environment — they are **never uploaded to any cloud service**.
- Each frame is resized to a fixed input size before inference, so per-frame cost is the same regardless of your camera's resolution. The plugin samples the stream at a modest interval and only ever processes the latest frame.
- The main cost driver is the number of camera streams (each runs its own detection loop), not how many sensors a stream has. Start with one stream and grow from there.

## Troubleshooting

- **Sensor doesn't appear in HomeKit** — confirm the stream has at least one sensor with valid categories, then restart Homebridge.
- **Stream won't open / "no frames"** — verify the URL works in another player. For RTSP cameras the plugin uses TCP transport, which is the most compatible.
- **ffmpeg can't decode the stream** — check the URL, credentials, and that the camera is reachable from the Homebridge host (use an IP address if a hostname won't resolve).
- **Too many false triggers** — raise the sensor's `threshold`.
- **Detections are missed** — try a shorter stream `checkInterval`, lower the sensor's `threshold`, or make sure the subject is large enough in frame.
- **Homebridge feels sluggish** — detection is CPU-intensive. Try [running this plugin as a child bridge](https://github.com/homebridge/homebridge/wiki/Child-Bridges) to isolate it in its own process, and/or reduce the number of streams.

## License

Licensed under **AGPL-3.0-only** — free to use, study, and build on. Contributions and forks are welcome; please keep them under the same license terms.

## Contributing & support

Issues and camera-compatibility reports are appreciated. When reporting a problem, please include your **Homebridge version**, **plugin version**, **platform**, **stream type**, and relevant **logs**. Focused, maintainable pull requests are welcome.

---

If this plugin helps your HomeKit setup, please consider **starring the repo** — it helps others discover the project.
