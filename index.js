/**
 * dsh-550c-monitor — the Host half.
 *
 * Why this lives on the Host at all: the browser cannot read the machine's CPU,
 * disk, GPU or NIC counters, and the numbers must describe the machine the
 * Harness runs on rather than the one the page was opened from. So the Host
 * samples and the Client only reads one small JSON document — the same split
 * the 550C skin uses for its own state file.
 *
 * Sampling is push-free but not poll-driven from the Host side: the Client asks
 * `GET /dsh-550c-monitor/stats` on a timer, and `snapshot()` keeps a floor
 * (SAMPLE_FLOOR_MS) so a page that reloads or a second window cannot turn that
 * timer into a hot loop. CPU and network are *deltas* — they need the previous
 * reading to mean anything, which is why the first sample of a run reports
 * `null` for those two instead of a fabricated zero.
 *
 * Two figures need a child process because Node exposes neither: NIC byte
 * counters (`netstat -e`) and the GPU (`nvidia-smi`). Both are sampled on the
 * same two-second cadence as everything else, and both write into a scratch
 * file instead of a pipe — see `runToFile` for why the pipe is not an option.
 */
import { spawn } from 'node:child_process'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs'
import { cpus, freemem, platform, tmpdir, totalmem, uptime as osUptime } from 'node:os'
import { arch, hostname, networkInterfaces, release } from 'node:os'
import { homedir } from 'node:os'
import path from 'node:path'

export const name = 'monitor-550c'
export const inject = ['webServer']

const STATS_ROUTE = '/dsh-550c-monitor/stats'
/** Shortest gap between two real samples; the Client polls slower than this. */
const SAMPLE_FLOOR_MS = 800
/** How often the persistent probes are expected to print (nvidia-smi, pwsh). */
const PROBE_INTERVAL_MS = 2000

function clampPct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0) return 0
  if (value > 100) return 100
  return Math.round(value * 10) / 10
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  // A monitor reading is only meaningful for the instant it was taken; a cached
  // 304 would make the plate show a stale number as if it were live.
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/* ------------------------------------------------------------------ CPU --- */

/**
 * `os.cpus()` reports cumulative times per core since boot, not a percentage.
 * Summing across cores and diffing two readings gives a whole-machine figure,
 * which is what an instrument plate should show.
 */
function readCpuTimes() {
  let idle = 0
  let total = 0
  for (const core of cpus()) {
    const t = core.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total, at: Date.now() }
}

function cpuPctBetween(prev, next) {
  if (!prev) return null
  const dTotal = next.total - prev.total
  const dIdle = next.idle - prev.idle
  if (dTotal <= 0) return null
  return clampPct(100 * (1 - dIdle / dTotal))
}

/* --------------------------------------------------------- child helper --- */

/**
 * One private directory per probe under the OS temp root.
 *
 * The alternative — capturing a child's stdout through a pipe — is not
 * available here: the Harness may run inside a Windows job object that refuses
 * anonymous-pipe creation, and `spawn()` then fails with `EPERM` before the
 * child ever starts. Redirecting stdout to a file needs no pipe and behaves the
 * same whether the Host is sandboxed or not.
 */
function createScratchDir(label) {
  const dir = path.join(tmpdir(), `dsh-550c-monitor-${process.pid}`, label)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* an unwritable temp root simply means no readings, not a broken Host */
  }
  return {
    file(fileName) {
      return path.join(dir, fileName)
    },
    dispose() {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* the OS reaps the temp root anyway */
      }
    },
  }
}

/**
 * Run one command to completion, letting it write straight into `file`, then
 * hand the text back. Resolves `null` on any failure: a missing binary is a
 * legitimate "no reading", never an exception the route has to catch.
 */
function runToFile(command, args, file, encoding) {
  return new Promise((resolve) => {
    let descriptor
    try {
      descriptor = openSync(file, 'w')
    } catch {
      resolve(null)
      return
    }
    let settled = false
    const close = () => {
      try {
        closeSync(descriptor)
      } catch {
        /* already closed */
      }
    }
    const finish = (text) => {
      if (settled) return
      settled = true
      close()
      resolve(text)
    }
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', descriptor, 'ignore'] })
    } catch {
      finish(null)
      return
    }
    child.on('error', () => finish(null))
    child.on('close', () => {
      if (settled) return
      settled = true
      // Close before reading: on Windows a still-open write handle on the same
      // file can make the read come back empty.
      close()
      let text = null
      try {
        text = readFileSync(file, encoding || 'utf8')
      } catch {
        /* unreadable output is the same as no output */
      }
      resolve(text)
    })
  })
}

