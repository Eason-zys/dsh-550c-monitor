/**
 * dsh-550c-monitor — the Client half.
 *
 * The plate is built the way the 550C skin builds its own decoration layer: an
 * entry attached to `document.body` from `apply()`, updated from one timer. It
 * deliberately does not go through a slot: a readout that only *reads* the page
 * has nothing to place in the layout tree, and the skin already establishes
 * that a client plugin may decorate the document root (its CRT overlay, panel
 * furniture and backlog all do exactly this).
 *
 * It fills the free margin on the right of the frame: full height, width from
 * `clamp()` so a wide window gets a wider instrument and a narrow one gets a
 * strip, top and bottom pinned so it always spans the whole column. Two earlier
 * placements are recorded here because they are the ones a reader will be
 * tempted to try first — the foot of the sidebar, where the shell prints the
 * session's identity line, and a fixed 200 px box, which looked undersized next
 * to a full-height conversation.
 *
 * Two rules are inherited from the skin and are not negotiable here:
 *   - decorators are `position: fixed` + `pointer-events: none`, so the plate
 *     never moves, covers or steals a click from what it sits on;
 *   - the palette is the skin's `--c-*` tokens first and the shell's
 *     `--dsw-alias-*` tokens second, so the plate belongs to whichever look is
 *     currently active.
 *
 * All numbers come from the Host (`GET /dsh-550c-monitor/stats`); the browser
 * cannot read CPU, disk, GPU or NIC counters, and the figures must describe the
 * machine the Harness runs on rather than the machine the page was opened from.
 * The exceptions are the two facts only the browser knows — screen and time
 * zone — which are read here.
 */
