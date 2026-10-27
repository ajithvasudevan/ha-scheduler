/*
 * HA Scheduler — full-screen scheduling panel for Home Assistant.
 *
 * Model of operation
 * ------------------
 *  - Timing truth lives in built-in `schedule.*` helpers. Their state is a pure
 *    function of the wall clock, so after any restart they immediately report the
 *    correct on/off for *right now* rather than replaying missed edges.
 *  - The schedule -> target mapping lives in the `variables` block of a single
 *    generated automation (ENGINE_ID). That file is written by this panel and read
 *    back to rebuild the UI, so automations.yaml is the one persistent store.
 *  - A rule runs every day unless it is restricted to specific weekdays (the Specific
 *    weekdays toggle). A rule with no `days` field runs every day, so schedules written
 *    by an older version keep working unchanged.
 *
 * Editing anything below through the HA automation editor will be overwritten the
 * next time this panel saves.
 */

const ENGINE_ID = "ha_scheduler_engine";
const ENGINE_ALIAS = "HA Scheduler — engine";
const APPLY_EVENT = "ha_scheduler_apply";
// Non-admins are refused /api/config/*, where the model lives. They can, however,
// read any dashboard's Lovelace config, so admins mirror the model onto this hidden
// dashboard purely so everyone else has something to render.
const MIRROR_PATH = "schedules-data";
// custom_components/ha_scheduler. Present only if that integration is installed;
// it is what lets non-admins write, since services are callable by them and run with
// hass privileges rather than the caller's.
const SVC = "ha_scheduler";
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

// Domains that meaningfully answer homeassistant.turn_on / turn_off.
const SCHEDULABLE = ["switch", "light", "input_boolean", "fan", "siren", "valve", "humidifier", "automation"];

// mdi:weather-sunny
const ICON_SUN =
  "M12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,2L14.39,5.42C13.65,5.15 12.84,5 12,5C11.16,5 10.35,5.15 9.61,5.42L12,2M3.34,7L7.5,6.65C6.9,7.16 6.36,7.78 5.94,8.5C5.5,9.22 5.25,10 5.11,10.79L3.34,7M3.36,17L5.12,13.23C5.26,14 5.5,14.8 5.95,15.5C6.39,16.22 6.93,16.83 7.53,17.35L3.36,17M20.65,7L18.88,10.79C18.74,10 18.47,9.23 18.05,8.5C17.63,7.78 17.1,7.15 16.5,6.64L20.65,7M20.64,17L16.46,17.33C17.07,16.82 17.61,16.2 18.04,15.5C18.46,14.8 18.73,14 18.87,13.21L20.64,17M12,22L9.59,18.56C10.33,18.83 11.14,19 12,19C12.86,19 13.67,18.83 14.41,18.56L12,22Z";
// mdi:clock-outline
const ICON_CLOCK_SM =
  "M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22C6.47,22 2,17.5 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z";

// mdi:restore — a clock with a counter-clockwise arrow.
const ICON_RESTORE =
  "M13,3A9,9 0 0,0 4,12H1L4.89,15.89L4.96,16.03L9,12H6A7,7 0 0,1 13,5A7,7 0 0,1 20,12A7,7 0 0,1 13,19" +
  "C11.07,19 9.32,18.21 8.06,16.94L6.64,18.36C8.27,20 10.51,21 13,21A9,9 0 0,0 22,12A9,9 0 0,0 13,3" +
  "M12,8V13L16.28,15.54L17,14.33L13.5,12.25V8H12Z";

// Empty-state art only: nothing else in the panel draws a device icon any more.
const ICON_CLOCK =
  "M12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20M12,2A10,10 0 0,0 2,12" +
  "A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12.5,7H11V13L15.75,15.85L16.5,14.62L12.5,12.25V7Z";

const clampDay = (m) => ((m % 1440) + 1440) % 1440;
const toMin = (hhmm) => {
  const p = String(hhmm).split(":");
  return clampDay(parseInt(p[0], 10) * 60 + parseInt(p[1], 10));
};
const toHHMM = (m) => {
  const v = clampDay(Math.round(m));
  return String(Math.floor(v / 60)).padStart(2, "0") + ":" + String(v % 60).padStart(2, "0");
};
const dur = (mins) => {
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  if (h && m) return h + "h " + m + "m";
  if (h) return h + "h";
  return m + "m";
};
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** True when a window side is a solar time {sun: "sunrise"|"sunset", offset: <int>}. */
const isSolar = (v) => v !== null && v !== undefined && typeof v === "object" && "sun" in v;

/** Human label for any window side value (integer, null, or solar object). */
const sideLabel = (v) => {
  if (v === null || v === undefined) return "--";
  if (isSolar(v)) {
    const name = v.sun === "sunrise" ? "Sunrise" : "Sunset";
    if (!v.offset) return name;
    return name + (v.offset > 0 ? "+" : "") + v.offset + "m";
  }
  return toHHMM(v);
};

/**
 * A window is {s, e} in minutes-of-day. e <= s means it wraps past midnight, and
 * {s:0, e:0} is the all-day window. Everything the UI shows is derived from this
 * one shape.
 *
 * A window carrying `draft: true` is a row the user has just added and not yet given
 * a range. It renders as 00:00 -> 00:00 but is kept out of every span/merge/total
 * calculation, because {s:0, e:0} would otherwise read as all-day and swallow the
 * other windows the moment the row appeared. It sheds the flag as soon as its two
 * times differ, and saving is blocked while one is still pending.
 */
const winLength = (w) => (w.e > w.s ? w.e - w.s : 1440 - w.s + w.e);

// A window with one side unset is an *edge*: "turn on at 06:00" or "turn off at 22:00",
// saying nothing about the rest of the day. A rule holding any of them switches only at
// the moments it lists — it never asserts a state in between, so nothing is restored for
// it at boot and Restore now leaves it alone.
const isEdge = (w) => w.s === null || w.e === null;
const hasEdges = (windows) => (windows || []).some(isEdge);
// A solar rule has at least one side that is sunrise/sunset ± offset. Like edge rules,
// solar rules do not restore state at boot; they fire only at the solar moment each day.
const hasSolarWindows = (windows) => (windows || []).some((w) => isSolar(w.s) || isSolar(w.e));
// Intervals of fixed integer sides only (excludes one-way and solar windows).
const intervalsOf = (windows) => (windows || []).filter((w) => !isEdge(w) && !isSolar(w.s) && !isSolar(w.e));
const clock = (m) => toHHMM(m) + ":00";

/** The soonest edge in a set of windows, as {at, action, mins} counting from now. */
function nextEdge(windows, nowMin) {
  let best = null;
  for (const w of windows || []) {
    for (const [t, action] of [[w.s, "on"], [w.e, "off"]]) {
      if (t === null || t === undefined) continue;
      const mins = (t - nowMin + 1440) % 1440;
      if (!best || mins < best.mins) best = { at: t, action, mins };
    }
  }
  return best;
}

/** Flatten wrapping windows into plain [start,end) spans on a single 0..1440 line. */
function toSpans(windows) {
  windows = intervalsOf(windows);
  const spans = [];
  for (const w of windows) {
    if (winLength(w) >= 1440) return [[0, 1440]];
    if (w.e > w.s) spans.push([w.s, w.e]);
    else {
      if (w.s < 1440) spans.push([w.s, 1440]);
      if (w.e > 0) spans.push([0, w.e]);
    }
  }
  return spans;
}

/** Union of spans, adjacent runs joined. This is what makes overlaps impossible. */
function mergeSpans(spans) {
  if (!spans.length) return [];
  const sorted = spans.slice().sort((a, b) => a[0] - b[0]);
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i], last = out[out.length - 1];
    if (cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
    else out.push(cur.slice());
  }
  return out;
}

/**
 * Normalise a window list: merge overlaps, re-join a span touching midnight from
 * both ends back into one wrapping window. Idempotent.
 */
function normalise(windows) {
  const merged = mergeSpans(toSpans(windows));
  if (!merged.length) return [];
  if (merged.length === 1 && merged[0][0] === 0 && merged[0][1] >= 1440) return [{ s: 0, e: 0 }];
  const first = merged[0], last = merged[merged.length - 1];
  if (merged.length > 1 && first[0] === 0 && last[1] >= 1440) {
    const wrapped = { s: last[0], e: first[1] };
    return merged.slice(1, -1).map((sp) => ({ s: sp[0], e: sp[1] })).concat([wrapped])
      .sort((a, b) => a.s - b.s);
  }
  return merged.map((sp) => ({ s: sp[0], e: sp[1] >= 1440 ? 0 : sp[1] }));
}

const totalOnMinutes = (windows) =>
  mergeSpans(toSpans(windows)).reduce((n, sp) => n + (sp[1] - sp[0]), 0);

/**
 * Spans for a single window. Unlike toSpans() this never collapses the whole set to
 * one all-day span, so a window's contribution stays individually countable.
 */
function winSpans(w) {
  if (winLength(w) >= 1440) return [[0, 1440]];
  if (w.e > w.s) return [[w.s, w.e]];
  const out = [];
  if (w.s < 1440) out.push([w.s, 1440]);
  if (w.e > 0) out.push([0, w.e]);
  return out;
}

/**
 * Elementary intervals tagged with how many windows cover them, so the ribbon can
 * draw overlaps as overlaps instead of hiding them behind a merge.
 *
 * Windows are never merged in the UI. Only the blocks handed to the schedule helper
 * are (HA rejects overlapping blocks), and since a union of on-periods is what the
 * device actually experiences, the behaviour is identical either way.
 */
function depthSegments(windows) {
  // Each span remembers the window it came from, so a slice can name the entries
  // covering it and depth counts distinct *windows* rather than spans — a window
  // that wraps midnight contributes two spans but must still count once.
  const spans = [];
  for (let i = 0; i < windows.length; i++) {
    if (isEdge(windows[i])) continue;   // drawn as a marker, not a band
    for (const sp of winSpans(windows[i])) spans.push([sp[0], sp[1], i]);
  }
  if (!spans.length) return [];
  const cuts = new Set([0, 1440]);
  for (const sp of spans) { cuts.add(sp[0]); cuts.add(sp[1]); }
  const pts = Array.from(cuts).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const wins = [];
    for (const sp of spans)
      if (sp[0] <= a && sp[1] >= b && wins.indexOf(sp[2]) < 0) wins.push(sp[2]);
    if (!wins.length) continue;
    const last = out[out.length - 1];
    // Only join neighbouring slices that the same windows cover, or the tooltip
    // would claim entries that do not reach that far.
    if (last && last.b === a && last.wins.join() === wins.join()) last.b = b;
    else out.push({ a: a, b: b, depth: wins.length, wins: wins });
  }
  return out;
}

const maxDepth = (windows) =>
  depthSegments(windows).reduce((n, sg) => Math.max(n, sg.depth), 0);

/** windows -> the per-day block list a schedule helper stores. */
function windowsToBlocks(windows) {
  return mergeSpans(toSpans(windows)).map((sp) => ({
    from: toHHMM(sp[0]) + ":00",
    to: sp[1] >= 1440 ? "24:00:00" : toHHMM(sp[1]) + ":00",
  }));
}

/** A schedule helper's stored blocks -> windows. Inverse of the above. */
function blocksToWindows(blocks) {
  if (!blocks || !blocks.length) return [];
  const spans = blocks.map((b) => {
    const from = toMin(b.from.slice(0, 5));
    // `schedule/list` stores "24:00:00"; `schedule.get_schedule` reports the same
    // boundary as "23:59:59.999999". Both mean end-of-day.
    const toRaw = String(b.to);
    const to = toRaw.indexOf("24:00") === 0 || toRaw.indexOf("00:00") === 0 ||
               toRaw.indexOf("23:59:59") === 0 ? 1440 : toMin(toRaw.slice(0, 5));
    return [from, to];
  });
  return normalise(mergeSpans(spans).map((sp) => ({ s: sp[0], e: sp[1] >= 1440 ? 0 : sp[1] })));
}

