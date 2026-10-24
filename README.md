# dsh-550c-monitor

A system monitor for the DSH Web UI, cut to match the **550C** skin: a translucent instrument panel that docks to the right edge of the reading column and reads CPU, GPU, memory, disk, network and temperatures live.

It is a companion plugin to [`dsh-550c-skin`](https://github.com/Eason-zys/dsh-550c-skin) — but it also runs on its own, falling back to the host theme tokens when the skin is not installed.

```
550C // SYS                                  UP 6h23m
────────────────────────────────────────────────────
LIVE / SYSTEM
  CPU  ▐▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌  36%   20×
  GPU  ▐▌▌▌▌▌▌▌▌▌                                   12%  1.6G
  MEM  ▐▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌                      52%   16G
  DSK  ▐▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌  85%  F 42G
  NET  ▐▌▌                                ↓0B    ↑1.0K
  TMP  ▐▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌                   62°   GPU
────────────────────────────────────────────────────
HOST / DEVICE
  HOST  DESKTOP-H639F3B
  OS    win32 10.0.26200 x64
  CPU   12th Gen Intel(R) Core(TM) i7-12700H · 20
  MEM   32G
  GPU   NVIDIA GeForce RTX 3070 Ti Laptop GPU · 8.0G
```

## Features

**Six live readings**
- **CPU** — total load from `os.cpus()` tick deltas, plus core count.
- **GPU** — utilisation and memory used when `nvidia-smi` is present; silently absent otherwise.
- **MEM** — used / total physical memory.
- **DSK** — free space on the volume that holds `$DSH_HOME`, with the mount point.
- **NET** — receive / transmit throughput, sampled per interval (no counters → no number: it shows `--` for the first ~4 s instead of inventing `0`).
- **TMP** — GPU temperature from `nvidia-smi`, CPU temperature from the ACPI thermal zone when the process is allowed to read it.

**A device ledger** — host, OS, CPU model, memory, GPU, disk volume, LAN address, Node version, screen, time zone. On short windows the optional rows fold away from the bottom up, so the numbers are never clipped mid-line.

**Built like the skin**
- Square instrument rails: 4 px cells on a 6 px pitch, `skewX(-18deg)`, fill in the accent colour, a 1 px liquid-level line overhanging both edges, and a hard square corner (no blurred dropshadow — it rounds 4 px cells into pills).
- Frosted glass card: translucent tint over `backdrop-filter: blur(34px) saturate(1.32)`, a 5 %→1 % top highlight, faint scan lines, and four corner brackets drawn from eight gradients.
- HUD numerals: tabular, slashed-zero, `text-shadow` bloom; labels carry a 2×10 px status tick.
- Palette first reads the skin's tokens (`--c-amber`, `--c-glow-rgb`, `--c-red`, `--c-text-*`), then the host theme (`--dsw-alias-*`) as a fallback.

**Behaves like an instrument, not a dialog**
- **Drag it** by the title bar; double-click the title bar to hand it back to the layout engine. The position survives reloads.
- **Fold it** with the `–` / `+` key at the top right — one 46 px strip showing `CPU · MEM · NET`. The fold state survives reloads.
- **Adapts**: the panel targets the right gutter of the reading column, capped at 60 % of the visible height so the bottom-right corner stays free for other widgets. Narrow windows collapse it to an 18 px rail of six thin bars.
- Click-through everywhere except the title bar and the fold key; it hides itself while a dialog or menu is open.

**Widens the reading column** (opt-in default: on)
DSH clamps the transcript to a reading measure, which leaves a wide empty gutter on a large screen. This plugin finds the box that is *actually* clamped by `max-width` (computed limit in px, and the box already touching it), marks that single element with `data-550c-monitor-wide`, and drops the clamp. Nothing else is touched; the pass is throttled to once every 3 s and is fully reversible from the console:

```js
__monitor550c.widen(false)   // give the reading measure back
__monitor550c.widen(true)    // take the gutter again
```

The choice is remembered in `localStorage` (`dsh-550c-monitor:wide`).

## Requirements

- DSH Web UI with a Web server (the plugin registers one exact route).
- Node.js **>= 20**.
- Windows or Linux for the system probes; Windows additionally gives CPU temperature (when elevated) and GPU readings via `nvidia-smi`. macOS is untested.

## Install

From a local checkout (the plugin is plain JS — no build step):

```sh
# inside the DSH profile directory
pnpm add link:/path/to/dsh-550c-monitor
```

then enable the bundle for the profile (`dsh.profile.bundles` in the profile's `package.json`), or use the Harness plugin manager UI. The package declares its own `dsh.bundle.patch`, so nothing has to be hand-written into `cordis.patch.yml`.

The row lands in the profile as `monitor-550c`.

## HTTP API

The host half registers one exact route, read-only:

```
GET /dsh-550c-monitor/stats
```

```jsonc
{
  "at": 1761..,                       // sample timestamp (ms)
  "cpu": { "pct": 36.4, "cores": 20 },
  "mem": { "pct": 52.1, "used": 19833176064, "total": 34037551104 },
  "disk": { "mount": "C:\\", "total": 290205761536, "free": 45441830912, "pct": 84.3 },
  "net": { "rx": 127.0, "tx": 1024.0 },   // bytes/second, null until two samples exist
  "gpu": { "name": "…", "pct": 12, "memUsed": 1702887424, "memTotal": 8589934592, "temp": 61 },
  "temps": { "cpu": null, "gpu": 61 },
  "uptime": { "system": 21165, "process": 7171 },
  "device": { "host": "…", "os": "win32 10.0.26200", "arch": "x64", "cpuModel": "…",
              "node": "v24.21.0", "ip": "192.168.3.8", "cores": 20,
              "memTotal": 34037551104, "diskMount": "C:\\", "diskTotal": 290205761536 }
}
```

Any other method answers `405`. The response is `cache-control: no-store`.

## Notes on the numbers

- **CPU temperature** comes from `MSAcpi_ThermalZoneTemperature`. Reading it needs an elevated process on most laptops; when the probe is refused (or the machine exposes no ACPI thermal zone — most desktops don't), the row shows `GPU`'s value only and `TMP` falls back to reporting the GPU sensor. The probe gives up after two consecutive refusals instead of polling forever.
- **Networking** is read from `netstat -e` on Windows and `/proc/net/dev` on Linux. If neither answers, the rows show `--`.
- **GPU** is polled with a one-shot `nvidia-smi` query per interval; when the binary is missing the GPU row is omitted and the remaining rows keep the panel's rhythm.
- **Disk** is the volume holding `$DSH_HOME` (falls back to the user's home volume).
- Host-side probing is done with `spawn` writing to a scratch file rather than piped stdio, because some sandboxes refuse anonymous pipes (`spawn EPERM`).

## Development

```sh
node --check index.js     # host half
node --check client.js    # browser half (plain ModuleLoader factory, no bundler)
```

The client half is intentionally written as a hand-rolled module — DSH loads it as-is. It appends one `<style>` element and one `position: fixed` card to the document, both owned by a single cleanup function registered through `ctx.effect`.

## License

MIT — see [LICENSE](LICENSE).