window.__ModuleLoader__.load({
  id: 'dsh-550c-monitor',
  factory(require) {
    const STATS_URL = '/dsh-550c-monitor/stats'
    /** The Host floors its own sampling at 800 ms; asking every 2 s is polite. */
    const POLL_MS = 2000
    /** A reading older than this is not a reading: the plate dims to HOLD. */
    const STALE_MS = 12000
    /** Below this frame width the plate drops its labels and becomes a strip. */
    const NARROW_FRAME_PX = 560
    /** Below this frame height the device block keeps only its first facts. */
    const SHORT_FRAME_PX = 620
    /** Kept clear at the top: the shell and other plugins put status chips there. */
    const TOP_INSET = 46
    /** Same altitude as the skin's decorations, so the shell cannot cover it. */
    const Z = '2147480100'
    const FOLD_KEY = 'dsh-550c-monitor:folded'
    /** Where the reader parked the card, if they dragged it. */
    const POS_KEY = 'dsh-550c-monitor:pos'
    /**
     * The reading-column width preference.
     *
     * DSH caps the transcript at a comfortable measure — a few hundred pixels of
     * text in a column that is centred in whatever the window leaves. On a wide
     * screen that reads as a narrow strip with a large void beside it, and the
     * void is where this card sits, so the two impressions arrive together.
     *
     * ON by default and off only when the reader says `0`: the default has to be
     * the one that removes the complaint. The switch lives in localStorage rather
     * than in a settings row because this plugin registers no Client slot, and a
     * storage key is the whole mechanism — `__monitor550c.widen(false)` flips it.
     */
    const WIDE_KEY = 'dsh-550c-monitor:wide'

    /* ------------------------------------------------------------ format ---- */

    const UNITS = ['B', 'K', 'M', 'G', 'T', 'P']

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '--'
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024
        unit += 1
      }
      // One decimal below 10 keeps a rate readable without pretending to a
      // precision the counters do not have; above that the integer is enough.
      const text = unit === 0 || value >= 100 ? String(Math.round(value))
        : value >= 10 ? value.toFixed(0)
          : value.toFixed(1)
      return text + UNITS[unit]
    }

    function formatPct(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '--'
      return Math.round(value) + '%'
    }

    function formatTemp(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '--'
      return Math.round(value) + '\u00b0'
    }

    function formatSpan(seconds) {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '--'
      const days = Math.floor(seconds / 86400)
      const hours = Math.floor((seconds % 86400) / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)
      if (days > 0) return days + 'd' + String(hours).padStart(2, '0') + 'h'
      if (hours > 0) return hours + 'h' + String(minutes).padStart(2, '0') + 'm'
      return minutes + 'm'
    }

    function clampPct(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 0
      return Math.max(0, Math.min(100, value))
    }

    /** 60/85 are where the skin's own meters turn from quiet to busy to hot. */
    function levelFor(pct) {
      if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'quiet'
      if (pct >= 85) return 'hot'
      if (pct >= 60) return 'busy'
      return 'quiet'
    }

    /** 30-90 °C is the band worth drawing; outside it only the verdict matters. */
    function tempPct(celsius) {
      if (typeof celsius !== 'number' || !Number.isFinite(celsius)) return 0
      return clampPct(((celsius - 30) / 60) * 100)
    }

    /* --------------------------------------------------------------- css ---- */

    /**
     * Proportions, in one place so the plate can be re-tuned without hunting.
     *
     * The first version set type at the skin's 8-10 px decoration scale while
     * spreading six rows across the full column height; at 384 px wide that put
     * pixels of text into inches of empty rail, which reads as a broken layout
     * rather than a sparse one. The rule now is: body type scales with the panel
     * (11 px labels, 17 px readings, 11.5 px facts), rows get a floor *and* a
     * ceiling so extra height pools in one air gap instead of being sliced into
     * six invisible slivers, and the ledger keeps its natural height.
     */
    const CSS = `
.c-mon-550c {
  position: fixed;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  padding: 16px 16px 18px;
  z-index: 2147480100;
  pointer-events: none;
  border: 1px solid rgba(var(--c-mon-glow), 0.16);
  border-radius: 3px;
  overflow: hidden;
  /* Frosted glass, in three layers rather than one flat tint:
       1. the tint — under a quarter of the panel colour, so the page shows through;
       2. the frost — a wide blur plus a small brightness lift, which is what
          makes it read as textured glass instead of a semi-transparent box;
       3. the sheen — a white-to-transparent wash down from the top edge, the
          tell that light is hitting the pane.
     color-mix keeps the tint tied to the skin's palette instead of hard-coding
     an rgba that would be wrong in three of the four schemes. */
  background-color: var(--c-mon-panel);
  background-color: color-mix(in srgb, var(--c-mon-panel) 22%, transparent);
  -webkit-backdrop-filter: blur(34px) saturate(1.32) brightness(1.08);
  backdrop-filter: blur(34px) saturate(1.32) brightness(1.08);
  background-image:
    linear-gradient(180deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.01) 42%, transparent 72%),
    repeating-linear-gradient(0deg, rgba(var(--c-mon-glow), 0.02) 0 1px, transparent 1px 6px);
  box-shadow:
    0 20px 44px rgba(0, 0, 0, 0.32),
    0 1px 0 rgba(255, 255, 255, 0.06),
    inset 0 1px 0 rgba(255, 255, 255, 0.1),
    inset 0 -1px 0 rgba(0, 0, 0, 0.18),
    inset 0 0 0 1px rgba(var(--c-mon-glow), 0.06);
  color: var(--c-mon-text);
  font-family: var(--c-mono, ui-monospace, SFMono-Regular, Consolas, "Microsoft YaHei UI", monospace);
  font-variant-numeric: tabular-nums;
  animation: c-mon-in 240ms ease-out both;

  /* One local palette: the skin's tokens first, the page's own tokens second.
     Declared here so a fallback never has to be repeated per rule. */
  --c-mon-glow: var(--c-glow-rgb, 224, 160, 48);
  --c-mon-accent: var(--c-amber, var(--dsw-alias-brand-primary, #c8a06a));
  --c-mon-accent-b: var(--c-amber-b, var(--c-mon-accent));
  --c-mon-accent-d: var(--c-amber-d, var(--c-mon-accent));
  --c-mon-text: var(--c-text, var(--dsw-alias-label-secondary, #b9b2a6));
  --c-mon-faint: var(--c-text-faint, var(--dsw-alias-label-tertiary, #7d776d));
  --c-mon-panel: var(--c-bg-panel, var(--dsw-alias-bg-layer-1, #14110d));
  --c-mon-line: rgba(var(--c-mon-glow), 0.26);
  --c-mon-well: rgba(var(--c-mon-glow), 0.12);
  --c-mon-alert: var(--c-red, #e2603f);
  --c-mon-well-edge: rgba(var(--c-mon-glow), 0.16);
  --c-mon-gutter: 9px;
}

.c-mon-550c[hidden] { display: none; }

/* Corner brackets, the one piece of furniture the whole skin shares. */
.c-mon-550c::before {
  content: '';
  position: absolute;
  inset: 5px;
  pointer-events: none;
  opacity: 0.5;
  --c-mon-ink: var(--c-mon-accent-d);
  background-image:
    linear-gradient(var(--c-mon-ink), var(--c-mon-ink)),
    linear-gradient(var(--c-mon-ink), var(--c-mon-ink)),
    linear-gradient(var(--c-mon-ink), var(--c-mon-ink)),
    linear-gradient(var(--c-mon-ink), var(--c-mon-ink)),
    linear-gradient(var(--c-mon-ink), var(--c-mon-ink)),
    linear-gradient(var(--c-mon-ink), var(--c-mon-ink)),
    linear-gradient(var(--c-mon-ink), var(--c-mon-ink)),
    linear-gradient(var(--c-mon-ink), var(--c-mon-ink));
  background-size: 11px 1px, 1px 11px, 11px 1px, 1px 11px, 11px 1px, 1px 11px, 11px 1px, 1px 11px;
  background-position:
    left top, left top,
    right top, right top,
    left bottom, left bottom,
    right bottom, right bottom;
  background-repeat: no-repeat;
}

/* The header is the drag handle, and the only part of the card that takes
   pointer events: the pane can hover over the transcript without swallowing its
   clicks, and the fold button (inside the header) opts out in the drag handler. */
.c-mon-head {
  flex: none;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 10px;
  margin-bottom: 14px;
  pointer-events: auto;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.c-mon-550c[data-drag='1'] .c-mon-head,
.c-mon-550c[data-drag='1'] { cursor: grabbing; }

/* A grip, so the header reads as movable before the cursor tries it. */
.c-mon-head::before {
  content: '••';
  flex: none;
  align-self: center;
  margin-right: -6px;
  font-size: 8px;
  line-height: 1;
  letter-spacing: 1px;
  color: var(--c-mon-faint);
  opacity: 0.6;
}


.c-mon-title {
  font-size: 12px;
  line-height: 15px;
  letter-spacing: 0.26em;
  text-transform: uppercase;
  color: var(--c-mon-accent-d);
  white-space: nowrap;
}

/* The one interactive pixel on the plate: it opts back into pointer events and
   carries its own focus ring, since the card itself is click-through. */
.c-mon-fold {
  pointer-events: auto;
  align-self: center;
  flex: none;
  width: 17px;
  height: 17px;
  margin-left: 2px;
  padding: 0;
  border: 1px solid var(--c-mon-line);
  border-radius: 2px;
  background: transparent;
  color: var(--c-mon-faint);
  font: inherit;
  font-size: 12px;
  line-height: 13px;
  text-align: center;
  cursor: pointer;
  transition: color 160ms ease, border-color 160ms ease;
}
.c-mon-fold:hover { color: var(--c-mon-accent); border-color: var(--c-mon-accent); }
.c-mon-fold:focus-visible { outline: 1px solid var(--c-mon-accent); outline-offset: 2px; }

/* Folded: the head row keeps a one-line digest so the strip still says something */
.c-mon-sum {
  display: none;
  flex: 1 1 auto;
  min-width: 0;
  margin-right: 10px;
  font-size: 10.5px;
  line-height: 15px;
  letter-spacing: 0.08em;
  color: var(--c-mon-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: right;
}
.c-mon-550c[data-folded='1'] { padding: 9px 12px; }
.c-mon-550c[data-folded='1'] .c-mon-sum { display: block; }
.c-mon-550c[data-folded='1'] .c-mon-up,
.c-mon-550c[data-folded='1'] .c-mon-body,
.c-mon-550c[data-folded='1'] .c-mon-cap,
.c-mon-550c[data-folded='1'] .c-mon-dev { display: none; }
.c-mon-550c[data-folded='1'] .c-mon-head {
  padding-bottom: 0;
  margin-bottom: 0;
  background-image: none;
}

.c-mon-up {
  font-size: 10px;
  line-height: 15px;
  letter-spacing: 0.1em;
  color: var(--c-mon-faint);
  white-space: nowrap;
}

.c-mon-cap {
  flex: none;
  font-size: 9.5px;
  line-height: 12px;
  letter-spacing: 0.26em;
  text-transform: uppercase;
  color: var(--c-mon-faint);
}

.c-mon-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 8px;
  min-height: 0;
  margin-top: 10px;
  transition: opacity 240ms ease;
}

/* Floor and ceiling on both axes: a gauge has a shape, not a share of whatever
   remains. Extra height collects in the single air gap below the gauges. */
.c-mon-row {
  flex: 1 1 0;
  min-height: 36px;
  max-height: 60px;
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) 54px;
  align-items: center;
  column-gap: var(--c-mon-gutter);
}

.c-mon-k {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  line-height: 14px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--c-mon-faint);
}

/* A 2px tick whose brightness tracks the level: the row says "how hot" even
   before you read the number. */
.c-mon-k::before {
  content: '';
  flex: none;
  width: 2px;
  height: 10px;
  background: var(--c-mon-accent-d);
  opacity: 0.55;
}

.c-mon-row[data-lv='busy'] .c-mon-k::before {
  background: var(--c-mon-accent);
  opacity: 0.9;
}

.c-mon-row[data-lv='hot'] .c-mon-k::before {
  background: var(--c-mon-alert);
  opacity: 1;
  box-shadow: 0 0 6px var(--c-mon-alert);
}

/* The gauge is a row of discrete cells, built entirely out of repeating
   gradients: filled and unfilled cells share the same 6px pitch (4px block, 2px
   gap) and both start at the rail's left edge, so the lit half always lands on
   the empty half's grid no matter how wide the value gets. No per-segment DOM,
   no canvas, no re-render when the number moves. */
.c-mon-rail {
  position: relative;
  height: 16px;
  border-radius: 0;
  overflow: visible;
  transform: skewX(-18deg);
  transform-origin: left center;
  background-image: repeating-linear-gradient(
    90deg,
    rgba(var(--c-mon-glow), 0.13) 0 4px,
    transparent 4px 6px
  );
}

.c-mon-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 1;
  background-image: repeating-linear-gradient(
    90deg,
    var(--c-mon-accent-b) 0 4px,
    transparent 4px 6px
  );
  border-radius: 0;
  transition: width 320ms ease-out;
}

/* The boundary tick: one hairlines that runs past the cells, the way a real
   level cursor does. It marks where the reading sits, not how full the bar is. */
.c-mon-fill::after {
  content: '';
  position: absolute;
  top: -4px;
  bottom: -4px;
  right: -1px;
  width: 1px;
  background: var(--c-mon-accent-b);
}

/* Slashed zeroes, tabular figures and a faint bloom: a readout, not a label. */
.c-mon-v {
  font-size: 18px;
  line-height: 21px;
  letter-spacing: 0.04em;
  text-align: right;
  font-variant-numeric: tabular-nums slashed-zero;
  color: var(--c-mon-text);
  text-shadow: 0 0 12px rgba(var(--c-mon-glow), 0.2);
  white-space: nowrap;
}

.c-mon-row[data-lv='busy'] .c-mon-v {
  color: var(--c-mon-accent-b);
  text-shadow: 0 0 12px rgba(var(--c-mon-glow), 0.32);
}
.c-mon-row[data-lv='busy'] .c-mon-fill {
  background-image: repeating-linear-gradient(
    90deg,
    var(--c-mon-accent-b) 0 4px,
    transparent 4px 6px
  );
}

.c-mon-row[data-lv='hot'] .c-mon-v {
  color: var(--c-mon-alert);
  text-shadow: 0 0 14px rgba(226, 96, 63, 0.45);
}
.c-mon-row[data-lv='hot'] .c-mon-fill {
  background-image: repeating-linear-gradient(
    90deg,
    var(--c-mon-alert) 0 4px,
    transparent 4px 6px
  );
}
.c-mon-row[data-lv='hot'] .c-mon-fill::after {
  background: var(--c-mon-alert);
  box-shadow: 0 0 8px var(--c-mon-alert);
}

.c-mon-550c[data-stale='1'] .c-mon-body { opacity: 0.45; }
.c-mon-550c[data-stale='1'] .c-mon-fill { opacity: 0.55; }
.c-mon-550c[data-stale='1'] .c-mon-title { color: var(--c-mon-faint); }

/* The ledger block: pinned to the foot of the column, ruled off from the gauges,
   and allowed to keep its natural height rather than being stretched. */
.c-mon-dev {
  flex: none;
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr);
  column-gap: var(--c-mon-gutter);
  row-gap: 6px;
  margin-top: 8px;
  align-items: baseline;
}

.c-mon-cap-dev {
  margin-top: auto;
  padding-top: 12px;
}


.c-mon-dk {
  font-size: 9.5px;
  line-height: 13px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--c-mon-faint);
}

/* Two lines are allowed before clipping: a GPU name or a CPU model worth
   reading never fits one line in a column this wide. */
.c-mon-dv {
  font-size: 11.5px;
  line-height: 16px;
  color: var(--c-mon-text);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow-wrap: anywhere;
}

/* A short window cannot hold ten facts. Three tiers, driven by the height clamp
   in place(): all ten; the four headline facts; or gauges alone — the last one
   exists so a 420 px card shows six clean instruments instead of a ledger with
   its feet cut off. */
.c-mon-550c[data-compact='1'] .c-mon-dev { row-gap: 7px; }
.c-mon-550c[data-compact='1'] .c-mon-dev .c-mon-opt { display: none; }
.c-mon-550c[data-compact='1'] .c-mon-row { min-height: 40px; }
.c-mon-550c[data-compact='2'] .c-mon-dev,
.c-mon-550c[data-compact='2'] .c-mon-cap-dev { display: none; }
.c-mon-550c[data-compact='2'] .c-mon-row { min-height: 40px; max-height: none; }

/* Micro frame: there is no room for a card, so the plate keeps only the part
   that still reads at 16 px — six stacked ticks. No title, no numbers, no fold
   control: at this size the reader has shrunk the window, not opened a panel to
   manage, and a clipped column of half-words is worse than a clean gauge strip. */
.c-mon-550c[data-mode='rail'] {
  width: 18px;
  padding: 10px 5px;
  border: 1px solid var(--c-mon-line);
  border-radius: 2px;
  background-color: rgba(var(--c-mon-glow), 0.05);
  box-shadow: none;
}
.c-mon-550c[data-mode='rail']::before { display: none; }
.c-mon-550c[data-mode='rail'] .c-mon-head,
.c-mon-550c[data-mode='rail'] .c-mon-sum,
.c-mon-550c[data-mode='rail'] .c-mon-up,
.c-mon-550c[data-mode='rail'] .c-mon-k,
.c-mon-550c[data-mode='rail'] .c-mon-v,
.c-mon-550c[data-mode='rail'] .c-mon-cap,
.c-mon-550c[data-mode='rail'] .c-mon-dev,
.c-mon-550c[data-mode='rail'] .c-mon-fold { display: none; }
/* The strip has no head to fold: a remembered fold must not blank it. */
.c-mon-550c[data-mode='rail'][data-folded='1'] .c-mon-body { display: flex; }
.c-mon-550c[data-mode='rail'] .c-mon-body { gap: 6px; }
.c-mon-550c[data-mode='rail'] .c-mon-row {
  grid-template-columns: minmax(0, 1fr);
  column-gap: 0;
  min-height: 0;
  max-height: none;
}
.c-mon-550c[data-mode='rail'] .c-mon-rail {
  transform: none;
  height: 4px;
  background: rgba(var(--c-mon-glow), 0.16);
  box-shadow: inset 0 0 0 1px rgba(var(--c-mon-glow), 0.2);
}

@keyframes c-mon-in {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .c-mon-550c,
  .c-mon-fill,
  .c-mon-body { animation: none; transition: none; }
}
`

    const EXTRA = `
/* THE BACKDROP IS GONE, AND IT WAS A DASHED LINE FOR ANYONE WHO LOOKED.

   It was authored as a soft field behind the card — a translucent wash against
   the page's right edge. But it had \`top/right/bottom\` and no \`left\` and no
   width, so its box was zero pixels wide and the only thing it ever painted was
   its left border: a 1px dashed rail down the window. That is the stray rule the
   reader pointed at twice, and deleting the card's two \`::after\` rules did not
   remove it because it was never one of them.

   The card is now the only chrome on that edge, so the element is kept (the
   placement code still addresses it) and switched off. */
.c-mon-backdrop { display: none; }

/* THE READING COLUMN, WIDENED (opt-out).

   Applied by \`applyWide()\` to the box that is actually hitting its own
   \`max-width\`, so this selector is the only thing standing between a centred
   column and the full pane. \`!important\` because the clamp comes from a
   generated stylesheet whose specificity is not knowable across builds. */
[data-550c-monitor-wide] {
  max-width: none !important;
}
`

    /* ------------------------------------------------------------- build ---- */

    const ROWS = ['CPU', 'GPU', 'MEM', 'DSK', 'NET', 'TMP']
    /** `opt` facts are the first to go when the frame is short. */
    const FACTS = [
      { key: 'HOST', opt: false },
      { key: 'OS', opt: false },
      { key: 'CPU', opt: false },
      { key: 'MEM', opt: false },
      { key: 'GPU', opt: true },
      { key: 'DSK', opt: true },
      { key: 'NET', opt: true },
      { key: 'NODE', opt: true },
      { key: 'SCR', opt: true },
      { key: 'TZ', opt: true },
    ]

    function el(tag, className, text) {
      const node = document.createElement(tag)
      if (className) node.className = className
      if (text !== undefined) node.textContent = text
      return node
    }

    function buildPlate() {
      const plate = el('div', 'c-mon-550c')
      plate.setAttribute('data-mode', 'full')
      plate.setAttribute('data-stale', '1')
      plate.setAttribute('data-compact', '0')
      // The plate is a readout: it never takes a click away from the frame
      // underneath, and assistive tech gets one label instead of six rails.
      plate.setAttribute('role', 'img')

      const head = el('div', 'c-mon-head')
      const title = el('span', 'c-mon-title', '550C // SYS')
      // Shown only when the plate is folded: the three readings that still
      // matter when there is no room for the instruments.
      const sum = el('span', 'c-mon-sum', '')
      const up = el('span', 'c-mon-up', 'UP --')
      // The single interactive pixel on the plate. Everything else stays
      // pointer-transparent so the frame keeps its own clicks.
      const fold = el('button', 'c-mon-fold', '\u2013')
      fold.setAttribute('type', 'button')
      fold.setAttribute('aria-expanded', 'true')
      fold.setAttribute('aria-label', 'Fold the system monitor')
      fold.setAttribute('title', 'Fold')
      head.append(title, sum, up, fold)

      const body = el('div', 'c-mon-body')
      const cells = ROWS.map((label) => {
        const row = el('div', 'c-mon-row')
        row.setAttribute('data-lv', 'quiet')
        const key = el('span', 'c-mon-k', label)
        const rail = el('span', 'c-mon-rail')
        const fill = el('i', 'c-mon-fill')
        fill.style.width = '0%'
        rail.append(fill)
        const value = el('span', 'c-mon-v', '--')
        row.append(key, rail, value)
        body.append(row)
        return { row, fill, value }
      })

      const dev = el('div', 'c-mon-dev')
      const facts = {}
      for (const fact of FACTS) {
        const key = el('span', 'c-mon-dk', fact.key)
        const value = el('span', 'c-mon-dv', '--')
        if (fact.opt) {
          key.classList.add('c-mon-opt')
          value.classList.add('c-mon-opt')
        }
        dev.append(key, value)
        facts[fact.key] = value
      }

      const capLive = el('div', 'c-mon-cap', 'LIVE / SYSTEM')
      const capDev = el('div', 'c-mon-cap c-mon-cap-dev', 'HOST / DEVICE')
      const backdrop = el('div', 'c-mon-backdrop')

      plate.append(head, capLive, body, capDev, dev)
      return { plate, backdrop, head, title, up, sum, fold, cells, facts }
    }

    /* ----------------------------------------------------------- position ---- */

    /**
     * Where the frame's main column starts, and how much room is left to its
     * right, in pixels.
     *
     * The card has to line up with the transcript's top rule rather than with the
     * window edge: the shell keeps its own chrome up there (tab strip, status
     * chips) and a plate that starts above the column reads as a floating
     * artefact. A hard-coded offset fails on every machine with a different
     * chrome height, so the column is found instead — the largest scrolling box
     * that sits right of the sidebar and fills most of the height. Both numbers
     * are advisory: when the search finds nothing the constants are used and the
     * plate still lands somewhere sane.
     */
    /**
     * Every pane that scrolls, is tall, and sits right of the sidebar.
     *
     * The numbers are what placement needs; the node is what the reading-column
     * pass needs. One scan answers both, because both run on the same tick and
     * walking the same DOM twice per second would be pure waste.
     */
    function readingPanels() {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const found = []
      try {
        const nodes = document.body.querySelectorAll('div, section, main, article, ul, ol')
        for (let k = 0; k < nodes.length; k += 1) {
          const node = nodes[k]
          if (!node || node.hasAttribute('data-550c-monitor')) continue
          if (node.scrollHeight <= node.clientHeight + 24) continue
          const rect = node.getBoundingClientRect()
          if (!rect || rect.height < vh * 0.45 || rect.width < vw * 0.4) continue
          if (rect.left < vw * 0.08) continue
          found.push({
            node,
            area: rect.width * rect.height,
            width: rect.width,
            top: rect.top,
            right: rect.right,
          })
        }
      } catch {
        found.length = 0
      }
      return found
    }

    function measureFrame() {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const found = readingPanels()
      if (found.length === 0) return { top: TOP_INSET, gutter: null }

      let maxArea = 0
      for (const item of found) maxArea = Math.max(maxArea, item.area)

      // The top edge comes from the *widest* pane: that is the conversation
      // column itself. Narrower scrollers inside it start lower, and following
      // them would drop the card into the middle of the transcript. When two
      // panes share a width (the column and the pane wrapping it, tab strip and
      // all), the lower of the two wins — that is the transcript, not the chrome.
      let top = TOP_INSET
      let widest = -1
      for (const item of found) {
        if (item.area < maxArea * 0.5) continue
        if (item.width > widest + 1 || (Math.abs(item.width - widest) <= 1 && item.top > top)) {
          widest = item.width
          top = Math.round(item.top)
        }
      }

      // The margin is a separate question: the *widest* right-hand gap any pane
      // reports. An inner container often ends flush with the window while the
      // text column does not, and trusting that one made the card disappear.
      let gutter = 0
      for (const item of found) {
        if (item.area < maxArea * 0.5) continue
        gutter = Math.max(gutter, Math.round(vw - item.right))
      }

      return {
        // Never above the safe inset, and never so low that the card would start
        // halfway down the page.
        top: Math.min(Math.max(TOP_INSET, top), Math.round(vh * 0.3)),
        gutter: Math.max(0, gutter),
      }
    }

    /* ------------------------------------------------- the reading column ---- */

    /** Nodes the widening pass has touched, so unmount can hand them back. */
    let wideMarked = []
    /** The preference, read once at load and again on every explicit toggle. */
    let wideMode = true
    try {
      wideMode = window.localStorage.getItem(WIDE_KEY) !== '0'
    } catch {
      wideMode = true
    }
    let wideStamp = 0

    function releaseWide() {
      for (const node of wideMarked) node.removeAttribute('data-550c-monitor-wide')
      wideMarked = []
    }

    /**
     * THE ONE PLACE THIS PLUGIN TOUCHES THE APP'S OWN LAYOUT, and it is asked
     * for: the transcript's readable measure leaves a wide void on each side,
     * the card lives in the right-hand void, and the reader reads the pair as
     * "my conversation got narrow".
     *
     * The column cannot be named — DSH's module hashes change per build — so it
     * is found by BEHAVIOUR: a wide, tall box whose computed `max-width` is a
     * pixel value it is actually hitting. A box narrower than its own clamp is
     * not constrained by it, so it is left alone; that one comparison is what
     * keeps this pass from spraying attributes across the shell.
     *
     * The search is confined to the panes `readingPanels()` already found — the
     * box, the ancestors that may carry the clamp, and three levels inside — so
     * the sidebar, the menus and the composer are never candidates. Every mark is
     * remembered and removed again on unmount, and `__monitor550c.widen(false)`
     * puts the layout back without a reload.
     *
     * Throttled to one pass every 3 s: the transcript re-renders constantly and a
     * `getComputedStyle` walk per tick would be paid for by the scroll.
     */
    function applyWide(force) {
      const now = Date.now()
      if (!force && now - wideStamp < 3000) return
      wideStamp = now
      if (!wideMode) {
        releaseWide()
        return
      }

      const vw = window.innerWidth
      const panels = readingPanels()
      if (panels.length === 0) return

      let maxArea = 0
      for (const panel of panels) maxArea = Math.max(maxArea, panel.area)

      const next = []
      const seen = new Set()
      const consider = (node) => {
        if (!node || node.nodeType !== 1) return
        if (seen.has(node) || seen.size > 700) return
        seen.add(node)
        if (node.hasAttribute('data-550c-monitor')) return
        // A detached or exotic node is not a candidate, and asking a node that
        // cannot answer must not take the pass down with it.
        let rect = null
        try {
          rect = node.getBoundingClientRect()
        } catch {
          return
        }
        if (!rect || rect.width < 320 || rect.width > vw * 0.92 || rect.height < 80) return
        let limit = Number.NaN
        try {
          limit = Number.parseFloat(window.getComputedStyle(node).maxWidth)
        } catch {
          return
        }
        if (!Number.isFinite(limit) || limit >= vw * 0.92) return
        // Only a box that is ACTUALLY hitting its clamp: anything narrower is
        // already free to grow, and marking it would be noise.
        if (rect.width < limit - 3) return
        next.push(node)
      }
      const walk = (node, depth) => {
        consider(node)
        if (depth >= 3 || !node || !node.children) return
        const children = node.children
        for (let k = 0; k < children.length; k += 1) walk(children[k], depth + 1)
      }

      for (const panel of panels) {
        if (panel.area < maxArea * 0.5) continue
        let node = panel.node
        for (let up = 0; up < 5 && node && node !== document.body; up += 1) {
          consider(node)
          node = node.parentElement
        }
        walk(panel.node, 0)
      }

      for (const node of wideMarked) {
        if (next.indexOf(node) === -1) node.removeAttribute('data-550c-monitor-wide')
      }
      for (const node of next) node.setAttribute('data-550c-monitor-wide', '')
      wideMarked = next
    }

    /**
     * Geometry, by hand and on purpose.
     *
     *   width  — 28% of the frame, clamped to 340…480 px, and never wider than
     *            the column's right margin when the frame reports one.
     *   height — 64% of the room below the column head, clamped to 510…620 px.
     *            The top follows the column, the bottom-right corner stays free
     *            for whatever else lives there.
     */
    function place(plate, backdrop, frame, pos) {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const gutter = frame && frame.gutter !== null && frame.gutter !== undefined ? frame.gutter : null
      // The micro strip is reserved for genuinely small frames. A wide window that
      // reports "no margin" has almost certainly been measured badly, and hiding
      // the plate there is indistinguishable from the plugin having crashed: the
      // card then keeps its minimum width and overlaps a little instead.
      const narrow = vw < NARROW_FRAME_PX
      const inset = 10
      const top = frame && Number.isFinite(frame.top) ? frame.top : TOP_INSET

      if (narrow) {
        // A 16 px strip is thin enough to sit beside the scrollbar without
        // stealing a column from the conversation, and it is the one shape that
        // survives being zoomed down to a phone-sized frame.
        const height = Math.max(140, vh - top - inset)
        plate.setAttribute('data-mode', 'rail')
        plate.setAttribute('data-compact', '0')
        plate.style.width = '18px'
        plate.style.height = height + 'px'
        plate.style.top = top + 'px'
        plate.style.right = '6px'
        plate.style.left = 'auto'
        plate.style.bottom = 'auto'
        if (backdrop) backdrop.style.display = 'none'
        return
      }

      const folded = plate.getAttribute('data-folded') === '1'
      const height = folded
        ? 46
        : Math.round(Math.min(Math.max(510, (vh - top) * 0.64), 620))
      const wanted = Math.min(Math.max(350, vw * 0.3), 480)
      // Never wider than the margin the column actually leaves, but never so
      // narrow that the readings become unreadable either.
      const width = Math.round(gutter === null ? wanted : Math.min(wanted, Math.max(260, gutter - 20)))

      plate.setAttribute('data-mode', 'full')
      // A dragged card keeps its own corner: the measured margin only decides
      // where the card *starts*, and once the reader moves it they own it.
      const bag = pos
        ? {
            left: Math.min(Math.max(8, pos.left), Math.max(8, vw - width - 8)),
            top: Math.min(Math.max(8, pos.top), Math.max(8, vh - Math.min(height, 80))),
          }
        : null
      // All ten facts, the four headline ones, or gauges only.
      // Cut-offs are measured, not guessed: 613 px draws all ten facts, 508 px
      // draws the four headline ones, 415 px draws the gauges alone.
      plate.setAttribute('data-compact', height >= 615 ? '0' : height >= 505 ? '1' : '2')
      plate.style.width = width + 'px'
      plate.style.height = height + 'px'
      plate.style.top = (bag ? bag.top : top) + 'px'
      plate.style.right = bag ? 'auto' : inset + 'px'
      plate.style.left = bag ? bag.left + 'px' : 'auto'
      plate.style.bottom = 'auto'

      // The field behind the card is a backing plate, not a full-height gutter:
      // it tracks the card's own box so the empty corner stays truly empty.
      if (backdrop) {
        backdrop.style.display = ''
        backdrop.style.width = width + inset * 2 + 'px'
        backdrop.style.top = (bag ? bag.top : top) + 'px'
        backdrop.style.bottom = 'auto'
        backdrop.style.height = height + 'px'
        backdrop.style.left = bag ? bag.left - inset + 'px' : 'auto'
        backdrop.style.right = bag ? 'auto' : '0px'
      }
    }

    /**
     * True only while a dialog is actually *visible*. The shell keeps dialog
     * markup mounted between openings, so testing for the attribute alone latched
     * the plate hidden and looked exactly like a crash.
     */
    function dialogOpen() {
      let nodes = []
      try {
        nodes = document.querySelectorAll('[role="dialog"], [aria-modal="true"]')
      } catch {
        return false
      }
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i]
        if (!node || typeof node.getBoundingClientRect !== 'function') continue
        const rect = node.getBoundingClientRect()
        if (rect && rect.width > 200 && rect.height > 120) return true
      }
      return false
    }

    /* -------------------------------------------------------------- paint ---- */

    function factValues(stats) {
      const dev = stats && stats.ok !== false ? stats.device : null
      const gpu = stats && stats.ok !== false ? stats.gpu : null
      const ratio = typeof window.devicePixelRatio === 'number'
        ? Math.round(window.devicePixelRatio * 10) / 10
        : null
      let timeZone = null
      try {
        timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null
      } catch {
        timeZone = null
      }
      return {
        HOST: dev && dev.host ? dev.host : '--',
        OS: dev ? dev.os + ' ' + dev.arch : '--',
        CPU: dev && dev.cpuModel
          ? dev.cpuModel + ' \u00b7 ' + dev.cores
          : dev ? dev.cores + ' cores' : '--',
        MEM: dev && dev.memTotal ? formatBytes(dev.memTotal) : '--',
        GPU: gpu && gpu.name
          ? gpu.name + (gpu.memTotal ? ' \u00b7 ' + formatBytes(gpu.memTotal) : '')
          : '--',
        DSK: dev && dev.diskTotal
          ? (dev.diskMount || '') + ' ' + formatBytes(dev.diskTotal)
          : '--',
        NET: dev && dev.ip ? dev.ip : '--',
        NODE: dev && dev.node ? dev.node : '--',
        SCR: window.screen
          ? window.screen.width + '\u00d7' + window.screen.height + (ratio ? ' @' + ratio : '')
          : '--',
        TZ: timeZone || '--',
      }
    }

    function paint(view, stats, stale) {
      const { cells, facts } = view
      const has = stats !== null && stats.ok !== false
      const cpu = has ? stats.cpu : null
      const mem = has ? stats.mem : null
      const disk = has ? stats.disk : null
      const net = has ? stats.net : null
      const gpu = has ? stats.gpu : null
      const temps = has && stats.temps ? stats.temps : null

      // Network has no natural 0-100 scale, so its rail is relative to the
      // busiest second seen since mount, decaying slowly: a quiet link still
      // shows a visible pulse when anything crosses it.
      const throughput = net ? net.rx + net.tx : 0
      view.peak = Math.max((view.peak || 1e6) * 0.995, throughput, 1e6)
      const netPct = throughput > 0 ? Math.min(100, (100 * throughput) / view.peak) : 0

      const cpuTemp = temps && typeof temps.cpu === 'number' ? temps.cpu : null
      const gpuTemp = temps && typeof temps.gpu === 'number' ? temps.gpu : null
      const leadTemp = cpuTemp !== null ? cpuTemp : gpuTemp

      const rows = [
        {
          pct: cpu ? clampPct(cpu.pct) : 0,
          value: cpu ? formatPct(cpu.pct) : '--',
          level: cpu ? levelFor(cpu.pct) : 'quiet',
        },
        {
          pct: gpu ? clampPct(gpu.pct) : 0,
          value: gpu ? formatPct(gpu.pct) : '--',
          level: gpu ? levelFor(gpu.pct) : 'quiet',
        },
        {
          pct: mem ? clampPct(mem.pct) : 0,
          value: mem ? formatPct(mem.pct) : '--',
          level: mem ? levelFor(mem.pct) : 'quiet',
        },
        {
          pct: disk ? clampPct(disk.pct) : 0,
          value: disk ? formatPct(disk.pct) : '--',
          level: disk ? levelFor(disk.pct) : 'quiet',
        },
        {
          pct: netPct,
          value: net ? '\u2193' + formatBytes(net.rx) : '--',
          level: netPct >= 85 ? 'hot' : netPct >= 40 ? 'busy' : 'quiet',
        },
        {
          // CPU temperature needs an elevated WMI query that many Windows
          // builds refuse, so the row leads with whichever sensor answered and
          // labels the other one underneath.
          pct: tempPct(leadTemp),
          value: formatTemp(leadTemp),
          level: leadTemp === null ? 'quiet' : leadTemp >= 85 ? 'hot' : leadTemp >= 70 ? 'busy' : 'quiet',
        },
      ]

      cells.forEach((cell, index) => {
        const row = rows[index]
        cell.fill.style.width = row.pct.toFixed(1) + '%'
        cell.value.textContent = row.value
        cell.row.setAttribute('data-lv', row.level)
      })

      const values = factValues(has ? stats : null)
      for (const key of Object.keys(facts)) {
        facts[key].textContent = values[key] || '--'
      }

      view.title.textContent = stale ? '550C // HOLD' : '550C // SYS'
      view.plate.setAttribute('data-stale', stale ? '1' : '0')
      view.up.textContent = 'UP ' + (has && stats.uptime ? formatSpan(stats.uptime.system) : '--')
      view.sum.textContent = rows[0].value + ' · ' + rows[2].value + ' · ' + rows[4].value
      view.plate.setAttribute('aria-label', 'System monitor: '
        + rows.map((row, index) => ROWS[index] + ' ' + row.value).join(', '))
    }

    /* --------------------------------------------------------------- mount ---- */

    function mount() {
      const style = el('style')
      style.setAttribute('data-550c-monitor', '')
      style.textContent = CSS + EXTRA
      document.head.append(style)

      const view = buildPlate()
      view.peak = 1e6
      document.body.append(view.backdrop, view.plate)

      let alive = true
      let inflight = false
      let stats = null
      let failed = false
      let stale = true

      // The frame is measured rather than assumed, and re-measured on every
      // resize and on a slow tick: the sidebar collapses, the window is dragged
      // between monitors, and the transcript's top edge moves with both.
      // The column is widened BEFORE it is measured: taking a clamp off it moves
      // the column's right edge, and the card is placed against that edge.
      applyWide(true)
      let frame = measureFrame()

      // The reader's own choice, remembered across reloads: folding is a
      // preference, not a transient state.
      let folded = false
      try {
        folded = window.localStorage.getItem(FOLD_KEY) === '1'
      } catch {
        folded = false
      }

      // A remembered corner, if the reader has dragged the card before.
      let pos = null
      try {
        const saved = JSON.parse(window.localStorage.getItem(POS_KEY))
        if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) pos = saved
      } catch {
        pos = null
      }

      const syncFold = () => {
        view.plate.setAttribute('data-folded', folded ? '1' : '0')
        view.fold.textContent = folded ? '+' : '\u2013'
        view.fold.setAttribute('aria-expanded', folded ? 'false' : 'true')
        view.fold.setAttribute('aria-label', folded ? 'Unfold the system monitor' : 'Fold the system monitor')
        view.fold.setAttribute('title', folded ? 'Unfold' : 'Fold')
      }

      const render = () => {
        if (!alive) return
        try {
          const blocked = dialogOpen()
          view.plate.hidden = blocked
          view.backdrop.hidden = blocked
          if (!blocked) place(view.plate, view.backdrop, frame, pos)
          paint(view, stats, stale)
        } catch (error) {
          // A readout is not worth a broken frame: fall back to a fixed box that
          // is at least on screen, and say why in the console once.
          if (!render.failed) {
            render.failed = true
            if (typeof console !== 'undefined') console.warn('[monitor-550c] render failed', error)
          }
          view.plate.hidden = false
          view.plate.style.top = '46px'
          view.plate.style.right = '10px'
          view.plate.style.width = '300px'
          view.plate.style.height = '420px'
        }
      }

      syncFold()
      view.fold.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        folded = !folded
        try {
          window.localStorage.setItem(FOLD_KEY, folded ? '1' : '0')
        } catch {
          // A frame that refuses storage still folds; it just will not remember.
        }
        syncFold()
        render()
      })

      // Dragging moves the card, nothing else: no polling restart, no repaint
      // of the readouts, just the two style rules that place it.
      const placeOnly = () => {
        if (alive) place(view.plate, view.backdrop, frame, pos)
      }

      let drag = null
      view.head.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return
        if (event.target && event.target.closest && event.target.closest('.c-mon-fold')) return
        const rect = view.plate.getBoundingClientRect()
        drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, id: event.pointerId }
        try {
          view.head.setPointerCapture(event.pointerId)
        } catch {
          // No capture support: the drag still works while the pointer is inside.
        }
        view.plate.setAttribute('data-drag', '1')
        event.preventDefault()
      })

      view.head.addEventListener('pointermove', (event) => {
        if (!drag) return
        pos = { left: Math.round(event.clientX - drag.dx), top: Math.round(event.clientY - drag.dy) }
        placeOnly()
      })

      const endDrag = (event) => {
        if (!drag) return
        drag = null
        view.plate.removeAttribute('data-drag')
        try {
          view.head.releasePointerCapture(event.pointerId)
        } catch {
          /* released already */
        }
        try {
          window.localStorage.setItem(POS_KEY, JSON.stringify(pos))
        } catch {
          // Storage refused: the card stays where it was put, just not remembered.
        }
      }

      view.head.addEventListener('pointerup', endDrag)
      view.head.addEventListener('pointercancel', endDrag)

      // Double-click the header to hand the card back to the layout: undo a drag
      // without having to remember where it used to be.
      view.head.addEventListener('dblclick', () => {
        pos = null
        try {
          window.localStorage.removeItem(POS_KEY)
        } catch {
          /* nothing to clear */
        }
        remeasure()
      })

      const remeasure = () => {
        applyWide()
        frame = measureFrame()
        render()
      }

      // A way to hand the layout back without hunting for the storage key, and
      // the handle the smoke test drives. `widen(false)` is the whole undo.
      try {
        window.__monitor550c = {
          widen(on) {
            wideMode = on !== false
            try {
              window.localStorage.setItem(WIDE_KEY, wideMode ? '1' : '0')
            } catch {
              // Storage refused: the choice still applies to this page.
            }
            applyWide(true)
            remeasure()
          },
          get widened() {
            return wideMarked.length
          },
        }
      } catch {
        /* no window to hang it on */
      }

      const read = async () => {
        if (!alive || inflight || document.hidden) return
        inflight = true
        try {
          const response = await fetch(STATS_URL, { cache: 'no-store' })
          if (!response.ok) throw new Error('stats ' + response.status)
          const payload = await response.json()
          if (!alive) return
          stats = payload
          failed = false
        } catch {
          if (alive) failed = true
        } finally {
          inflight = false
          stale = stats === null || failed || Date.now() - stats.at > STALE_MS
          render()
        }
      }

      // The first paint happens before the first answer, so the plate appears
      // as an instrument that is still acquiring, not as an absence.
      render()
      read()

      const pollTimer = window.setInterval(read, POLL_MS)
      // Staleness has to keep up with a Host that stopped answering, which is
      // faster than the poll cadence.
      const tickTimer = window.setInterval(() => {
        if (!alive) return
        stale = stats === null || failed || Date.now() - stats.at > STALE_MS
        remeasure()
      }, 1000)
      // Dragging a window edge fires resize in bursts; one measurement per burst
      // is enough and keeps the layout from thrashing mid-drag.
      let resizeTimer = 0
      const onResize = () => {
        window.clearTimeout(resizeTimer)
        resizeTimer = window.setTimeout(remeasure, 120)
      }
      const onVisible = () => {
        if (!document.hidden) read()
      }
      window.addEventListener('resize', onResize)
      document.addEventListener('visibilitychange', onVisible)

      return () => {
        alive = false
        window.clearInterval(pollTimer)
        window.clearInterval(tickTimer)
        window.clearTimeout(resizeTimer)
        window.removeEventListener('resize', onResize)
        document.removeEventListener('visibilitychange', onVisible)
        style.remove()
        releaseWide()
        view.backdrop.remove()
        view.plate.remove()
      }
    }

    return {
      name: 'monitor-550c',
      // The plate depends on no Client service: it reads one Host route and the
      // page's own theme tokens.
      inject: [],
      apply(ctx) {
        // Mounted eagerly, then handed to `ctx.effect` when the Client context
        // offers one — a reader must not be able to outlive the plugin.
        const dispose = mount()
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(() => dispose, 'monitor-550c: plate')
        }
      },
    }
  },
})