/* --------------------------------------------------------------- weekdays */

const DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** 7-char Mon..Sun mask: "1" on an active weekday. null / empty / all-seven all mean
 *  every day and give "1111111" — so a rule from an older version (no `days` field)
 *  behaves exactly as it always did. Mirrors daymask() in engine.py. */
function daymask(days) {
  const s = days ? new Set(days.map(Number)) : new Set();
  if (!s.size || s.size >= 7) return "1111111";
  let out = "";
  for (let i = 0; i < 7; i++) out += s.has(i) ? "1" : "0";
  return out;
}

/** windows + a weekday set -> the per-weekday block map a schedule helper stores.
 *  A wrapping window puts its after-midnight tail on the following calendar day, so a
 *  weekday-restricted wrapping window still spills into the next morning. Mirrors
 *  days_payload() in engine.py; with days=null it reproduces the old every-day map. */
function daysBlocks(windows, days) {
  const active = daymask(days) === "1111111" ? [0, 1, 2, 3, 4, 5, 6] : days.map(Number);
  const per = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const w of intervalsOf(windows)) {
    if (winLength(w) >= 1440) { for (const d of active) per[d].push([0, 1440]); continue; }
    if (w.e > w.s) { for (const d of active) per[d].push([w.s, w.e]); }
    // e === 0 ends exactly at midnight and does not spill into the next day; only a
    // true wrap (e > 0) contributes an after-midnight tail.
    else { for (const d of active) { per[d].push([w.s, 1440]); if (w.e > 0) per[(d + 1) % 7].push([0, w.e]); } }
  }
  const out = {};
  for (let d = 0; d < 7; d++) {
    out[DAYS[d]] = mergeSpans(per[d]).map((sp) => ({
      from: toHHMM(sp[0]) + ":00",
      to: sp[1] >= 1440 ? "24:00:00" : toHHMM(sp[1]) + ":00",
    }));
  }
  return out;
}

/** Short human label for a rule's weekday restriction, or "" for every day. */
function daysLabel(days) {
  if (!Array.isArray(days) || !days.length || days.length >= 7) return "";
  const s = Array.from(new Set(days.map(Number))).sort((a, b) => a - b);
  if (s.join() === "0,1,2,3,4") return "Weekdays";
  if (s.join() === "5,6") return "Weekends";
  return s.map((i) => DAY_ABBR[i]).join(", ");
}

/* ----------------------------------------------- timeline (midnight-centred) */

// Midnight sits in the CENTRE of the bar (noon at both edges), so a minute-of-day is
// shifted +12h before being turned into a percentage. Everything else stays in real
// minutes; only drawing uses these.
const VSHIFT = 720;
const toVisualPct = (m) => (((m + VSHIFT) % 1440) / 14.4);

/** A minute-space span [a,b) (0..1440, a<b) -> one or two visual [left,right) spans in
 *  minutes. A span crossing the noon seam (the bar's two edges) splits into two. */
function visualRects(a, b) {
  if (b - a >= 1440) return [[0, 1440]];
  const va = (a + VSHIFT) % 1440;
  let vb = (b + VSHIFT) % 1440;
  if (vb === 0) vb = 1440;   // a span ending exactly at noon sits at the right edge, not 0
  if (va < vb) return [[va, vb]];
  return [[va, 1440], [0, vb]];
}

/* ------------------------------------------------- engine automation builder */

function _solarOffsetStr(offset) {
  const sign = offset >= 0 ? "+" : "-";
  const m = Math.abs(Math.round(offset));
  return sign + String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0") + ":00";
}
function _solarTid(event, offset) {
  return "solar_" + event + "_" + (offset >= 0 ? "+" : "") + Math.round(offset);
}

function buildEngine(model) {
  const live = (model.rules || []).filter((r) => r.enabled !== false && (r.targets || []).length);

  // Separate solar rules (any window side is sunrise/sunset ± offset) from fixed-time rules.
  const solarLive = live.filter((r) => hasSolarWindows(r.windows));
  const nonSolarLive = live.filter((r) => !hasSolarWindows(r.windows));

  const rules = nonSolarLive.filter((r) => r.schedule && !hasEdges(r.windows));
  const m = {};    // target entity -> schedule entity
  const s2t = {};  // schedule entity -> [target entities]
  for (const r of rules) {
    s2t[r.schedule] = r.targets.slice();
    for (const t of r.targets) m[t] = r.schedule;
  }

  // Fixed-time edge map (non-solar one-way rules + fixed sides of solar rules). Each
  // entry is [entity, weekday-mask] so the engine can skip an entity on a day its rule
  // does not cover; an all-day rule's mask is "1111111", so it always fires.
  const edges = {};
  const addEdge = (at, action, targets, mask) => {
    const slot = (edges[at] = edges[at] || {});
    const list = (slot[action] = slot[action] || []);
    for (const t of targets) if (!list.some((p) => p[0] === t)) list.push([t, mask]);
  };
  for (const r of nonSolarLive.filter((x) => hasEdges(x.windows))) {
    const mask = daymask(r.days);
    for (const w of r.windows || []) {
      if (w.s !== null && w.s !== undefined) addEdge(clock(w.s), "on", r.targets, mask);
      if (w.e !== null && w.e !== undefined) addEdge(clock(w.e), "off", r.targets, mask);
    }
  }

  // Solar edge map: tid -> { on: [[entity, mask], ...], off: [...] }
  const solarEdges = {};  // tid -> { event, offset, on: [], off: [] }
  for (const r of solarLive) {
    const mask = daymask(r.days);
    for (const w of r.windows || []) {
      for (const [side, action] of [["s", "on"], ["e", "off"]]) {
        const v = w[side];
        if (v === null || v === undefined) continue;
        if (isSolar(v)) {
          const offset = v.offset || 0;
          const tid = _solarTid(v.sun, offset);
          if (!solarEdges[tid]) solarEdges[tid] = { event: v.sun, offset, on: [], off: [] };
          const list = solarEdges[tid][action];
          for (const t of r.targets) if (!list.some((p) => p[0] === t)) list.push([t, mask]);
        } else {
          // Fixed side of a solar rule — plain time trigger.
          addEdge(clock(v), action, r.targets, mask);
        }
      }
    }
  }

  const byEnt = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const edgeTimes = Object.keys(edges).sort();
  const e = {};
  for (const at of edgeTimes) {
    const slot = {};
    for (const action of ["on", "off"]) if (edges[at][action]) slot[action] = edges[at][action].slice().sort(byEnt);
    e[at] = slot;
  }
  // Strip event/offset before storing in automation variables.
  const hs_solar_e = {};
  for (const tid of Object.keys(solarEdges).sort()) {
    const d = solarEdges[tid];
    hs_solar_e[tid] = { on: d.on.slice().sort(byEnt), off: d.off.slice().sort(byEnt) };
    if (!hs_solar_e[tid].on.length) delete hs_solar_e[tid].on;
    if (!hs_solar_e[tid].off.length) delete hs_solar_e[tid].off;
  }

  const schedEnts = Object.keys(s2t).sort();
  const targetEnts = Object.keys(m).sort();

  const triggers = [
    { trigger: "homeassistant", event: "start", id: "boot" },
    { trigger: "event", event_type: APPLY_EVENT, id: "apply" },
  ];
  if (schedEnts.length)
    triggers.push({ trigger: "state", entity_id: schedEnts, to: ["on", "off"], for: { seconds: 3 }, id: "sched" });
  if (targetEnts.length)
    triggers.push({ trigger: "state", entity_id: targetEnts, from: ["unavailable", "unknown"], for: { seconds: 5 }, id: "revive" });
  if (edgeTimes.length) triggers.push({ trigger: "time", at: edgeTimes, id: "edge" });
  for (const tid of Object.keys(solarEdges).sort()) {
    const d = solarEdges[tid];
    triggers.push({ trigger: "sun", event: d.event, offset: _solarOffsetStr(d.offset), id: tid });
  }

  return {
    id: ENGINE_ID,
    alias: ENGINE_ALIAS,
    description:
      "Generated by the Schedules panel. Do not edit here — changes are overwritten on the next save.",
    mode: "parallel",
    max: 60,
    variables: { hs_m: m, hs_s2t: s2t, hs_e: e, hs_solar_e, hs_cfg: model },
    triggers,
    conditions: [],
    actions: [
      {
        variables: {
          hs_todo:
            "{% if trigger.id == 'sched' %}{{ hs_s2t.get(trigger.entity_id, []) }}" +
            "{% elif trigger.id == 'revive' %}{{ [trigger.entity_id] }}" +
            "{% elif trigger.id == 'boot' or trigger.id == 'apply' %}{{ hs_m.keys() | list }}" +
            "{% else %}{{ [] }}{% endif %}",
        },
      },
      {
        if: [{ condition: "template", value_template: "{{ trigger.id == 'boot' }}" }],
        then: [{ delay: { seconds: 40 } }],
      },
      {
        repeat: {
          for_each: "{{ hs_todo }}",
          sequence: [
            {
              variables: {
                hs_w: "{{ states(hs_m[repeat.item]) if repeat.item in hs_m else 'skip' }}",
                hs_cur: "{{ states(repeat.item) }}",
              },
            },
            {
              if: [
                {
                  condition: "template",
                  value_template:
                    "{{ hs_w in ['on','off'] and hs_cur not in ['unavailable','unknown','none',''] and hs_cur != hs_w }}",
                },
              ],
              then: [{ action: "homeassistant.turn_{{ hs_w }}", target: { entity_id: "{{ repeat.item }}" } }],
            },
          ],
        },
      },
      {
        if: [{ condition: "template", value_template: "{{ trigger.id == 'edge' }}" }],
        then: [
          { variables: { hs_at: "{{ trigger.now.strftime('%H:%M:00') }}" } },
          {
            variables: {
              // Each entry is [entity, weekday-mask]; keep only those whose mask has today
              // set. An all-day rule's mask is all 1s, so it always passes.
              hs_on:
                "{% set wd = now().weekday() %}{% set ns = namespace(l=[]) %}" +
                "{% for p in hs_e.get(hs_at, {}).get('on', []) %}" +
                "{% if p[1][wd] == '1' %}{% set ns.l = ns.l + [p[0]] %}{% endif %}{% endfor %}{{ ns.l }}",
              hs_off:
                "{% set wd = now().weekday() %}{% set ns = namespace(l=[]) %}" +
                "{% for p in hs_e.get(hs_at, {}).get('off', []) %}" +
                "{% if p[1][wd] == '1' %}{% set ns.l = ns.l + [p[0]] %}{% endif %}{% endfor %}{{ ns.l }}",
            },
          },
          {
            if: [{ condition: "template", value_template: "{{ hs_on | count > 0 }}" }],
            then: [{ action: "homeassistant.turn_on", target: { entity_id: "{{ hs_on }}" } }],
          },
          {
            if: [{ condition: "template", value_template: "{{ hs_off | count > 0 }}" }],
            then: [{ action: "homeassistant.turn_off", target: { entity_id: "{{ hs_off }}" } }],
          },
        ],
      },
      {
        // Solar triggers fire at sunrise/sunset ± offset. The trigger id encodes the
        // event and offset and matches a key in hs_solar_e.
        if: [{ condition: "template", value_template: "{{ trigger.id.startswith('solar_') }}" }],
        then: [
          {
            variables: {
              // Each entry is [entity, weekday-mask]; keep only today's.
              hs_solar_on:
                "{% set wd = now().weekday() %}{% set ns = namespace(l=[]) %}" +
                "{% for p in hs_solar_e.get(trigger.id, {}).get('on', []) %}" +
                "{% if p[1][wd] == '1' %}{% set ns.l = ns.l + [p[0]] %}{% endif %}{% endfor %}{{ ns.l }}",
              hs_solar_off:
                "{% set wd = now().weekday() %}{% set ns = namespace(l=[]) %}" +
                "{% for p in hs_solar_e.get(trigger.id, {}).get('off', []) %}" +
                "{% if p[1][wd] == '1' %}{% set ns.l = ns.l + [p[0]] %}{% endif %}{% endfor %}{{ ns.l }}",
            },
          },
          {
            if: [{ condition: "template", value_template: "{{ hs_solar_on | count > 0 }}" }],
            then: [{ action: "homeassistant.turn_on", target: { entity_id: "{{ hs_solar_on }}" } }],
          },
          {
            if: [{ condition: "template", value_template: "{{ hs_solar_off | count > 0 }}" }],
            then: [{ action: "homeassistant.turn_off", target: { entity_id: "{{ hs_solar_off }}" } }],
          },
        ],
      },
    ],
  };
}