function killQuiet(child) {
  if (!child) return
  child.removeAllListeners('exit')
  child.removeAllListeners('error')
  try {
    child.kill()
  } catch {
    /* the child is already gone — nothing to release */
  }
}

/* ---------------------------------------------------------------- net ----- */

/**
 * Network throughput, as cumulative byte counters that the sampler diffs.
 *
 * `Get-NetAdapterStatistics` is the obvious API and it is not usable here: it
 * answers through CIM, and on this class of machine that query comes back
 * `PermissionDenied` for a non-elevated process. `netstat -e` reads the same
 * totals straight from the IP Helper API with no elevation and no WMI, at the
 * cost of localized labels — which do not matter, because the byte row is
 * identified by shape (the only row whose two numbers dwarf every other row's)
 * rather than by its heading.
 *
 * The read is asynchronous and cached: the route must never block on a child
 * process, and a rate needs two counter readings anyway.
 */
function createNetProbe() {
  const state = { rx: null, tx: null, at: 0 }
  const scratch = createScratchDir('net')
  let inflight = false
  let timer = null

  /** Same file across every Windows edition; offsets are documented, not guessed. */
  function makeNetstatParser(text) {
    let best = null
    for (const line of text.split(/\r?\n/)) {
      // Any label (localized, so any bytes) followed by exactly two integers.
      const match = /^[^\d\r\n]*(\d+)\s+(\d+)\s*$/.exec(line)
      if (!match) continue
      const rx = Number(match[1])
      const tx = Number(match[2])
      if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue
      if (!best || rx + tx > best.rx + best.tx) best = { rx, tx }
    }
    return best
  }

  function readLinux() {
    let rx = 0
    let tx = 0
    const text = readFileSync('/proc/net/dev', 'utf8')
    for (const line of text.split('\n')) {
      const colon = line.indexOf(':')
      if (colon === -1) continue
      const fields = line.slice(colon + 1).trim().split(/\s+/)
      if (fields.length < 9) continue
      rx += Number(fields[0]) || 0
      tx += Number(fields[8]) || 0
    }
    return { rx, tx }
  }

  function refresh() {
    const now = Date.now()
    if (state.at !== 0 && now - state.at < PROBE_INTERVAL_MS / 2) return

    if (platform() === 'linux') {
      try {
        const counters = readLinux()
        state.rx = counters.rx
        state.tx = counters.tx
        state.at = now
      } catch {
        /* no /proc — leave the previous reading in place; staleness handles it */
      }
      return
    }

    if (platform() !== 'win32' || inflight) return
    inflight = true
    runToFile('netstat', ['-e'], scratch.file('netstat.txt'), 'latin1').then((text) => {
      inflight = false
      if (!text) return
      // The console code page on a Chinese Windows is GBK, which is not valid
      // UTF-8; latin1 keeps every ASCII digit intact and turns only the labels
      // into harmless high bytes, and the parser never reads the labels.
      const counters = makeNetstatParser(text)
      if (!counters) return
      state.rx = counters.rx
      state.tx = counters.tx
      state.at = Date.now()
    })
  }

  return {
    start() {
      refresh()
      timer = setInterval(refresh, PROBE_INTERVAL_MS)
      // A monitor must never keep the Host's event loop alive on its own.
      if (timer && typeof timer.unref === 'function') timer.unref()
    },
    read() {
      if (state.rx === null || state.at === 0) return null
      if (Date.now() - state.at > PROBE_INTERVAL_MS * 6) return null
      return { rx: state.rx, tx: state.tx }
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      scratch.dispose()
    },
  }
}

/* ---------------------------------------------------------------- gpu ----- */

/**
 * GPU load. `nvidia-smi` is the only portable source that also reports the
 * frame buffer. It is queried once per interval rather than run with `-lms`:
 * a redirected (non-console) stdout gets block-buffered, so the streaming mode
 * can sit on several kilobytes of readings and deliver nothing for a whole
 * minute, while a one-shot query flushes on exit.
 *
 * Machines without an NVIDIA driver simply have no GPU row value: there is no
 * honest cross-vendor equivalent, and inventing one from `Get-Counter
 * '\GPU Engine(*)'` costs more than the number is worth.
 */