/* ------------------------------------------------------------------- styles */

const STYLES = `
:host {
  display: block; height: 100%;
  font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
  color: var(--primary-text-color);
  --hs-on: var(--primary-color);
  --hs-track: var(--divider-color, rgba(127,127,127,.25));
  --hs-input-color: #111111;
  --hs-color-scheme: light;
  --hs-gap: 16px;
}
* { box-sizing: border-box; }
.wrap { height: 100%; overflow-y: auto; padding: 0 0 64px; background: var(--primary-background-color); }
.inner { max-width: 1040px; margin: 0 auto; padding: 0 16px; }

header.bar {
  position: sticky; top: 0; z-index: 5;
  background: var(--app-header-background-color, var(--primary-color));
  color: var(--app-header-text-color, #fff);
  padding: 14px 16px; display: flex; align-items: center; gap: 12px;
  box-shadow: var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,.16));
}
header.bar h1 { margin: 0; font-size: 20px; font-weight: 500; flex: 1; }
/* Not an inline style: the phone breakpoint has to be able to widen this to a row. */
.htitle { flex: 1; min-width: 0; }
.sub { font-size: 13px; opacity: .85; margin-top: 2px; font-weight: 400; }

button { font: inherit; cursor: pointer; border: none; border-radius: 999px; }
.btn-primary {
  background: var(--hs-on); color: var(--text-primary-color, #fff);
  padding: 10px 20px; font-weight: 500; display: inline-flex; align-items: center; gap: 8px;
}
.btn-primary.on-header { background: rgba(255,255,255,.18); color: inherit; }
.btn-primary.on-header.quiet { background: rgba(255,255,255,.10); font-weight: 400; }
.hbadge { background: rgba(0,0,0,.28); border-radius: 999px; padding: 1px 8px; font-size: 12px; }
.btn-primary:hover { filter: brightness(1.08); }
.btn-ghost {
  background: transparent; color: var(--secondary-text-color);
  padding: 7px 12px; border: 1px solid var(--hs-track);
}
.btn-ghost:hover { background: var(--hs-track); }
.btn-ghost.danger { color: var(--error-color, #db4437); border-color: var(--error-color, #db4437); }
.icon-btn {
  background: transparent; color: var(--secondary-text-color);
  width: 36px; height: 36px; display: grid; place-items: center; border-radius: 50%;
}
.icon-btn:hover { background: var(--hs-track); }
svg.i { width: 20px; height: 20px; fill: currentColor; display: block; }

/* ---- banner ---- */
.banner {
  margin: var(--hs-gap) 0 0; padding: 12px 16px; border-radius: 10px;
  background: var(--warning-color, #ffa600); color: #000;
  display: flex; align-items: center; gap: 12px; font-size: 14px;
}
.banner button { background: rgba(0,0,0,.15); color: inherit; padding: 6px 14px; }
.banner.info { background: var(--hs-track); color: var(--primary-text-color); }

/* ---- rule card ---- */
.card {
  background: var(--ha-card-background, var(--card-background-color, #fff));
  border-radius: var(--ha-card-border-radius, 12px);
  box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,.10));
  border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, transparent);
  padding: 16px; margin-top: var(--hs-gap);
}
.card.paused { opacity: .55; }
.card-head { display: flex; align-items: center; gap: 12px; }
.titles { flex: 1; min-width: 0; }
.titles .name { font-size: 17px; font-weight: 500; }
.titles .meta { font-size: 13px; color: var(--secondary-text-color); margin-top: 2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pill {
  font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
  padding: 3px 10px; border-radius: 999px; background: var(--hs-track);
  color: var(--secondary-text-color); white-space: nowrap;
}
.pill.on { background: var(--hs-on); color: var(--text-primary-color, #fff); }
.pill.warn { background: var(--error-color, #db4437); color: #fff; }

/* ---- ribbon ---- */
.ribbon { margin-top: 14px; }
.ticks { display: flex; font-size: 10px; color: var(--secondary-text-color); margin-bottom: 3px; }
.ticks span { flex: 1; text-align: left; }
.ticks span:last-child { flex: 0; }
.track {
  position: relative; height: 26px; border-radius: 6px;
  background: var(--hs-track); overflow: hidden;
}
.track.tall { height: 46px; }
.seg { position: absolute; top: 0; bottom: 0; background: var(--hs-on); cursor: help; }
.seg.d2 { filter: brightness(.74); }
.seg.d3 { filter: brightness(.55); }
.now {
  position: absolute; top: -3px; bottom: -3px; width: 2px;
  background: var(--accent-color, #ff9800); box-shadow: 0 0 0 1px rgba(0,0,0,.25);
}
.edge { position: absolute; top: 0; bottom: 0; pointer-events: none; }
.edge.on { background: linear-gradient(to right, var(--hs-on), transparent); opacity: .55; }
.edge.off { background: linear-gradient(to left, var(--hs-on), transparent); opacity: .3; }
.edge-line { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px;
  background: var(--hs-on); cursor: default; }
.chip.oneway { background: var(--hs-on); color: var(--text-primary-color, #fff); }
.tsel.unset select { color: var(--secondary-text-color); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; align-items: center; }

.chip {
  font-size: 13px; padding: 5px 12px; border-radius: 999px;
  background: var(--hs-track); color: var(--primary-text-color);
  font-variant-numeric: tabular-nums;
}
.chip .len { color: var(--secondary-text-color); margin-left: 6px; font-size: 12px; }
.chip.draft { background: var(--warning-color, #ffa600); color: #000; font-weight: 500; }


.foot { margin-top: 12px; font-size: 13px; color: var(--secondary-text-color); }

/* ---- empty state ---- */
.empty { text-align: center; padding: 72px 16px; color: var(--secondary-text-color); }
.empty svg { width: 64px; height: 64px; fill: currentColor; opacity: .35; }
.empty h2 { margin: 16px 0 6px; font-size: 20px; font-weight: 400; color: var(--primary-text-color); }
.empty p { margin: 0 0 24px; font-size: 14px; }

/* ---- dialog ---- */
.overlay {
  position: fixed; inset: 0; z-index: 20; background: rgba(0,0,0,.45);
  display: flex; align-items: center; justify-content: center; padding: 16px;
}
.dialog {
  background: var(--ha-card-background, var(--card-background-color, #fff));
  border-radius: 14px; width: 100%; max-width: 640px; max-height: 92vh;
  display: flex; flex-direction: column; box-shadow: 0 12px 40px rgba(0,0,0,.4);
  position: relative;
}
.confirm-scrim {
  position: absolute; inset: 0; z-index: 10; border-radius: inherit;
  background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center;
}
.confirm-box {
  background: var(--ha-card-background, var(--card-background-color, #fff));
  border-radius: 12px; padding: 24px 28px; max-width: 300px; text-align: center;
  box-shadow: 0 4px 20px rgba(0,0,0,.35);
}
.confirm-box p { margin: 0 0 20px; font-size: 15px; line-height: 1.4; }
.confirm-box .cbtns { display: flex; gap: 10px; justify-content: center; }
.dialog h2 { margin: 0; padding: 20px 24px 12px; font-size: 20px; font-weight: 500; }
.dialog .body { padding: 0 24px; overflow-y: auto; flex: 1; }
.dialog .foot-bar {
  padding: 14px 20px; display: flex; gap: 10px; justify-content: flex-end; align-items: center;
  border-top: 1px solid var(--hs-track);
}
.dialog .foot-bar .spacer { flex: 1; }
.section { margin: 18px 0 8px; font-size: 12px; font-weight: 600; letter-spacing: .07em;
  text-transform: uppercase; color: var(--secondary-text-color); }

/* ---- entity picker ---- */
.search {
  width: 100%; padding: 10px 14px; font: inherit; border-radius: 8px;
  border: 1px solid var(--hs-track); background: var(--primary-background-color);
  color: var(--primary-text-color);
}
.picker { max-height: 260px; overflow-y: auto; margin-top: 10px;
  border: 1px solid var(--hs-track); border-radius: 8px; }
.grp { padding: 8px 14px 4px; font-size: 11px; font-weight: 600; letter-spacing: .06em;
  text-transform: uppercase; color: var(--secondary-text-color);
  background: var(--primary-background-color); position: sticky; top: 0; }
.opt { display: flex; align-items: center; gap: 12px; padding: 9px 14px; cursor: pointer; }
.opt:hover { background: var(--hs-track); }
.opt input { width: 18px; height: 18px; accent-color: var(--hs-on); flex: none; }
.opt .l { flex: 1; min-width: 0; }
.opt .l b { font-weight: 400; font-size: 14px; display: block; }
.opt .l small { color: var(--secondary-text-color); font-size: 12px; }
.opt .taken { font-size: 11px; color: var(--warning-color, #ffa600); }
.selected-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.selected-chips .chip { display: inline-flex; align-items: center; gap: 6px; cursor: default; }
.selected-chips .chip button { background: none; color: inherit; opacity: .6; padding: 0;
  display: grid; place-items: center; }
.selected-chips .chip button:hover { opacity: 1; }

/* ---- window editor rows ---- */
.wrow { display: flex; align-items: center; gap: 8px; padding: 8px 0; flex-wrap: wrap; }
.tsel { display: inline-flex; align-items: center; gap: 3px;
  background: var(--primary-background-color); border: 1px solid var(--hs-track);
  border-radius: 8px; padding: 2px 6px; }
.tsel select {
  font: inherit; font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums;
  border: none; background: transparent; color: var(--hs-input-color);
  color-scheme: var(--hs-color-scheme);
  opacity: 1; padding: 7px 5px; cursor: pointer; appearance: none; text-align: center;
}
.tsel select option { color: #111111; background: #ffffff; }
.tsel select:focus { outline: 2px solid var(--hs-on); border-radius: 4px; }
.tsel .colon { opacity: .5; }
.arrow { color: var(--secondary-text-color); font-size: 16px; }
.wlen { font-size: 13px; color: var(--secondary-text-color); margin-left: auto;
  font-variant-numeric: tabular-nums; }
.hint { font-size: 13px; color: var(--secondary-text-color); margin: 6px 0 0; }
.hint.note { color: var(--hs-on); }
/* Solar time selector — replaces the HH:MM dropdowns when a side is sunrise/sunset. */
.solar-tsel { gap: 5px; }
.solar-tsel select {
  font: inherit; font-size: 14px; font-weight: 600;
  border: none; background: transparent; color: var(--hs-input-color);
  color-scheme: var(--hs-color-scheme);
  opacity: 1; padding: 6px 3px; cursor: pointer; appearance: none;
}
.solar-tsel select option { color: #111111; background: #ffffff; }
.solar-tsel select:focus { outline: 2px solid var(--hs-on); border-radius: 4px; }
.solar-offset {
  width: 52px; font: inherit; font-size: 14px; font-weight: 600;
  font-variant-numeric: tabular-nums; border: none; background: transparent;
  color: var(--hs-input-color); color-scheme: var(--hs-color-scheme);
  opacity: 1; text-align: right; padding: 6px 2px;
}
.solar-offset:focus { outline: 2px solid var(--hs-on); border-radius: 4px; }
.solar-unit { font-size: 12px; color: var(--secondary-text-color); }
.solar-mode-btn { color: var(--hs-on); width: 28px; height: 28px; }
.solar-mode-btn svg { width: 16px; height: 16px; }
/* Specific-weekdays row: the toggle plus, when it is on, the seven day chips — all on
   one line below the on-times section. */
.wdrow { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
.wdlabel { font-size: 14px; }
.hs-switch { position: relative; display: inline-block; width: 40px; height: 22px; flex: 0 0 auto; cursor: pointer; }
.hs-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.hs-switch .sw { position: absolute; inset: 0; border-radius: 22px; background: var(--hs-track); transition: background .15s; }
.hs-switch .sw::before {
  content: ''; position: absolute; height: 16px; width: 16px; left: 3px; top: 3px;
  border-radius: 50%; background: #fff; transition: transform .15s; box-shadow: 0 1px 2px rgba(0,0,0,.3);
}
.hs-switch input:checked + .sw { background: var(--hs-on); }
.hs-switch input:checked + .sw::before { transform: translateX(18px); }
.wdays { display: flex; gap: 6px; flex-wrap: wrap; }
.daybox { position: relative; cursor: pointer; }
.daybox input { position: absolute; opacity: 0; width: 0; height: 0; }
.daybox span {
  display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px;
  border-radius: 50%; border: 1px solid var(--hs-track); font-size: 13px; font-weight: 600;
  color: var(--secondary-text-color); user-select: none; transition: background .12s, color .12s, border-color .12s;
}
.daybox.sel span { background: var(--hs-on); color: #fff; border-color: var(--hs-on); }
.tip {
  position: fixed; z-index: 60; pointer-events: none; white-space: pre-line;
  background: var(--primary-text-color); color: var(--primary-background-color);
  padding: 7px 11px; border-radius: 7px; font-size: 12px; line-height: 1.5;
  font-variant-numeric: tabular-nums; max-width: 260px;
  transform: translate(-50%, -100%); box-shadow: 0 4px 16px rgba(0,0,0,.35);
}
.tip[hidden] { display: none; }
.toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  background: var(--primary-text-color); color: var(--primary-background-color);
  padding: 10px 20px; border-radius: 8px; font-size: 14px; z-index: 40;
}
@media (max-width: 600px) {
  /* Header: the title takes a row of its own and the buttons share the next one,
     rather than every label wrapping inside a squeezed column. */
  header.bar { flex-wrap: wrap; gap: 8px; }
  header.bar .htitle { flex: 1 1 100%; }
  header.bar button { white-space: nowrap; }
  .btn-primary { padding: 8px 16px; }
  /* An on/off row is start, arrow, end, length and the delete button — all of it fits
     across a phone, so nothing here may claim a line of its own. */
  .wrow { gap: 6px; flex-wrap: nowrap; }
  /* On the narrowest phones the chip is the only item that can give ground. */
  .wrow .chip { white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .tsel { padding: 2px 4px; }
  .tsel select { padding: 7px 3px; }
  .dialog { max-height: 100vh; border-radius: 0; }
  .overlay { padding: 0; }
}
`;