function createGpuProbe() {
  const state = { name: null, pct: null, memUsed: null, memTotal: null, temp: null, at: 0 }
  const scratch = createScratchDir('gpu')
  let timer = null
  let inflight = false

  if (platform() !== 'win32' && platform() !== 'linux') {
    return { start() {}, read: () => null, stop() {} }
  }

  const candidates = ['nvidia-smi']
  if (platform() === 'win32') {
    candidates.push(
      'C:\\Windows\\System32\\nvidia-smi.exe',
      'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe',
    )
  }
  let next = 0

  const applyLine = (line) => {
    // `GeForce RTX 4060, 18, 2048, 8188, 62` — the name may carry a comma on
    // some OEM cards, so the trailing numbers are taken from the right.
    const parts = line.split(',').map((part) => part.trim())
    if (parts.length < 5) return
    const temp = Number(parts[parts.length - 1])
    const total = Number(parts[parts.length - 2])
    const used = Number(parts[parts.length - 3])
    const pct = Number(parts[parts.length - 4])
    if (!Number.isFinite(pct)) return
    state.name = parts.slice(0, parts.length - 4).join(', ') || state.name
    state.pct = clampPct(pct)
    state.memUsed = Number.isFinite(used) ? used * 1024 * 1024 : null
    state.memTotal = Number.isFinite(total) ? total * 1024 * 1024 : null
    // nvidia-smi prints `[N/A]` for the temperature on some virtualised and
    // laptop-iGPU-only configurations, which parses as NaN, not as a number.
    state.temp = Number.isFinite(temp) ? Math.round(temp) : null
    state.at = Date.now()
  }

  const probe = () => {
    if (inflight) return
    if (next >= candidates.length) return
    inflight = true
    runToFile(
      candidates[next],
      ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
      scratch.file('nvidia-smi.txt'),
      'utf8',
    ).then((text) => {
      inflight = false
      const line = text ? text.split(/\r?\n/).find((row) => row.trim() !== '') : null
      if (line) {
        applyLine(line)
        return
      }
      // Only a probe that has never produced a reading is allowed to move on to
      // the next candidate path: a driver that stalls once but worked before
      // must not be abandoned.
      if (state.at === 0) next += 1
    })
  }

  return {
    start() {
      probe()
      timer = setInterval(probe, PROBE_INTERVAL_MS)
      if (timer && typeof timer.unref === 'function') timer.unref()
    },
    read() {
      if (state.at === 0 || Date.now() - state.at > PROBE_INTERVAL_MS * 6) return null
      return {
        name: state.name,
        pct: state.pct,
        memUsed: state.memUsed,
        memTotal: state.memTotal,
        temp: state.temp,
      }
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      scratch.dispose()
    },
  }
}

/* ----------------------------------------------------------- cpu temp ----- */

/**
 * CPU temperature. There is no Node API for it, and the two Windows sources
 * that exist are both conditional: the `MSAcpi_ThermalZoneTemperature` WMI class
 * needs elevation on most laptops, and the `Thermal Zone Information`
 * performance counters are only published on boards whose firmware exposes
 * them. This machine shows "access denied" for the first and "instance not
 * found" for the second — which is the normal outcome, not an exception. So the
 * probe tries the WMI class at a slow cadence (twelve seconds: the reading moves
 * in degrees, not amperes), gives up after two consecutive failures, and leaves
 * the figure null so the plate can show the sensor it does have.
 */
const CPU_TEMP_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'try {',
  '  $z = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop',
  '  $m = ($z | Measure-Object -Property CurrentTemperature -Maximum).Maximum',
  '  if ($m) { [math]::Round(($m / 10) - 273.15, 0) } else { "none" }',
  '} catch { "none" }',
  '',
].join('\n')
const CPU_TEMP_INTERVAL_MS = 12000

function createCpuTempProbe() {
  const state = { value: null, at: 0, failures: 0 }
  const scratch = createScratchDir('thermal')
  let timer = null
  let inflight = false

  if (platform() !== 'win32') {
    return { start() {}, read: () => null, stop() {} }
  }

  const script = scratch.file('thermal.ps1')
  try {
    writeFileSync(script, CPU_TEMP_SCRIPT, 'utf8')
  } catch {
    return { start() {}, read: () => null, stop() {} }
  }

  const probe = () => {
    if (inflight || state.failures >= 2) return
    inflight = true
    runToFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      scratch.file('thermal.txt'),
      'utf8',
    ).then((text) => {
      inflight = false
      const value = text ? Number(text.trim().split(/\s+/)[0]) : NaN
      if (Number.isFinite(value) && value > 0 && value < 150) {
        state.value = Math.round(value)
        state.at = Date.now()
        state.failures = 0
        return
      }
      state.failures += 1
    })
  }

  return {
    start() {
      probe()
      timer = setInterval(probe, CPU_TEMP_INTERVAL_MS)
      if (timer && typeof timer.unref === 'function') timer.unref()
    },
    read() {
      if (state.at === 0 || Date.now() - state.at > CPU_TEMP_INTERVAL_MS * 4) return null
      return state.value
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      scratch.dispose()
    },
  }
}

/* ------------------------------------------------------------- device ----- */

/**
 * The fixed facts about this machine. They are read once at startup rather than
 * per sample: a CPU model string and a host name do not change while the Host
 * runs, and `cpus()` allocates a fresh array of core descriptors on every call.
 */
const DEVICE = (() => {
  let host = null
  try {
    host = hostname()
  } catch {
    host = null
  }

  let cpuModel = null
  try {
    const first = cpus()[0]
    if (first && first.model) cpuModel = first.model.replace(/\s+/g, ' ').trim()
  } catch {
    cpuModel = null
  }

  let ip = null
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const entry of list || []) {
        if (entry && entry.family === 'IPv4' && !entry.internal) {
          ip = entry.address
          break
        }
      }
      if (ip) break
    }
  } catch {
    ip = null
  }

  return {
    host,
    os: `${platform()} ${release()}`,
    arch: arch(),
    cpuModel,
    node: process.version,
    ip,
  }
})()

/* --------------------------------------------------------------- disk ----- */

/**
 * The disk figure is about the volume the Harness itself writes to, since that
 * is the one whose exhaustion actually breaks a session. `statfsSync` reports
 * the filesystem the path lives on, which on Windows is the drive.
 */
function readDisk() {
  const anchor = process.env.DSH_HOME || homedir()
  const root = path.parse(anchor).root || anchor
  try {
    const fs = statfsSync(root)
    const total = fs.blocks * fs.bsize
    const free = fs.bavail * fs.bsize
    if (!Number.isFinite(total) || total <= 0) return null
    return {
      mount: root,
      total,
      free,
      pct: clampPct(100 * (1 - free / total)),
    }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------- sampler ---- */

function createSampler() {
  const net = createNetProbe()
  const gpu = createGpuProbe()
  const thermal = createCpuTempProbe()
  let prevCpu = readCpuTimes()
  let prevNet = null
  let cached = null
  let cachedAt = 0
  let lastNet = null

  if (typeof gpu.start === 'function') gpu.start()
  net.start()
  thermal.start()

  function sample() {
    const now = Date.now()
    const cpuNow = readCpuTimes()
    const cpuPct = cpuPctBetween(prevCpu, cpuNow)
    prevCpu = cpuNow

    const counters = net.read()
    let netOut = null
    if (counters && prevNet) {
      const dt = (now - prevNet.at) / 1000
      if (dt > 0.2) {
        const rx = Math.max(0, (counters.rx - prevNet.rx) / dt)
        const tx = Math.max(0, (counters.tx - prevNet.tx) / dt)
        // A counter reset (adapter re-enumerated) shows up as a negative delta;
        // reporting 0 for one sample is more honest than a negative rate.
        netOut = { rx, tx }
      }
    }
    if (counters) {
      prevNet = { rx: counters.rx, tx: counters.tx, at: now }
      lastNet = netOut
    }

    const memTotal = totalmem()
    const memFree = freemem()
    const memUsed = memTotal - memFree
    const gpuNow = gpu.read()
    const diskNow = readDisk()

    cached = {
      ok: true,
      at: now,
      cpu: { pct: cpuPct, cores: cpus().length },
      mem: {
        pct: clampPct(100 * (memUsed / memTotal)),
        used: memUsed,
        total: memTotal,
      },
      disk: diskNow,
      net: netOut || lastNet,
      gpu: gpuNow,
      temps: { cpu: thermal.read(), gpu: gpuNow ? gpuNow.temp : null },
      device: {
        ...DEVICE,
        cores: cpus().length,
        memTotal,
        diskMount: diskNow ? diskNow.mount : null,
        diskTotal: diskNow ? diskNow.total : null,
      },
      uptime: { system: osUptime(), process: process.uptime() },
    }
    cachedAt = now
    return cached
  }

  return {
    snapshot() {
      if (cached && Date.now() - cachedAt < SAMPLE_FLOOR_MS) return cached
      try {
        return sample()
      } catch (error) {
        // A sampler that throws must not take the route down: the plate can show
        // an unavailable reading, but a dead route breaks the whole entry.
        return { ok: false, at: Date.now(), error: String(error && error.message) }
      }
    },
    stop() {
      net.stop()
      gpu.stop()
      thermal.stop()
    },
  }
}

/* --------------------------------------------------------------- route ---- */

export function apply(ctx) {
  const sampler = createSampler()

  ctx.effect(() => {
    return () => sampler.stop()
  }, 'monitor-550c: samplers')

  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'exact',
      path: STATS_ROUTE,
      handler(req, res) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        const payload = sampler.snapshot()
        sendJson(res, 200, payload)
      },
    })
  }, 'monitor-550c: stats route')
}