/* -------------------------------------------------------------- the element */

class HaSchedulerPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._loaded = false;
    this._model = { v: 1, rules: [] };
    this._schedules = {};   // schedule_id -> stored config
    this._registry = { entities: [], areas: {}, devices: {} };
    this._engineOk = null;
    this._isAdmin = true;     // set from hass.user.is_admin on first load
    this._canEdit = true;     // admin, or the helper integration is available
    this._viaService = false; // non-admin writing through ha_scheduler.*
    this._cardConfig = {};
    this._dialog = null;    // editing draft, or null
    this._sig = "";
    this._toast = "";
    this._tick = null;
  }

  connectedCallback() {
    this.shadowRoot.innerHTML = "<style>" + STYLES + "</style><div id='root'></div>";
    this._root = this.shadowRoot.getElementById("root");
    this._tick = setInterval(() => { if (!this._dialog) this._render(); }, 30000);
    this._onKeyDown = (e) => {
      if (e.key === "Escape" && this._dialog) { e.stopPropagation(); this._tryCancel(); }
    };
    document.addEventListener("keydown", this._onKeyDown);
  }

  disconnectedCallback() {
    clearInterval(this._tick);
    document.removeEventListener("keydown", this._onKeyDown);
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    // Keep native <select> dropdowns in sync with HA's active colour scheme so the
    // OS-rendered popup (which ignores CSS colour) uses the right background/text.
    const isDark = !!(hass.themes && hass.themes.darkMode);
    this.style.setProperty("--hs-color-scheme", isDark ? "dark" : "light");
    this.style.setProperty("--hs-input-color", isDark ? "#f0f0f0" : "#111111");
    if (first) { this._load(); return; }
    const sig = this._signature();
    if (sig !== this._sig) { this._sig = sig; if (!this._dialog) this._render(); }
  }
  get hass() { return this._hass; }

  setConfig(config) { this._cardConfig = config || {}; }
  getCardSize() { return 20; }

  /** Only the states this panel actually draws, so unrelated churn is ignored. */
  _signature() {
    const h = this._hass;
    if (!h) return "";
    const ids = [];
    for (const r of this._model.rules || []) {
      if (r.schedule) ids.push(r.schedule);
      for (const t of r.targets || []) ids.push(t);
    }
    ids.push("automation." + ENGINE_ID);
    return ids.map((id) => {
      const s = h.states[id];
      return id + "=" + (s ? s.state + "|" + (s.attributes.next_event || "") : "-");
    }).join(",");
  }

  /* ---------------------------------------------------------- solar helpers */

  /** Minutes past midnight for a solar side {sun, offset} using today's sun.sun data.
   *  Returns null if sun.sun is unavailable or its attributes haven't loaded yet. */
  _solarMin(v) {
    const sun = this._hass && this._hass.states["sun.sun"];
    if (!sun) return null;
    const attr = v.sun === "sunrise" ? "next_rising" : "next_setting";
    const raw = sun.attributes[attr];
    if (!raw) return null;
    const dt = new Date(raw);
    const now = new Date();
    // next_rising/next_setting is the *next* occurrence. If it's tomorrow, subtract
    // a day to get today's value; if it's today (sun hasn't risen/set yet), use as-is.
    if (dt.toDateString() !== now.toDateString()) dt.setDate(dt.getDate() - 1);
    return dt.getHours() * 60 + dt.getMinutes() + (v.offset || 0);
  }

  /** Today's clock time ("HH:MM") for a solar event ("sunrise"/"sunset"), no offset
   *  applied, or null when sun.sun is unavailable. */
  _solarClock(sunKey) {
    const sun = this._hass && this._hass.states["sun.sun"];
    if (!sun) return null;
    const raw = sun.attributes[sunKey === "sunrise" ? "next_rising" : "next_setting"];
    if (!raw) return null;
    const dt = new Date(raw);
    const now = new Date();
    // next_rising/next_setting is the next occurrence; if it's tomorrow, step back to today's.
    if (dt.toDateString() !== now.toDateString()) dt.setDate(dt.getDate() - 1);
    return String(dt.getHours()).padStart(2, "0") + ":" + String(dt.getMinutes()).padStart(2, "0");
  }

  /** Render a solar side value as an HTML string. The event word ("Sunrise"/"Sunset")
   *  gets a dotted underline and the panel's styled tooltip showing the actual solar
   *  time today (no offset applied). Any offset suffix ("+30m") is rendered outside it. */
  _solarSpan(v) {
    if (!isSolar(v)) return sideLabel(v);
    const eventName = v.sun === "sunrise" ? "Sunrise" : "Sunset";
    const offsetStr = !v.offset ? "" : (v.offset > 0 ? "+" : "") + v.offset + "m";
    const hhmm = this._solarClock(v.sun);
    if (!hhmm) return eventName + offsetStr;
    const tip = eventName + " today " + hhmm;
    return "<span data-tip='" + esc(tip) + "' style='text-decoration:underline dotted;cursor:help'>" +
      eventName + "</span>" + offsetStr;
  }

  /** Replace solar side objects in a windows array with their computed integer minutes
   *  (or null if unresolvable), so pure geometry helpers can operate on them. */
  _resolveSolar(windows) {
    return (windows || []).map((w) => {
      const s = isSolar(w.s) ? this._solarMin(w.s) : w.s;
      const e = isSolar(w.e) ? this._solarMin(w.e) : w.e;
      return { ...w, s, e };
    });
  }

  /* ---------------------------------------------------------------- loading */

  async _load() {
    const h = this._hass;
    this._isAdmin = !!(h.user && h.user.is_admin);
    // A non-admin can still write if the companion integration is installed.
    this._viaService = !this._isAdmin && !!(h.services && h.services[SVC] && h.services[SVC].save_rule);
    this._canEdit = this._isAdmin || this._viaService;
    try {
      const [scheds, ents, areas, devs] = await Promise.all([
        h.callWS({ type: "schedule/list" }),
        h.callWS({ type: "config/entity_registry/list" }),
        h.callWS({ type: "config/area_registry/list" }),
        h.callWS({ type: "config/device_registry/list" }),
      ]);
      this._schedules = {};
      for (const s of scheds) this._schedules[s.id] = s;
      this._registry.entities = ents;
      this._registry.areas = {};
      for (const a of areas) this._registry.areas[a.area_id] = a.name;
      this._registry.devices = {};
      for (const d of devs) this._registry.devices[d.id] = d.area_id;

      let cfg = null;
      if (this._isAdmin) {
        try {
          cfg = await h.callApi("GET", "config/automation/config/" + ENGINE_ID);
        } catch (e) { cfg = null; }
      }
      if (cfg && cfg.variables && cfg.variables.hs_cfg) {
        this._model = cfg.variables.hs_cfg;
        this._engineOk = true;
      } else if (!this._isAdmin) {
        // HA answers 401 here for non-admins, which is not the same as the engine
        // being absent — so read the mirror and never show the "missing" banner.
        this._model = await this._loadMirror();
        this._engineOk = null;
      } else {
        this._engineOk = false;
      }
      if (!Array.isArray(this._model.rules)) this._model.rules = [];
      delete this._model.step;   // legacy granularity field; minutes are all selectable now
      // The helper only ever holds merged, non-overlapping blocks, so re-reading it
      // unconditionally would flatten deliberate overlaps. Keep the authored windows
      // when they still describe what the helper holds, and fall back to the helper
      // only when someone has edited it outside this panel.
      for (const r of this._model.rules) {
        const sid = (r.schedule || "").split(".")[1];
        const stored = this._schedules[sid];
        if (!stored) continue;
        // A weekday-restricted rule's Monday blocks need not equal its full windows
        // (Monday may be inactive, or hold only a wrap tail), so don't reconcile from
        // them — the model's windows + days are the source of truth.
        if (Array.isArray(r.days) && r.days.length && r.days.length < 7) continue;
        const authored = JSON.stringify(windowsToBlocks(r.windows || []));
        const held = JSON.stringify((stored.monday || []).map((b) => ({ from: b.from, to: b.to })));
        if (!r.windows || !r.windows.length || authored !== held) {
          r.windows = blocksToWindows(stored.monday);
        }
      }
    } catch (e) {
      this._error = String((e && e.message) || e);
    }
    this._loaded = true;
    this._sig = this._signature();
    this._render();
    if (this._isAdmin && this._model.rules.length) this._saveMirror();
  }

  /** Read-only copy of the model, for users HA refuses /api/config/* to. */
  async _loadMirror() {
    try {
      const cfg = await this._hass.callWS({ type: "lovelace/config", url_path: MIRROR_PATH });
      const card = cfg && cfg.views && cfg.views[0] && cfg.views[0].cards && cfg.views[0].cards[0];
      if (card && card.model && Array.isArray(card.model.rules)) return card.model;
    } catch (e) { /* no mirror yet */ }
    return { v: 1, rules: [] };
  }

  /** Publish the model where non-admins can reach it. Never blocks a real save. */
  async _saveMirror() {
    const config = { views: [{ title: "data", cards: [{
      type: "markdown",
      content: "Read-only mirror of the Schedules panel model, written automatically " +
               "so non-admin users can view schedules. Home Assistant refuses " +
               "`/api/config/*` to non-admins, which is where the real model lives. " +
               "Do not edit by hand.",
      model: this._model,
    }] }] };
    const save = () =>
      this._hass.callWS({ type: "lovelace/config/save", url_path: MIRROR_PATH, config });
    try {
      await save();
    } catch (e) {
      // On a fresh install the dashboard does not exist yet, and saving a config to an
      // unknown url_path fails. Create it once, hidden from the sidebar, then retry.
      try {
        await this._hass.callWS({
          type: "lovelace/dashboards/create", url_path: MIRROR_PATH,
          title: "Schedules (data)", icon: "mdi:database",
          show_in_sidebar: false, require_admin: false,
        });
        await save();
      } catch (e2) { /* a stale mirror is not worth failing a save over */ }
    }
  }

  /* ----------------------------------------------------------------- saving */

  async _persist(msg) {
    const h = this._hass;
    if (!this._isAdmin) {
      // The integration rebuilds and commits the engine itself; there is nothing for
      // a non-admin to POST. Callers that changed only `enabled` route here.
      if (msg) this._flash(msg);
      return;
    }
    const engine = buildEngine(this._model);
    await h.callApi("POST", "config/automation/config/" + ENGINE_ID, engine);
    await h.callService("automation", "reload", {});
    this._engineOk = true;
    // Apply current schedule state right away so a new rule takes effect now
    // instead of at its next edge.
    await new Promise((r) => setTimeout(r, 600));
    try { await h.callApi("POST", "events/" + APPLY_EVENT, {}); } catch (e) {}
    this._saveMirror();
    if (msg) this._flash(msg);
  }

  /** Re-assert every scheduled device to what its schedule says for right now.
   *  This is the engine's own boot sweep, fired on demand — nothing is written and
   *  no schedule changes, so it is safe to press at any time. Devices already in the
   *  right state are left alone, as are unavailable ones. */
  async _restore() {
    const h = this._hass;
    const engine = h.states["automation." + ENGINE_ID];
    if (engine && engine.state === "off") {
      this._flash("The scheduling engine is turned off, so nothing can be restored.");
      return;
    }
    const n = this._mismatched().length;
    try {
      if (h.services && h.services[SVC] && h.services[SVC].apply) {
        await h.callService(SVC, "apply", {});
      } else {
        await h.callApi("POST", "events/" + APPLY_EVENT, {});
      }
    } catch (e) {
      const text = String((e && (e.message || e.body || e.error)) || e);
      this._flash(/unauthoriz|not authorized|401|403/i.test(text)
        ? "Home Assistant refused that. Restoring needs an administrator, or the " +
          "HA Scheduler integration installed."
        : "Could not restore: " + text);
      return;
    }
    this._flash(!n
      ? "Everything already matches its schedule"
      : "Restoring " + n + (n === 1 ? " device" : " devices") + " to " +
        (n === 1 ? "its schedule" : "their schedules") + "…");
  }

  /** Turn HA's auth failures into something a person can act on. */
  _writeError(e) {
    const text = String((e && (e.message || e.body || e.error)) || e);
    if (/unauthoriz|not authorized|401|403/i.test(text)) {
      return "Home Assistant refused that change. Schedules can only be edited by an " +
             "administrator, or with the HA Scheduler integration installed.";
    }
    return "Could not save: " + text;
  }

  _flash(msg) {
    this._toast = msg;
    this._render();
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { this._toast = ""; this._render(); }, 2600);
  }

  /* ----------------------------------------------------------- entity lists */

  _areaOf(entityId) {
    const reg = this._registry.entities.find((e) => e.entity_id === entityId);
    if (!reg) return "";
    if (reg.area_id) return this._registry.areas[reg.area_id] || "";
    if (reg.device_id) {
      const aid = this._registry.devices[reg.device_id];
      if (aid) return this._registry.areas[aid] || "";
    }
    return "";
  }

  _candidates() {
    const h = this._hass;
    const hidden = new Set(
      this._registry.entities.filter((e) => e.hidden_by || e.disabled_by).map((e) => e.entity_id)
    );
    const out = [];
    for (const id of Object.keys(h.states)) {
      const dom = id.split(".")[0];
      if (SCHEDULABLE.indexOf(dom) < 0) continue;
      if (hidden.has(id)) continue;
      if (id === "automation." + ENGINE_ID) continue;
      out.push({
        id,
        dom,
        name: (h.states[id].attributes.friendly_name || id.split(".")[1]).toString(),
        area: this._areaOf(id) || "No area",
        state: h.states[id].state,
      });
    }
    out.sort((a, b) => (a.area + a.name).localeCompare(b.area + b.name));
    return out;
  }

  _ownerOf(entityId, exceptRuleId) {
    for (const r of this._model.rules) {
      if (r.id === exceptRuleId) continue;
      if ((r.targets || []).indexOf(entityId) >= 0) return r;
    }
    return null;
  }

  /* --------------------------------------------------------------- rendering */

  _render() {
    if (!this._loaded) {
      this._root.innerHTML = "<div class='empty'><h2>Loading…</h2></div>";
      return;
    }
    const parts = [this._renderHeader()];
    parts.push("<div class='wrap'><div class='inner'>");
    if (this._error) {
      parts.push("<div class='banner'><span>Could not read Home Assistant: " + esc(this._error) + "</span></div>");
    }
    if (this._isAdmin && this._model.rules.length && this._engineOk === false) {
      parts.push(
        "<div class='banner'><span>The scheduling engine automation is missing. Nothing will switch until it is rebuilt.</span>" +
        "<button data-act='repair'>Rebuild</button></div>"
      );
    }
    const engineEnt = this._hass.states["automation." + ENGINE_ID];
    if (engineEnt && engineEnt.state === "off") {
      parts.push(
        "<div class='banner'><span>The scheduling engine is turned off, so schedules are not running.</span>" +
        "<button data-act='enable-engine'>Turn on</button></div>"
      );
    }
    if (!this._canEdit) {
      parts.push("<div class='banner info'><span>You can see every schedule here, but " +
        "Home Assistant only lets administrators change them.</span></div>");
    }
    if (!this._model.rules.length) parts.push(this._renderEmpty());
    else parts.push(this._model.rules.map((r) => this._renderRule(r)).join(""));
    parts.push("</div></div>");
    if (this._dialog) parts.push(this._renderDialog());
    if (this._toast) parts.push("<div class='toast'>" + esc(this._toast) + "</div>");
    parts.push("<div class='tip' hidden></div>");

    this._root.innerHTML = parts.join("");
    this._bind();
  }

  _renderHeader() {
    const rules = this._model.rules || [];
    const active = rules.filter((r) => r.enabled !== false).length;
    const off = this._mismatched().length;
    let sub;
    if (!rules.length) sub = "Nothing scheduled yet";
    else {
      const next = this._nextChangeText();
      sub = active + " active · " + (rules.length - active) + " paused" + (next ? " · " + next : "");
    }
    return (
      "<header class='bar'><div class='htitle'><h1>Schedules</h1><div class='sub'>" + esc(sub) +
        (this._canEdit ? "" : " · read-only") + "</div></div>" +
      (rules.length && this._canApply()
        ? "<button class='btn-primary on-header quiet' data-act='restore' title='Set every " +
            "scheduled device to whatever its schedule says it should be right now'>" +
            this._svg(ICON_RESTORE) + "Restore now" +
            (off ? "<span class='hbadge'>" + off + "</span>" : "") + "</button>"
        : "") +
      (this._canEdit
        ? "<button class='btn-primary on-header' data-act='new'>" +
            this._svg("M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z") + "New schedule</button>"
        : "<span class='pill'>View only</span>") +
      "</header>"
    );
  }

  /** Scheduled devices whose live state disagrees with their schedule right now —
   *  i.e. exactly what a restore would switch. Same test the engine applies, so the
   *  count never promises a change the sweep will not make. */
  _mismatched() {
    const h = this._hass;
    const out = [];
    for (const r of this._model.rules || []) {
      if (r.enabled === false || !r.schedule) continue;
      const sched = h.states[r.schedule];
      if (!sched || ["on", "off"].indexOf(sched.state) < 0) continue;
      for (const id of r.targets || []) {
        const st = h.states[id];
        if (!st || ["on", "off"].indexOf(st.state) < 0) continue;
        if (st.state !== sched.state) out.push({ id, rule: r, want: sched.state });
      }
    }
    return out;
  }

  /** Admins can POST the apply event; everyone else needs the integration's service.
   *  Derived rather than cached so it follows a hass update. */
  _canApply() {
    if (this._isAdmin) return true;
    const h = this._hass;
    return !!(h && h.services && h.services[SVC] && h.services[SVC].apply);
  }

  _nextChangeText() {
    let best = null;
    for (const r of this._model.rules) {
      if (r.enabled === false || !r.schedule) continue;
      const st = this._hass.states[r.schedule];
      if (!st || !st.attributes.next_event) continue;
      const t = new Date(st.attributes.next_event).getTime();
      if (!best || t < best.t) best = { t, r, turningOn: st.state === "off" };
    }
    if (!best) return "";
    const mins = Math.max(0, Math.round((best.t - Date.now()) / 60000));
    return best.r.name + " turns " + (best.turningOn ? "on" : "off") + " in " + dur(mins);
  }

  _renderEmpty() {
    return (
      "<div class='empty'>" +
      "<svg viewBox='0 0 24 24'><path d='" + ICON_CLOCK + "'/></svg>" +
      "<h2>No schedules yet</h2>" +
      (this._canEdit
        ? "<p>Pick a device and give it on and off times.<br>They repeat daily — or on chosen weekdays — and survive restarts.</p>" +
          "<button class='btn-primary' data-act='new'>Create the first schedule</button>"
        : "<p>An administrator has not set any up yet.</p>") + "</div>"
    );
  }

  _renderRule(r) {
    const h = this._hass;
    const windows = r.windows || [];
    const sched = h.states[r.schedule];
    const paused = r.enabled === false;
    const shouldBe = sched ? sched.state : "unknown";

    const now = new Date();
    const targets = (r.targets || []).map((id) => ({
      id, st: h.states[id], name: h.states[id] ? (h.states[id].attributes.friendly_name || id) : id,
    }));
    const live = targets.filter((t) => t.st && t.st.state === "on").length;
    const dead = targets.filter((t) => !t.st || t.st.state === "unavailable" || t.st.state === "unknown").length;
    const oneWay = hasEdges(windows);
    const solar = hasSolarWindows(windows);
    // Event-driven rules (one-way or solar) report live device state for the pill.
    const eventDriven = oneWay || solar;
    const lit = !paused && (eventDriven ? live > 0 : shouldBe === "on");

    // Ribbon: resolve solar sides to today's computed minutes for geometry.
    const resolved = this._resolveSolar(windows);
    const segs = this._ribbonSegs(resolved) + this._ribbonEdges(resolved);
    const nowPct = toVisualPct(now.getHours() * 60 + now.getMinutes());

    const chips = windows.length
      ? windows.map((w) => {
          if (isEdge(w)) {
            const on = w.e === null || w.e === undefined;
            return "<span class='chip'>" + (on ? "Turns on at " + this._solarSpan(w.s) : "Turns off at " + this._solarSpan(w.e)) +
              "<span class='len'>one way</span></span>";
          }
          // Compute display duration using resolved (integer) values when possible.
          const rs = isSolar(w.s) ? this._solarMin(w.s) : w.s;
          const re = isSolar(w.e) ? this._solarMin(w.e) : w.e;
          const hasDur = rs !== null && re !== null;
          const full = hasDur && winLength({ s: rs, e: re }) >= 1440;
          const label = isSolar(w.s) || isSolar(w.e)
            ? this._solarSpan(w.s) + " → " + this._solarSpan(w.e)
            : (full ? "All day" : toHHMM(w.s) + " → " + toHHMM(w.e));
          const lenStr = full ? "24h" : hasDur ? dur(winLength({ s: rs, e: re })) : "~varies";
          return "<span class='chip'>" + label + "<span class='len'>" + lenStr + "</span></span>";
        }).join("")
      : "<span class='chip'>No times set</span>";

    let foot;
    if (paused) foot = "Paused — this schedule is not switching anything.";
    else if (solar) {
      foot = "Solar schedule — fires at sunrise/sunset each day";
      // Show next solar moment if computable.
      const nowMin = now.getHours() * 60 + now.getMinutes();
      let best = null;
      for (const w of windows) {
        for (const [side, action] of [["s", "on"], ["e", "off"]]) {
          const v = w[side];
          if (!isSolar(v)) continue;
          const at = this._solarMin(v);
          if (at === null) continue;
          const mins = (at - nowMin + 1440) % 1440;
          if (!best || mins < best.mins) best = { v, action, at, mins };
        }
      }
      if (best) foot += " · turns " + best.action + " at " + this._solarSpan(best.v) + " in " + dur(best.mins);
    }
    else if (oneWay) {
      const nxt = nextEdge(windows, now.getHours() * 60 + now.getMinutes());
      foot = "Switches one way only" +
        (nxt ? " · turns " + nxt.action + " at " + toHHMM(nxt.at) + " in " + dur(nxt.mins) : "") +
        " · left alone in between";
    }
    else if (!sched) foot = "Waiting for the schedule helper…";
    else {
      const nextAt = sched.attributes.next_event;
      const mins = nextAt ? Math.max(0, Math.round((new Date(nextAt).getTime() - Date.now()) / 60000)) : null;
      foot = "Should be " + shouldBe.toUpperCase() +
        (mins != null ? " · turns " + (shouldBe === "on" ? "off" : "on") + " in " + dur(mins) : " · no upcoming change");
      const mismatch = targets.filter((t) => t.st && ["on", "off"].indexOf(t.st.state) >= 0 && t.st.state !== shouldBe);
      if (mismatch.length)
        foot += " · " + mismatch.length + " manually overridden — Restore now puts " +
                (mismatch.length === 1 ? "it" : "them") + " back";
    }

    const names = targets.map((t) => t.name).join(", ");
    // A rule is nearly always named after the one device it switches, so the second
    // line just repeats the title. Keep it only when it adds something.
    // Spacing and case are ignored, so "Sound Power Amplifier" and "SoundPower
    // Amplifier" count as the same name.
    const sameText = (a, b) =>
      String(a || "").toLowerCase().replace(/\s+/g, "") === String(b || "").toLowerCase().replace(/\s+/g, "");
    const metaBits = [];
    const dl = daysLabel(r.days);
    if (dl) metaBits.push(dl);
    if (!names) metaBits.push("no devices");
    else if (!sameText(names, r.name)) metaBits.push(names);
    if (dead) metaBits.push(dead + " unavailable");

    return (
      "<div class='card" + (paused ? " paused" : "") + "'>" +
        "<div class='card-head'>" +
          "<div class='titles'><div class='name'>" + esc(r.name) + "</div>" +
            (metaBits.length ? "<div class='meta'>" + esc(metaBits.join(" · ")) + "</div>" : "") +
          "</div>" +
          "<span class='pill " + (paused ? "" : lit ? "on" : "") + "'>" +
            (paused ? "Paused" : eventDriven ? (live > 0 ? "On" : "Off") : shouldBe === "on" ? "On" : "Off") + "</span>" +
          (dead ? "<span class='pill warn'>" + dead + " offline</span>" : "") +
          (this._canEdit
            ? "<button class='icon-btn' data-act='edit' data-id='" + esc(r.id) + "' title='Edit'>" +
                this._svg("M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z") + "</button>" +
              "<button class='icon-btn' data-act='toggle' data-id='" + esc(r.id) + "' title='" + (paused ? "Resume" : "Pause") + "'>" +
                this._svg(paused ? "M8,5.14V19.14L19,12.14L8,5.14Z" : "M14,19H18V5H14M6,19H10V5H6V19Z") + "</button>"
            : "") +
        "</div>" +
        "<div class='ribbon'>" +
          "<div class='ticks'><span>12</span><span>15</span><span>18</span><span>21</span><span>0</span><span>3</span><span>6</span><span>9</span><span>12</span></div>" +
          "<div class='track'>" + segs + "<div class='now' style='left:" + nowPct + "%'></div></div>" +
        "</div>" +
        "<div class='chips'>" + chips + "</div>" +
        "<div class='foot'>" + foot + "</div>" +
      "</div>"
    );
  }

  _svg(path) { return "<svg class='i' viewBox='0 0 24 24'><path d='" + path + "'/></svg>"; }

  /** Ribbon fill. Deeper blue where entries overlap; nothing is merged away.
   *  Each slice carries the on/off times of the entries covering it, shown on hover. */
  _ribbonSegs(windows) {
    return depthSegments(windows).map((sg) => {
      const lines = sg.wins.map((i) => {
        const w = windows[i];
        if (winLength(w) >= 1440) return "All day";
        return toHHMM(w.s) + " → " + toHHMM(w.e) + "  (" + dur(winLength(w)) + ")";
      });
      if (sg.depth > 1) lines.unshift(sg.depth + " overlapping entries:");
      const cls = "seg" + (sg.depth > 1 ? " d" + Math.min(sg.depth, 3) : "");
      const tip = esc(lines.join("\n"));
      // Midnight is the bar's centre, so a slice that crosses noon is drawn as its two
      // halves, one against each edge.
      return visualRects(sg.a, sg.b).map((r) =>
        "<div class='" + cls + "' data-tip='" + tip + "'" +
        " style='left:" + (r[0] / 14.4) + "%;width:" + ((r[1] - r[0]) / 14.4) + "%'></div>").join("");
    }).join("");
  }

  /** One-way entries have no width to fill, so each is drawn as a line at its moment
   *  with a short fade running the way it acts: rightwards from a turn-on (on from
   *  here, nothing claimed afterwards) and leftwards into a turn-off. */
  _ribbonEdges(windows) {
    const out = [];
    for (const w of windows || []) {
      if (!isEdge(w)) continue;
      const on = w.e === null || w.e === undefined;
      const at = on ? w.s : w.e;
      const pct = toVisualPct(at);
      const width = 10;   // percent of the day, purely a visual hint
      const left = on ? pct : Math.max(0, pct - width);
      out.push("<div class='edge " + (on ? "on" : "off") + "' style='left:" + left + "%;width:" +
        Math.min(width, on ? 100 - pct : pct) + "%'></div>" +
        "<div class='edge-line' style='left:" + pct + "%' data-tip='" +
        esc((on ? "Turns on at " : "Turns off at ") + toHHMM(at) +
            "\nNothing is asserted the rest of the day") + "'></div>");
    }
    return out.join("");
  }

  /** Position the shared tooltip over a ribbon slice.
   *  `position: fixed` keeps it out of the track's `overflow: hidden`. */
  _showTip(el) {
    const tip = this._root.querySelector(".tip");
    if (!tip || !el.dataset.tip) return;
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    const x = Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8);
    tip.style.left = x + "px";
    tip.style.top = (r.top - 8) + "px";
  }

  _hideTip() {
    const tip = this._root.querySelector(".tip");
    if (tip) tip.hidden = true;
  }

  /* ----------------------------------------------------------------- dialog */

  _renderDialog() {
    const d = this._dialog;
    const confirmScrim = d._confirming ? (
      "<div class='confirm-scrim'>" +
        "<div class='confirm-box'>" +
          "<p>Discard unsaved changes?</p>" +
          "<div class='cbtns'>" +
            "<button class='btn-ghost danger' data-act='confirm-discard'>Discard</button>" +
            "<button class='btn-primary' data-act='confirm-keep'>Keep editing</button>" +
          "</div>" +
        "</div>" +
      "</div>"
    ) : "";
    // Which device a schedule drives is fixed at creation, so the picker lives only in
    // the New dialog; editing shows the device read-only and is purely about times.
    // To point a schedule somewhere else, delete it and create a new one.
    // Editing shows times only: the dialog title already names the schedule, and the
    // device cannot be changed here anyway.
    const deviceBlock = d.isNew ? this._devicePicker(d) : "";

    const real = d.windows.filter((w) => !w.draft);
    const pending = d.windows.length - real.length;
    const hasSolar = hasSolarWindows(real);

    // Ribbon uses resolved solar minutes for geometry.
    const resolvedReal = this._resolveSolar(real);
    const segs = this._ribbonSegs(resolvedReal) + this._ribbonEdges(resolvedReal);
    const overlapped = maxDepth(resolvedReal) > 1;

    const DEL_ICON = "M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z";
    const rows = d.windows.map((w, i) => {
      if (w.draft) {
        return "<div class='wrow'>" +
          this._timeSel(i, "s", w.s, true) +
          "<span class='arrow'>→</span>" +
          this._timeSel(i, "e", w.e, true) +
          "<span class='chip draft'>set a start and end</span>" +
          "<span class='wlen'>—</span>" +
          "<button class='icon-btn' data-act='delwin' data-i='" + i + "' title='Remove'>" +
          this._svg(DEL_ICON) + "</button></div>";
      }
      const edge = isEdge(w);
      const solarW = isSolar(w.s) || isSolar(w.e);
      // Compute length using resolved integers where possible.
      const rs = isSolar(w.s) ? this._solarMin(w.s) : w.s;
      const re = isSolar(w.e) ? this._solarMin(w.e) : w.e;
      const hasDur = !edge && rs !== null && re !== null;
      const full = hasDur && winLength({ s: rs, e: re }) >= 1440;
      if (full && !solarW) {
        return "<div class='wrow'><span class='chip'>All day — always on</span>" +
          "<span class='wlen'>24h</span>" +
          "<button class='icon-btn' data-act='delwin' data-i='" + i + "' title='Remove'>" +
          this._svg(DEL_ICON) + "</button></div>";
      }
      // canUnset: whether "-- (one-way)" is available for each side.
      // A solar value is non-null so canUnset is true when the other side is set (any type).
      const sSet = w.s !== null && w.s !== undefined;
      const eSet = w.e !== null && w.e !== undefined;
      const wlenStr = edge || (!hasDur) ? "—" : full ? "24h" : dur(winLength({ s: rs, e: re }));
      let chip = "";
      if (edge) chip = "<span class='chip oneway'>" + (w.s === null ? "off only" : "on only") + "</span>";
      else if (solarW) chip = "<span class='chip oneway' style='background:var(--warning-color,#ffa600);color:#000'>☀ solar</span>";
      else if (re !== null && rs !== null && re <= rs) chip = "<span class='chip'>next day</span>";
      return "<div class='wrow'>" +
        this._timeSel(i, "s", w.s, eSet) +
        "<span class='arrow'>→</span>" +
        this._timeSel(i, "e", w.e, sSet) +
        chip +
        "<span class='wlen'>" + wlenStr + "</span>" +
        "<button class='icon-btn' data-act='delwin' data-i='" + i + "' title='Remove'>" +
        this._svg(DEL_ICON) + "</button></div>";
    }).join("");

    const on = totalOnMinutes(intervalsOf(real));
    // Specific-weekdays on with nothing ticked would mean "never", so block saving then.
    const daysOk = !d.daysOn || (d.days && d.days.length > 0);
    const canSave = d.targets.length > 0 && real.length > 0 && pending === 0 &&
                    d.name.trim().length > 0 && daysOk;

    return (
      "<div class='overlay' data-act='backdrop'><div class='dialog' data-stop='1'>" +
      "<h2>" + (d.isNew ? "New schedule" : esc(d.name) || "Edit schedule") + "</h2>" +
      "<div class='body'>" +
        deviceBlock +

        "<div class='section'>On times</div>" +
        "<div class='ribbon'>" +
          "<div class='ticks'><span>12</span><span>15</span><span>18</span><span>21</span><span>0</span><span>3</span><span>6</span><span>9</span><span>12</span></div>" +
          "<div class='track tall'>" + segs + "</div>" +
        "</div>" +
        rows +
        "<button class='btn-ghost' data-act='addwin' style='margin-top:8px" +
          (pending ? ";opacity:.4;cursor:not-allowed" : "") + "'" + (pending ? " disabled" : "") +
          ">+ Add another on/off time</button>" +
        this._weekdayRow(d) +
        "<p class='hint'>" + (on ? "On for " + dur(on) + " a day (fixed windows only). " : "") +
          "An end time earlier than the start crosses midnight — that is allowed. " +
          "Click the ☀ icon next to any time to switch it to Sunrise or Sunset ± offset in minutes.</p>" +
        "<p class='hint'>Set a time to <b>--</b> (one-way): the device is only turned on or off " +
          "at that moment and left alone the rest of the time.</p>" +
        (hasSolar ? "<p class='hint note'>This schedule uses sunrise/sunset times. State is restored on restart.</p>" : "") +
        (pending ? "<p class='hint note'>Give the new entry a start and end time before saving.</p>" : "") +
        (overlapped ? "<p class='hint note'>Darker blue marks where entries overlap. The device simply stays on across both.</p>" : "") +
        "<div style='height:12px'></div>" +
      "</div>" +
      "<div class='foot-bar'>" +
        (d.isNew ? "" : "<button class='btn-ghost danger' data-act='delete'>Delete</button>") +
        "<span class='spacer'></span>" +
        "<button class='btn-ghost' data-act='cancel'>Cancel</button>" +
        "<button class='btn-primary' data-act='save'" + (canSave ? "" : " disabled style='opacity:.4;cursor:not-allowed'") + ">Save</button>" +
      "</div>" +
      confirmScrim +
      "</div></div>"
    );
  }

  /** The Specific-weekdays toggle and, when it is on, the seven day chips — one line
   *  under the on-times section. Toggle off (the default) means the rule runs every day. */
  _weekdayRow(d) {
    const on = !!d.daysOn;
    const sel = new Set((d.days || []).map(Number));
    const toggle =
      "<label class='hs-switch'><input type='checkbox' data-act='days-toggle'" + (on ? " checked" : "") +
      "><span class='sw'></span></label>" +
      "<span class='wdlabel'>Specific weekdays</span>";
    let boxes = "";
    if (on) {
      boxes = "<div class='wdays'>" + DAY_ABBR.map((lab, i) =>
        "<label class='daybox" + (sel.has(i) ? " sel" : "") + "' title='" + esc(lab) + "'>" +
          "<input type='checkbox' data-act='day-check' data-day='" + i + "'" + (sel.has(i) ? " checked" : "") + ">" +
          "<span>" + lab[0] + "</span></label>").join("") + "</div>";
    }
    const warn = on && sel.size === 0
      ? "<p class='hint note'>Pick at least one weekday, or turn the toggle off for every day.</p>"
      : "";
    return "<div class='wdrow'>" + toggle + boxes + "</div>" + warn;
  }

  /** New-schedule only: the name field and the searchable multi-select device picker. */
  _devicePicker(d) {
    const q = (d.q || "").toLowerCase();
    const cands = this._candidates().filter((c) =>
      !q || c.name.toLowerCase().indexOf(q) >= 0 || c.id.toLowerCase().indexOf(q) >= 0 ||
      c.area.toLowerCase().indexOf(q) >= 0);

    let picker = "", lastArea = null;
    for (const c of cands) {
      if (c.area !== lastArea) { picker += "<div class='grp'>" + esc(c.area) + "</div>"; lastArea = c.area; }
      const on = d.targets.indexOf(c.id) >= 0;
      const owner = this._ownerOf(c.id, d.id);
      picker +=
        "<label class='opt'><input type='checkbox' data-act='pick' data-id='" + esc(c.id) + "'" + (on ? " checked" : "") + ">" +
        "<span class='l'><b>" + esc(c.name) + "</b><small>" + esc(c.id) + " · " + esc(c.state) + "</small></span>" +
        (owner ? "<span class='taken'>in “" + esc(owner.name) + "”</span>" : "") + "</label>";
    }
    if (!cands.length) picker = "<div style='padding:16px;color:var(--secondary-text-color)'>Nothing matches.</div>";

    const chips = d.targets.map((id) => {
      const st = this._hass.states[id];
      return "<span class='chip'>" + esc(st ? st.attributes.friendly_name || id : id) +
        "<button data-act='unpick' data-id='" + esc(id) + "' title='Remove'>" +
        this._svg("M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z") +
        "</button></span>";
    }).join("");

    return "<div class='section'>Name</div>" +
      "<input class='search' data-act='name' value='" + esc(d.name) + "' placeholder='e.g. Gate light overnight'>" +
      "<div class='section'>Devices — " + d.targets.length + " selected</div>" +
      (chips ? "<div class='selected-chips'>" + chips + "</div>" : "") +
      "<input class='search' style='margin-top:10px' data-act='search' value='" + esc(d.q || "") +
      "' placeholder='Search devices, rooms…'>" +
      "<div class='picker'>" + picker + "</div>";
  }

  /** Renders a time selector for one window side.
   *  `value` may be: integer (fixed minutes), null (one-way / unset), or {sun, offset} (solar).
   *  `canUnset` controls whether the "--" (one-way) option is shown.
   *  Always appends a ☀/🕐 toggle button that switches between clock and solar modes. */
  _timeSel(i, which, value, canUnset) {
    if (isSolar(value)) {
      // Solar mode: show event selector + offset input + clock toggle.
      const v = value;
      const offset = v.offset || 0;
      // Tooltips with today's actual sunrise/sunset times: on each option, and on the
      // select itself (so the selected value shows its time on hover). The dialog does
      // not re-render on a timer, so a native title tooltip is stable here.
      const sr = this._solarClock("sunrise");
      const ss = this._solarClock("sunset");
      const srTip = sr ? "Sunrise today " + sr : "Sunrise time unavailable";
      const ssTip = ss ? "Sunset today " + ss : "Sunset time unavailable";
      const selTip = v.sun === "sunrise" ? srTip : ssTip;
      return (
        "<span class='tsel solar-tsel'>" +
          "<select data-act='solar-event' data-i='" + i + "' data-w='" + which + "' title='" + esc(selTip) + "'>" +
            "<option value='sunrise'" + (v.sun === "sunrise" ? " selected" : "") + " title='" + esc(srTip) + "'>Sunrise</option>" +
            "<option value='sunset'"  + (v.sun === "sunset"  ? " selected" : "") + " title='" + esc(ssTip) + "'>Sunset</option>" +
          "</select>" +
          "<input class='solar-offset' type='number' data-act='solar-offset' data-i='" + i + "' data-w='" + which + "'" +
            " value='" + offset + "' min='-480' max='480'>" +
          "<span class='solar-unit'>min</span>" +
        "</span>" +
        "<button class='icon-btn solar-mode-btn' data-act='solar-toggle' data-i='" + i + "' data-w='" + which + "'" +
          " title='Switch to clock time'>" + this._svg(ICON_CLOCK_SM) + "</button>"
      );
    }

    // Clock mode (fixed minutes or null/unset).
    const unset = value === null || value === undefined;
    const hh = unset ? -1 : Math.floor(value / 60);
    const mm = unset ? -1 : value % 60;
    let hopt = "<option value=''" + (unset ? " selected" : "") +
      (canUnset || unset ? "" : " disabled") + ">--</option>";
    for (let h = 0; h < 24; h++)
      hopt += "<option value='" + h + "'" + (h === hh ? " selected" : "") + ">" + String(h).padStart(2, "0") + "</option>";
    let mopt = "";
    if (unset) mopt = "<option value='' selected>--</option>";
    else for (let m = 0; m < 60; m++)
      mopt += "<option value='" + m + "'" + (m === mm ? " selected" : "") + ">" + String(m).padStart(2, "0") + "</option>";
    return (
      "<span class='tsel" + (unset ? " unset" : "") + "'>" +
        "<select data-act='time' data-i='" + i + "' data-w='" + which + "' data-p='h'>" + hopt + "</select>" +
        "<span class='colon'>:</span>" +
        "<select data-act='time' data-i='" + i + "' data-w='" + which + "' data-p='m'" +
          (unset ? " disabled" : "") + ">" + mopt + "</select>" +
      "</span>" +
      "<button class='icon-btn solar-mode-btn' data-act='solar-toggle' data-i='" + i + "' data-w='" + which + "'" +
        " title='Switch to sunrise/sunset'>" + this._svg(ICON_SUN) + "</button>"
    );
  }

  /* ------------------------------------------------------------------ events */

  _bind() {
    const r = this._root;
    r.querySelectorAll("[data-tip]").forEach((el) => {
      el.addEventListener("pointerenter", () => this._showTip(el));
      el.addEventListener("pointerleave", () => this._hideTip());
      el.addEventListener("click", () => this._showTip(el));   // tap, on touch
    });
    r.querySelectorAll("[data-act]").forEach((el) => {
      const act = el.dataset.act;
      if (act === "name" || act === "search") {
        el.addEventListener("input", (e) => this._onInput(act, e.target.value, e.target));
      } else if (act === "solar-offset") {
        // Update model on input without re-rendering (avoids focus loss while typing).
        el.addEventListener("input", (e) => this._onSolarOffset(el, e.target.value));
        // Re-render on blur/change so the row reflects the finalised value.
        el.addEventListener("change", () => this._render());
      } else if (act === "time" || act === "pick" || act === "solar-event" ||
                 act === "days-toggle" || act === "day-check") {
        el.addEventListener("change", (e) => this._onChange(act, el, e));
      } else {
        el.addEventListener("click", (e) => this._onClick(act, el, e));
      }
    });
  }

  _onInput(act, value, el) {
    if (!this._dialog) return;
    if (act === "name") { this._dialog.name = value; this._softRefreshSave(); return; }
    if (act === "search") {
      this._dialog.q = value;
      const pos = el.selectionStart;
      this._render();
      const again = this._root.querySelector("[data-act='search']");
      if (again) { again.focus(); again.setSelectionRange(pos, pos); }
    }
  }

  _onSolarOffset(el, raw) {
    if (!this._dialog) return;
    const i = parseInt(el.dataset.i, 10);
    const side = el.dataset.w;
    const w = this._dialog.windows[i];
    if (!isSolar(w[side])) return;
    const n = parseInt(raw, 10);
    if (!isNaN(n)) w[side] = { ...w[side], offset: Math.max(-480, Math.min(480, n)) };
  }

  /** Save button is the only thing name-typing affects; avoid a full re-render. */
  _softRefreshSave() {
    const d = this._dialog;
    const btn = this._root.querySelector("[data-act='save']");
    if (!btn) return;
    const daysOk = !d.daysOn || (d.days && d.days.length > 0);
    const ok = d.targets.length > 0 && d.windows.length > 0 && d.name.trim().length > 0 && daysOk;
    btn.disabled = !ok;
    btn.style.opacity = ok ? "" : ".4";
    btn.style.cursor = ok ? "" : "not-allowed";
  }

  _onChange(act, el, ev) {
    const d = this._dialog;
    if (!d) return;
    if (act === "days-toggle") {
      d.daysOn = el.checked;
      // First time it is switched on, start from every day ticked — the user then
      // unticks the days they don't want. Toggle off is left meaning "every day".
      if (d.daysOn && (!d.days || !d.days.length)) d.days = [0, 1, 2, 3, 4, 5, 6];
      this._render();
      return;
    }
    if (act === "day-check") {
      const i = parseInt(el.dataset.day, 10);
      d.days = d.days || [];
      const at = d.days.indexOf(i);
      if (el.checked && at < 0) d.days.push(i);
      if (!el.checked && at >= 0) d.days.splice(at, 1);
      d.days.sort((a, b) => a - b);
      this._render();
      return;
    }
    if (act === "solar-event") {
      const i = parseInt(el.dataset.i, 10);
      const side = el.dataset.w;
      const w = d.windows[i];
      if (isSolar(w[side])) w[side] = { ...w[side], sun: el.value };
      this._render();
      return;
    }
    if (act === "pick") {
      const id = el.dataset.id;
      const at = d.targets.indexOf(id);
      if (el.checked && at < 0) d.targets.push(id);
      if (!el.checked && at >= 0) d.targets.splice(at, 1);
      this._render();
      return;
    }
    if (act === "time") {
      const i = parseInt(el.dataset.i, 10);
      const w = d.windows[i];
      const which = el.dataset.w;
      const other = which === "s" ? "e" : "s";
      if (el.value === "") {
        // "--": this side stops being a time, which turns the entry into a one-way
        // switch. Both sides unset would say nothing at all, so that is refused.
        if (w[other] === null || w[other] === undefined) {
          this._flash("One of the two times has to be set.");
          this._render();
          return;
        }
        w[which] = null;
        delete w.draft;
        this._render();
        return;
      }
      const cur = w[which] === null || w[which] === undefined ? 0 : w[which];
      const v = parseInt(el.value, 10);
      w[which] = el.dataset.p === "h" ? clampDay(v * 60 + (cur % 60)) : clampDay(Math.floor(cur / 60) * 60 + v);
      if (w.draft) {
        if (w.s === w.e) { this._render(); return; }   // still unset, still excluded
        delete w.draft;
      } else if (w.s !== null && w.e !== null && w.s === w.e) {
        // Zero-length is meaningless; nudge the end forward instead of erroring.
        w.e = clampDay(w.e + 1);
      }
      // No merge and no reorder: rows stay exactly where the user put them, so the
      // select they are working in never jumps out from under them.
      this._render();
    }
  }

  /** Everything the user can change, as a stable string — the baseline for the
   *  unsaved-changes guard. Includes the weekday restriction. */
  _snap(d) {
    return JSON.stringify({
      name: d.name, targets: d.targets, windows: d.windows,
      daysOn: !!d.daysOn, days: (d.days || []).slice().sort((a, b) => a - b),
    });
  }

  /** The weekday restriction to persist: an array of 0-6, or null for every day
   *  (toggle off, or on with nothing / everything ticked). */
  _dialogDays(d) {
    if (!d.daysOn) return null;
    const s = Array.from(new Set((d.days || []).map(Number))).filter((n) => n >= 0 && n <= 6).sort((a, b) => a - b);
    if (!s.length || s.length >= 7) return null;
    return s;
  }

  _dialogDirty() {
    const d = this._dialog;
    if (!d || !d._orig) return false;
    return this._snap(d) !== d._orig;
  }

  _tryCancel() {
    if (!this._dialogDirty()) { this._dialog = null; this._render(); return; }
    this._dialog._confirming = true;
    this._render();
  }

  async _onClick(act, el, ev) {
    const d = this._dialog;
    if (!this._canEdit && ["new", "edit", "toggle", "repair", "enable-engine"].indexOf(act) >= 0) return;
    if (act === "restore" && !this._canApply()) return;
    switch (act) {
      case "backdrop":
        return; // clicking outside the dialog does nothing; use Save or Cancel
      case "new": {
        const nd = {
          id: "r" + Date.now().toString(36), isNew: true, q: "",
          name: "", targets: [], windows: [{ s: 1200, e: 300 }],
          daysOn: false, days: [0, 1, 2, 3, 4, 5, 6],
        };
        nd._orig = this._snap(nd);
        this._dialog = nd;
        this._render();
        return;
      }
      case "edit": {
        const rule = this._model.rules.find((x) => x.id === el.dataset.id);
        if (!rule) return;
        const restricted = Array.isArray(rule.days) && rule.days.length > 0 && rule.days.length < 7;
        const ed = {
          id: rule.id, isNew: false, q: "",
          name: rule.name,
          targets: (rule.targets || []).slice(),
          windows: (rule.windows || []).map((w) => ({ s: w.s, e: w.e })),
          daysOn: restricted,
          days: restricted ? rule.days.slice().sort((a, b) => a - b) : [0, 1, 2, 3, 4, 5, 6],
        };
        ed._orig = this._snap(ed);
        this._dialog = ed;
        this._render();
        return;
      }
      case "cancel":
        this._tryCancel();
        return;
      case "confirm-discard":
        this._dialog = null; this._render();
        return;
      case "confirm-keep":
        this._dialog._confirming = false; this._render();
        return;
      case "unpick": {
        const at = d.targets.indexOf(el.dataset.id);
        if (at >= 0) d.targets.splice(at, 1);
        this._render();
        return;
      }
      case "solar-toggle": {
        const i = parseInt(el.dataset.i, 10);
        const side = el.dataset.w;
        const w = d.windows[i];
        if (isSolar(w[side])) {
          // Solar → clock: pick a sensible default. Preserve draft flag if set.
          w[side] = side === "s" ? 360 : 1200;  // 06:00 or 20:00
        } else {
          // Clock (or null) → solar: default event differs per side.
          w[side] = { sun: side === "s" ? "sunrise" : "sunset", offset: 0 };
          delete w.draft;
        }
        this._render();
        return;
      }
      case "addwin": {
        // Deliberately unset rather than auto-placed: an added row must never merge
        // into an existing window before the user has said what they want.
        if (el.disabled) return;
        d.windows = d.windows.concat([{ s: 0, e: 0, draft: true }]);
        this._render();
        return;
      }
      case "delwin":
        d.windows.splice(parseInt(el.dataset.i, 10), 1);
        this._render();
        return;
      case "save":
        if (el.disabled) return;
        await this._save();
        return;
      case "delete":
        await this._delete();
        return;
      case "toggle": {
        const rule = this._model.rules.find((x) => x.id === el.dataset.id);
        const next = rule.enabled === false;
        if (this._viaService) {
          try {
            await this._hass.callService(SVC, "set_enabled", { rule_id: rule.id, enabled: next });
          } catch (e) { this._flash(this._writeError(e)); return; }
          await this._load();
          this._flash(next ? "Resumed" : "Paused");
          return;
        }
        rule.enabled = next;
        this._render();
        await this._persist(next ? "Resumed" : "Paused");
        return;
      }
      case "restore":
        await this._restore();
        return;
      case "repair":
        await this._persist("Engine rebuilt");
        return;
      case "enable-engine":
        await this._hass.callService("automation", "turn_on", { entity_id: "automation." + ENGINE_ID });
        this._flash("Engine turned on");
        return;
    }
  }

  /* ----------------------------------------------------------- persist a rule */

  async _save() {
    const d = this._dialog;
    const h = this._hass;
    const windows = d.windows.filter((w) => !w.draft);
    const daySet = this._dialogDays(d);          // array of 0-6, or null for every day
    const days = daysBlocks(windows, daySet);    // per-weekday helper blocks
    // Rules with one-way (null) sides or any solar time cannot use a schedule helper.
    // Schedule helpers only understand fixed HH:MM times.
    const noHelper = hasEdges(windows) || hasSolarWindows(windows);

    let rule = this._model.rules.find((x) => x.id === d.id);
    const icon = "mdi:calendar-clock";

    if (this._viaService) {
      // One call does the lot: helper CRUD, engine rebuild, reload, apply, mirror.
      try {
        await h.callService(SVC, "save_rule", {
          rule_id: d.id, name: d.name.trim(), targets: d.targets.slice(),
          windows: windows.map((w) => ({ s: w.s, e: w.e })), enabled: rule ? rule.enabled !== false : true,
          days: daySet,
        });
      } catch (e) {
        this._flash(this._writeError(e));
        return;
      }
      this._dialog = null;
      await this._load();          // re-read from the mirror the service just wrote
      this._flash("Saved");
      return;
    }

    try {
      if (noHelper) {
        if (rule && rule.schedule) {
          // Switched from a fixed schedule to no-helper: drop the schedule helper.
          try { await h.callWS({ type: "schedule/delete", schedule_id: rule.schedule.split(".")[1] }); }
          catch (e) { /* already gone */ }
          rule.schedule = null;
        }
        if (!rule) {
          rule = { id: d.id, name: d.name.trim(), schedule: null, targets: [], windows: [], enabled: true };
          this._model.rules.push(rule);
        }
      } else if (!rule || !rule.schedule) {
        const created = await h.callWS(Object.assign({ type: "schedule/create", name: d.name.trim(), icon }, days));
        if (rule) rule.schedule = "schedule." + created.id;
        else {
          rule = { id: d.id, name: d.name.trim(), schedule: "schedule." + created.id, targets: [], windows: [], enabled: true };
          this._model.rules.push(rule);
        }
      } else {
        await h.callWS(Object.assign(
          { type: "schedule/update", schedule_id: rule.schedule.split(".")[1], name: d.name.trim(), icon }, days));
      }
    } catch (e) {
      this._flash(this._writeError(e));
      return;
    }
    rule.name = d.name.trim();
    rule.targets = d.targets.slice();
    rule.windows = windows;
    // Only keep `days` when actually restricted, so an every-day rule round-trips
    // byte-identical to how older versions wrote it.
    if (daySet) rule.days = daySet; else delete rule.days;
    // One device belongs to exactly one rule, so the engine map is never ambiguous.
    for (const other of this._model.rules) {
      if (other.id === rule.id) continue;
      other.targets = (other.targets || []).filter((t) => rule.targets.indexOf(t) < 0);
    }
    this._dialog = null;
    this._render();
    try {
      await this._persist("Saved");
    } catch (e) {
      this._flash("Saved times, but the engine did not update: " + ((e && e.message) || e));
    }
    this._sig = this._signature();
  }

  async _delete() {
    const d = this._dialog;
    const rule = this._model.rules.find((x) => x.id === d.id);
    if (!rule) { this._dialog = null; this._render(); return; }
    if (this._viaService) {
      try {
        await this._hass.callService(SVC, "delete_rule", { rule_id: rule.id });
      } catch (e) { this._flash(this._writeError(e)); return; }
      this._dialog = null;
      await this._load();
      this._flash("Deleted");
      return;
    }
    if (rule.schedule) {
      try { await this._hass.callWS({ type: "schedule/delete", schedule_id: rule.schedule.split(".")[1] }); }
      catch (e) {}
    }
    this._model.rules = this._model.rules.filter((x) => x.id !== rule.id);
    this._dialog = null;
    this._render();
    // Devices are deliberately left in whatever state they are in.
    await this._persist("Deleted");
  }
}

customElements.define("ha-scheduler-panel", HaSchedulerPanel);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "ha-scheduler-panel",
  name: "HA Scheduler",
  description: "Full-screen daily on/off scheduling for any switchable entity.",
});

console.info("%c HA-SCHEDULER %c v1.4.2 ", "background:#03a9f4;color:#fff;border-radius:3px 0 0 3px",
  "background:#555;color:#fff;border-radius:0 3px 3px 0");
