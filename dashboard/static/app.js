/* global echarts */
"use strict";

const DB_OFFSET = 106.6;  // calibration: dB SPL ≈ dBFS + offset (phone SPL meter, 27.09.)
const THRESH_LOUD = 62;   // dB SPL: green audible up to here
const THRESH_VERY = 67;   // dB SPL: yellow loud up to here, red very loud above
const state = { dataMin: null, groupMembers: {}, weekdayPayload: null, weekdayFetchedAt: 0,
                loudDb: -45 };
const hourCols = () => Array.from({ length: 24 }, (_, i) => i);

/* group raw AudioSet classes into city-relevant families (prefix match on
   word boundaries; order matters — first hit wins) */
const GROUP_RULES = [
  { name: "Other", keys: ["siren", "horn", "honk", "toot", "beep", "bell", "chime", "gong", "toll"] },
  { name: "Other", keys: ["train", "rail", "tram", "subway", "metro", "locomotive"] },
  { name: "Other", keys: ["aircraft", "airplane", "helicopter", "jet", "propeller"] },
  { name: "Other", keys: ["music", "singing", "choir", "guitar", "piano", "organ", "drum", "violin", "cello", "orchestra", "flute", "trumpet", "trombone", "brass", "woodwind", "saxophone", "clarinet", "harp", "banjo", "mandolin", "marimba", "xylophone", "percussion", "timpani", "instrument", "opera", "techno", "jazz", "reggae"] },
  { name: "Motor", keys: ["motor vehicle", "motorcycle", "car", "truck", "bus", "vehicle", "engine", "idling", "skidding", "accelerating", "revving", "vroom", "traffic", "tire", "brake", "driv"] },
  { name: "Human", keys: ["speech", "conversation", "voice", "whisper", "shout", "yell", "scream", "cry", "sob", "whimper", "sigh", "gasp", "snor", "breath", "cough", "sneeze", "hiccup", "chatter", "crowd", "laugh", "giggle", "baby", "child", "kid", "talk", "man", "woman", "male", "female", "human"] },
  { name: "Human", keys: ["bird", "pigeon", "dove", "crow", "caw", "coo", "chirp", "tweet", "owl", "hoot", "gull", "raven", "magpie", "wings", "duck", "goose", "animal", "cat", "meow", "purr", "caterwaul", "dog", "bark", "yip", "howl", "growl", "pets", "rodent", "insect", "bee", "wasp", "fly", "cricket", "frog", "snake", "fox", "horse", "livestock", "farm"] },
  { name: "Other", keys: ["door", "slam", "glass", "tap", "knock", "clink", "chink", "thump", "thud", "crash", "splash", "camera", "mechanism", "switch", "button"] },
  { name: "Background", keys: ["silence", "noise", "static", "rumble", "hum", "buzz", "field recording", "environmental", "vibration", "whoosh", "swoosh", "swish", "wind"] },
];
const RULE_RES = GROUP_RULES.map(g => ({
  name: g.name,
  res: g.keys.map(k => new RegExp("\\b" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))),
}));
function groupOf(cls) {
  const c = cls.toLowerCase();
  for (const g of RULE_RES) {
    if (g.res.some(re => re.test(c))) return g.name;
  }
  return "Other";
}
const charts = {};
const PALETTE = [
  "#0969da", "#cf222e", "#1a7f37", "#9a6700", "#8250df", "#bf3989",
  "#0550ae", "#1b7c83", "#bc4c00", "#57606a", "#116329", "#a40e26",
  "#218bff", "#db61a2", "#6e7681", "#298e46", "#aa4700", "#6639ba",
];
const classColor = new Map();
function colorFor(cls) {
  if (!classColor.has(cls)) {
    classColor.set(cls, PALETTE[classColor.size % PALETTE.length]);
  }
  return classColor.get(cls);
}

function hexWithAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function mkChart(id) {
  if (!charts[id]) charts[id] = echarts.init(document.getElementById(id), null, { renderer: "canvas" });
  return charts[id];
}

async function get(path, params) {
  const qs = params ? "?" + new URLSearchParams(params) : "";
  const r = await fetch(path + qs);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

function dayParams() {
  // calendar day: today 00:00 → 24:00 local time
  const midnight = new Date().setHours(0, 0, 0, 0) / 1000;
  return { from: midnight, to: midnight + 86400 };
}

function allParams() {
  const to = Date.now() / 1000;
  return { from: state.dataMin ?? to - 86400, to };
}

const TIME_OPTS = { hour12: false };
const fmtTime = t => new Date(t).toLocaleTimeString([], TIME_OPTS);
const fmtDate = t => {
  const d = new Date(t);
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
};

/* ------------------------------------------------------------------ live */

async function loadLive() {
  const d = await get("/api/live", { secs: 300 });

  // logarithmic loudness axis: plot log(dB + 61) so −60→0, −25→log36
  const LOG_OFF = 61;
  const toLog = v => Math.log(Math.max(v + LOG_OFF, 0.5));
  const dB_TICKS = [-60, -55, -50, -45, -40, -35, -30, -25];

  // pills show the most specific type identified (no grouping);
  // Background-group episodes (noise-floor labels) are not shown
  const pills = d.events
    .filter(e => e.spl != null && !EXCLUDED_GROUPS.has(groupOf(e.event)))
    .map(e => {
      return {
        value: [toLog(e.spl), e.t * 1000],
        event: e.event,
        conf: e.confidence,
        label: {
          formatter: e.event,
          color: "#ffffff",
          backgroundColor: "#24292f",
        },
      };
    });

  mkChart("live").setOption({
    animation: false,
    silent: true,
    grid: { left: 86, right: 20, top: 48, bottom: 16 },
    xAxis: {
      type: "value", min: 0, max: Math.log(36), position: "top", name: "dB",
      nameLocation: "middle", nameGap: 28,
      axisLabel: { show: false }, axisTick: { show: false },
      splitLine: { show: false },
    },
    yAxis: { type: "time" },  // vertical time axis: oldest bottom, newest top
    series: [
      { name: "max", type: "line", showSymbol: false,
        lineStyle: { width: 2, color: "#24292f" }, itemStyle: { color: "#24292f" },
        data: d.t.map((t, i) => [toLog(d.max[i]), t * 1000]),
        markLine: {
          silent: true, symbol: "none", animation: false,
          lineStyle: { color: "#d0d7de", width: 1 },
          label: { color: "#57606a", fontSize: 11, position: "end", distance: 6 },
          data: dB_TICKS.map(v => ({ xAxis: toLog(v),
            label: { formatter: String(Math.round(v + DB_OFFSET)) } })),
        },
        markArea: {
          silent: true, animation: false,
          data: [
            [{ xAxis: toLog(-60), itemStyle: { color: "rgba(26,127,55,0.07)" } },
             { xAxis: toLog(-45) }],
            [{ xAxis: toLog(-45), itemStyle: { color: "rgba(245,159,0,0.09)" } },
             { xAxis: toLog(-40) }],
            [{ xAxis: toLog(-40), itemStyle: { color: "rgba(207,34,46,0.07)" } },
             { xAxis: toLog(-25) }],
          ],
        } },
      { name: "event", type: "scatter", z: 12, symbolSize: 0.01, data: pills,
        label: {
          show: true, position: "right", distance: 4,
          fontSize: 14, borderRadius: 9, padding: [3, 8],
        } },
    ],
  });
}

/* ---------------------------------------------------------------- events */

const EXCLUDED_GROUPS = new Set(["Background"]);  // hidden from all views

async function loadCounts() {
  const p = allParams();  // whole recording period
  const d = await get("/api/counts", p);

  // aggregate raw classes into groups
  const groups = new Map();  // name -> {count, members: []}
  d.classes.forEach((c, i) => {
    const g = groupOf(c);
    if (!groups.has(g)) groups.set(g, { count: 0, members: [] });
    const e = groups.get(g);
    e.count += d.counts[i];
    e.members.push(c);
  });
  const allNames = [...groups.keys()].sort((a, b) => groups.get(b).count - groups.get(a).count);
  state.groupMembers = Object.fromEntries(allNames.map(n => [n, groups.get(n).members]));
  const names = allNames.filter(n => !EXCLUDED_GROUPS.has(n));

  return names;
}

async function loadClassDist() {
  const to = Date.now() / 1000;
  const d = await get("/api/classdist", { from: to - 21 * 86400, to });
  // rows: [event, bucket(dBFS), night, day] → pool all noise types;
  // 1-dB rows from 47 up to 75 dB, everything louder pooled into ">75 dB"
  const rowsDbfs = Array.from({ length: -32 - (-60) + 1 }, (_, i) => -60 + i);
  const rowLabels = rowsDbfs.map(b => String(Math.round(b + DB_OFFSET)) + " dB");
  const OVERFLOW = -31;              // pseudo bucket: buckets ≥ -31 → ">75 dB"
  rowLabels.push(">75 dB");
  const byBucket = new Map();
  for (const [ev, b, night, day] of d.rows) {
    if (EXCLUDED_GROUPS.has(groupOf(ev))) continue;
    const cur = byBucket.get(b) || [0, 0];
    cur[0] += night; cur[1] += day;
    byBucket.set(b, cur);
  }
  const data = [];
  let maxN = 1;
  const pushRow = (b, yi, night, day) => {
    maxN = Math.max(maxN, night + day);
    // stacked: violet night below, green day on top; 7th slot = bucket dBFS
    data.push([0, yi, night, day, "#6b21a8", "#1a7f37", b]);
  };
  rowsDbfs.forEach((b, yi) => {
    const [night, day] = byBucket.get(b) ?? [0, 0];
    pushRow(b, yi, night, day);
  });
  let ovNight = 0, ovDay = 0;
  for (const [b, [night, day]] of byBucket) {
    if (b >= OVERFLOW) { ovNight += night; ovDay += day; }
  }
  pushRow(OVERFLOW, rowsDbfs.length, ovNight, ovDay);
  const el = document.getElementById("classdist");
  el.style.height = `${rowsDbfs.length * 18 + 50}px`;
  const chart = mkChart("classdist");
  chart.setOption({
    animation: false,
    grid: { left: 48, right: 16, top: 16, bottom: 28 },
    tooltip: { formatter: p =>
      `${rowLabels[p.value[1]]}<br>` +
      `<b>${p.value[2] + p.value[3]}</b> events · ${p.value[2]} night / ${p.value[3]} day` },
    xAxis: { type: "category", data: ["All events"],
             axisLabel: { color: "#57606a" } },
    yAxis: { type: "category", data: rowLabels,
             axisLabel: { color: "#57606a", fontSize: 10 } },
    series: [{ type: "custom", encode: { x: 0, y: 1 }, data,
               renderItem: fillCellsRender(maxN, true, "loudness-bands") }],
  });
  chart.resize();
}

async function loadEventsView() {
  await loadClassDist();
}

async function loadThreed() {
  await loadDist3D();
}

const WDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function loadLoudList() {
  const to = Date.now() / 1000;
  await loadCounts();  // fills state.groupMembers
  const members = (state.groupMembers.Motor || []).join(";");
  // every vehicle episode of the last 7 days whose peak reached 62 dB SPL
  const d = await get("/api/loudest", {
    from: to - 7 * 86400, to, event: members,
    min_db: (62 - DB_OFFSET).toFixed(1), limit: 20000,
  });
  document.querySelector("#view-loudest h2").textContent =
    `${d.rows.length} Loudest vehicles (7d)`;
  document.getElementById("loud-body").innerHTML = d.rows.length
    ? d.rows.map(r => {
        const dt = new Date(r[0] * 1000);
        const h24 = dt.getHours();
        const night = h24 >= 22 || h24 <= 6;  // 22:00–06:59
        const h = String(h24).padStart(2, "0") + "h";
        const dbBg = r[3] >= -40 ? "#ffebe9" : r[3] >= -45 ? "#fff3bf" : "#e7f0fe";
        const timeBg = night ? "#f3e8ff" : "#e3f7e8";
        return `<tr${night ? ' class="night"' : ""}>` +
               `<td style="background:${dbBg}">${(r[3] + DB_OFFSET).toFixed(1)}</td>` +
               `<td>${r[1]}</td>` +
               `<td>${WDAYS[dt.getDay()]}</td>` +
               `<td style="background:${timeBg}">${h}</td>` +
               `<td>${fmtDate(r[0] * 1000)}</td></tr>`;
      }).join("")
    : "<tr><td colspan='5'>none yet — no vehicle episodes recorded</td></tr>";
}

const dist3dState = { data: [], info: new Map(), zMin: 40, zMax: 80 };

function hexToRgb(hex) {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}

async function loadDist3D() {
  const to = Date.now() / 1000;
  const d = await get("/api/weekcounts",
    { from: to - 7 * 86400, to, hourly: 1, min_db: state.loudDb });

  // aggregate [weekday, hour, class, count, avgSpl, maxSpl, duration] → cloud
  const groups = new Map();
  const cells = new Map();   // "group|wd|hour" -> {n, splSum, max, dur}
  for (const [wd, h, cls, n, avg, max, dur, loud] of d.rows) {
    const g = groupOf(cls);
    if (EXCLUDED_GROUPS.has(g)) continue;
    groups.set(g, (groups.get(g) || 0) + n);
    const key = `${g}|${wd}|${h}`;
    const cur = cells.get(key) || { n: 0, splSum: 0, max: -999, dur: 0 };
    cur.n += n;
    cur.splSum += (avg || 0) * n;      // weighted average across classes
    cur.max = Math.max(cur.max, max || -999);
    cur.dur += dur || 0;
    cells.set(key, cur);
  }
  // each weekday occurs exactly once in a 7-day window → its date is unique
  const dayDate = new Map();
  for (let i = 0; i < 7; i++) {
    const dte = new Date((to - i * 86400) * 1000);
    dayDate.set((dte.getDay() + 6) % 7, dte);
  }
  const names = [...groups.keys()].sort((a, b) => groups.get(b) - groups.get(a));
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const info = new Map();
  const data = [];
  const zHours = hourCols();
  let zMin = Infinity, zMax = -Infinity;
  const now = new Date();
  const nowWd = (now.getDay() + 6) % 7, nowH = now.getHours();
  for (const [key, entry] of cells) {
    const [g, wd, h] = key.split("|");
    const x = +h;                                         // always 00-24
    const y = (Number(wd) + 6) % 7;
    const z = entry.splSum / entry.n + DB_OFFSET;         // avg loudness (dB SPL)
    zMin = Math.min(zMin, z);
    zMax = Math.max(zMax, z);
    // loudness color code; quiet dots are violet at night (22-07)
    const color = z >= 67 ? "#cf222e"
                : z >= 62 ? "#f59f00"
                : (h >= 22 || h <= 6) ? "#8b5cf6" : "#1a7f37";
    const isNow = Number(wd) === nowWd && Number(h) === nowH;
    data.push({
      value: [x, y, z, entry.n],
      symbolSize: 2 + Math.sqrt(entry.n) * 2.5,
      isNow, baseSize: 2 + Math.sqrt(entry.n) * 2.5,
      itemStyle: { color, opacity: 0.85 },
    });
    info.set(`${x}|${y}|${z}`, [g, wd, h, entry.max, entry.dur, entry.n]);
  }
  dist3dState.data = data;
  dist3dState.info = info;
  dist3dState.zMin = zMin;
  dist3dState.zMax = zMax;
  dist3dState.days = days;
  dist3dState.hours = zHours.map(h => String(h).padStart(2, "0"));
  dist3dState.dayDate = dayDate;
  dist3dState.nowWd = nowWd;
  dist3dState.nowH = nowH;
  applyDist3D();
}

function applyDist3D() {
  const { data, info, zMin, zMax, days, hours, dayDate } = dist3dState;
  const styled = data.map(dot => dot.isNow
    ? { ...dot, symbolSize: dot.baseSize * 1.8,
        itemStyle: { color: dot.itemStyle.color, opacity: 1 } }
    : dot);
  // black path through the dots of the current weekday at the current hour
  const nowLine = data
    .filter(dot => dot.value[0] === dist3dState.nowH &&
                   dot.value[1] === dist3dState.nowWd)
    .sort((a, b) => a.value[2] - b.value[2])
    .map(dot => dot.value.slice(0, 3));
  mkChart("dist3d").setOption({
    animation: false,
    tooltip: {
      formatter: p => {
        const [g, wd, h, peak, dur, total] = info.get(`${p.value[0]}|${p.value[1]}|${p.value[2]}`) || ["?", 0, 0, 0, 0, 0];
        const dte = dayDate.get((Number(wd) + 6) % 7);
        const ds = fmtDate(dte.getTime());
        const hh = String(h).padStart(2, "0");
        return `${ds} ${hh}:00 · ${g}<br>` +
               `peak ${(+peak).toFixed(1)} dB · ${Math.round(dur)} s total`;
      },
    },
    xAxis3D: { type: "value", min: -0.5, max: 23.5, name: "hour",
               axisLabel: { formatter: v => v + "h",
                            textStyle: { color: "#57606a", fontSize: 10 } } },
    yAxis3D: { type: "category", data: days, name: "weekday",
               axisLabel: { textStyle: { color: "#57606a", fontSize: 10 } } },
    zAxis3D: { type: "value",
               min: Math.floor(Number.isFinite(zMin) ? zMin : 40),
               max: Math.ceil(Number.isFinite(zMax) ? zMax : 80),
               name: "dB",
               axisLabel: { formatter: v => Math.round(v),
                            textStyle: { color: "#57606a", fontSize: 10 } } },
    grid3D: {
      boxWidth: 140, boxDepth: 90, boxHeight: 180,
      viewControl: { distance: 280, alpha: 20, beta: 40 },
      axisLine: { lineStyle: { color: "#d0d7de" } },
      axisLabel: { textStyle: { color: "#57606a" } },
      splitLine: { lineStyle: { color: "#eaeef2" } },
      light: { main: { intensity: 1.2 }, ambient: { intensity: 0.4 } },
    },
    series: [
      { type: "scatter3D", data: styled,
        emphasis: { itemStyle: { opacity: 1 } } },
      { type: "line3D", data: nowLine, silent: true,
        lineStyle: { color: "#24292f", width: 2, opacity: 0.9 } },
    ],
  }, { notMerge: true });
}

function hexToRgb(hex) {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}
const VIOLET_STOPS = ["#f6effc", "#d8b4fe", "#a855f7", "#6b21a8"].map(hexToRgb);
const GREEN_STOPS = ["#e3f7e8", "#8ce99a", "#2f9e44", "#1a7f37"].map(hexToRgb);

function disposeChartsIn(container) {
  container.querySelectorAll(".chart").forEach(el => {
    const inst = echarts.getInstanceByDom(el);
    if (inst) inst.dispose();
    delete charts[el.id];
  });
}

let weekdayCycleTimer = null;

function stopWeekdayCycle() {
  if (weekdayCycleTimer) { clearInterval(weekdayCycleTimer); weekdayCycleTimer = null; }
}

// noise-load grid: cell color = accumulated episodes x loudness over the
// last 3 weeks; violet scale for night columns (22-06), green for day (07-22)
function fillCellsRender(maxN, showText = true, bg = null, hourList = null) {
  // bg "hours-violet": night columns 22-06 light violet, day 07-22 light green
  // Loudness data [x, y, night, day, violet, green]:
  //   stacked violet night below + green day on top; buckets < 62 dB show
  //   the day and night counts as two separate green/violet numbers
  return (params, api) => {
    const [cx, cy] = api.coord([api.value(0), api.value(1)]);
    const w = api.size([1, 0])[0];
    const h = api.size([0, 1])[1];
    const x = cx - w / 2, y = cy - h / 2;
    const v0 = api.value(0);
    const v2 = api.value(2);
    const v3 = api.value(3);
    const v4 = api.value(4);
    const v5 = api.value(5);
    const v6 = api.value(6);
    const g = 1; // gap between cells
    let bgFill = "#eaeef2";
    if (bg === "hours-violet") {
      const hr = hourList ? hourList[v0] : v0;
      if (hr !== undefined && (hr >= 22 || hr <= 6)) bgFill = "#f3e8ff";
      else bgFill = "#e3f7e8";   // 07-22: light green
    } else if (bg === "loudness-bands") {
      // same tints as the Last-5-min strip: green audible, yellow loud, red very loud
      const spl = (typeof v6 === "number" ? v6 : -60 + v0) + DB_OFFSET;
      bgFill = spl < 62 ? "rgba(26,127,55,0.07)"
             : spl < 67 ? "rgba(245,159,0,0.09)"
             : "rgba(207,34,46,0.07)";
    }
    const children = [{
      type: "rect", z2: 1,
      shape: { x, y: y + g, width: w - g, height: h - g },
      style: {
        fill: bg === "none" ? "#ffffff" : bgFill,
        stroke: "#d0d7de", lineWidth: 1,
      },
    }];
    const unit = h - 2 * g;
    if (typeof v4 === "string" && typeof v5 === "string") {
      // Loudness: horizontal bar filled left to right — violet night
      // segment first, green day segment after it
      const unitW = w - 2 * g;
      const nightW = unitW * (v2 / maxN);
      const dayW = unitW * (v3 / maxN);
      if (nightW > 0.5) {
        children.push({
          type: "rect", z2: 2,
          shape: { x: x + g, y: y + g, width: nightW, height: h - 2 * g },
          style: { fill: v4 },
        });
      }
      if (dayW > 0.5) {
        children.push({
          type: "rect", z2: 2,
          shape: { x: x + g + nightW, y: y + g, width: dayW, height: h - 2 * g },
          style: { fill: v5 },
        });
      }
      // buckets below 62 dB SPL: two numbers (green day, violet night);
      // bucket dBFS rides in the 7th slot when the axis is flipped.
      // numbers sit right of the bar end (white when clamped onto the bar)
      const splBucket = (typeof v6 === "number" ? v6 : -60 + v0) + DB_OFFSET;
      const p = t => String(Math.round(t));
      const barEnd = x + g + nightW + dayW;
      const tx = Math.min(barEnd + 6, x + w - 12);
      const txtFill = tx < barEnd + 2 ? "#ffffff" : "#24292f";
      if (showText && v2 + v3 > 0 && splBucket < 62) {
        children.push({
          type: "text", z2: 4, silent: true,
          style: { text: p(v3), x: tx, y: cy - 7,
                   fill: tx < barEnd + 2 ? "#ffffff" : "#1a7f37",
                   font: "10px sans-serif", align: "left" },
        });
        children.push({
          type: "text", z2: 4, silent: true,
          style: { text: p(v2), x: tx, y: cy + 7,
                   fill: tx < barEnd + 2 ? "#ffffff" : "#6b21a8",
                   font: "10px sans-serif", align: "left" },
        });
      } else if (showText && v2 + v3 > 0) {
        children.push({
          type: "text", z2: 4, silent: true,
          style: {
            text: String(v2 + v3), x: tx, y: cy, fill: txtFill,
            font: "11px sans-serif", align: "left", verticalAlign: "middle",
          },
        });
      }
    } else if (typeof v3 === "number" && typeof v4 === "number" && typeof v5 === "number") {
      // three-band stack: green audible base, yellow loud middle, red very-loud top
      const bH = unit * (v3 / maxN);
      const yH = unit * (v4 / maxN);
      const rH = unit * (v5 / maxN);
      // any non-zero band gets a minimum visible sliver (a 1-episode cell
      // must not vanish next to the busiest cell of the shared scale)
      const MIN_SEG = 1.5;
      const segs = [
        [v3 > 0 ? Math.max(bH, MIN_SEG) : bH, typeof v6 === "string" ? v6 : "#1a7f37"],
        [v4 > 0 ? Math.max(yH, MIN_SEG) : yH, "#f59f00"],
        [v5 > 0 ? Math.max(rH, MIN_SEG) : rH, "#cf222e"],
      ];
      let base = unit;
      for (const [segH, segCol] of segs) {
        if (segH > 0.5) {
          children.push({
            type: "rect", z2: 2,
            shape: { x: x + g, y: y + base - segH, width: w - 2 * g, height: segH },
            style: { fill: segCol },
          });
        }
        base -= segH;
      }
      if (showText && v2 > 0) {
        children.push({
          type: "text", z2: 4, silent: true,
          style: {
            text: String(v2), x: cx, y: cy, fill: "#24292f",
            font: "11px sans-serif", align: "center", verticalAlign: "middle",
          },
        });
      }
    } else {
      const fh = unit * (v2 / maxN);
      if (fh > 0.5) {
        children.push({
          type: "rect", z2: 2,
          shape: { x: x + g, y: y + h - g - fh, width: w - 2 * g, height: fh },
          style: { fill: v3 || "#1a7f37" },
        });
      }
      if (showText) {
        children.push({
          type: "text", z2: 4, silent: true,
          style: {
            text: String(v2), x: cx, y: cy, fill: "#24292f",
            font: "11px sans-serif", align: "center", verticalAlign: "middle",
          },
        });
      }
    }
    return { type: "group", children };
  };
}

function dayLabels(days) {
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const years = new Set(days.map(s => s.slice(0, 4)));
  return days.map(s => {
    const [y, m, dd] = s.split("-");
    const wd = WD[new Date(+y, +m - 1, +dd).getDay()];
    return years.size > 1 ? `${wd} ${+dd}.${+m}.${y}` : `${wd} ${+dd}.${+m}.`;
  });
}

function drawDayHeatmap(id, rows, maxNOverride = null, showText = false) {
  // bands mode: rows [date, hour, audible, loud, veryLoud]; newest day on top
  const hourList = hourCols();
  const hours = hourList.map(h => String(h).padStart(2, "0"));
  const days = [...new Set(rows.map(r => r[0]))].sort();
  const lookup = new Map(rows.map(([ds, h, b, y, r]) => [`${ds}-${h}`, [b, y, r]]));
  const data = [];
  days.forEach((ds, yi) => {
    for (const h of hourList) {
      const x = hourList.indexOf(h);
      const [b, y, r] = lookup.get(`${ds}-${h}`) ?? [0, 0, 0];
      // audible base segment: violet at night (22-07), green by day
      const baseCol = (h >= 22 || h <= 6) ? "#8b5cf6" : "#1a7f37";
      data.push([x, yi, b + y + r, b, y, r, baseCol]);
    }
  });
  const maxN = maxNOverride ?? Math.max(...data.map(d2 => d2[2]), 1);
  const labels = dayLabels(days);
  mkChart(id).setOption({
    animation: false,
    grid: { left: 86, right: 16, top: 26, bottom: 16 },
    tooltip: {
      formatter: p => `${labels[p.value[1]]}, ${hours[p.value[0]]}:00\u2013${hours[p.value[0]]}:59<br>` +
                      `<b>${p.value[2]}</b> events`,
    },
    xAxis: { type: "category", data: hours, position: "top" },
    yAxis: { type: "category", data: labels, axisLabel: { color: "#57606a" } },
    series: [{ type: "custom", encode: { x: 0, y: 1 }, data,
               renderItem: fillCellsRender(maxN, showText, "hours-violet", hourList) }],
  });
}

// one pooled grid: all noise types together, one row per day of the last 3 weeks
async function loadDay3w() {
  const to = Date.now() / 1000;
  const p = { from: to - 21 * 86400, to };
  await loadCounts();  // fills state.groupMembers
  const cont = document.getElementById("day3w-list");
  disposeChartsIn(cont);
  cont.innerHTML = "";
  // every non-Background class, ";"-joined for the API
  const members = Object.entries(state.groupMembers)
    .filter(([g]) => !EXCLUDED_GROUPS.has(g))
    .flatMap(([, m]) => m).join(";");
  const div = document.createElement("div");
  div.id = "d3w-all";
  div.className = "chart";
  cont.append(div);
  const heat = await get("/api/hourly", { ...p, event: members, by: "daybands" });
  drawDayHeatmap("d3w-all", heat.rows);
}

// single Motor-group grid, same daybands pipeline as the Daily view —
// the audible band is zeroed so only loud (yellow) + very loud (red) show
async function loadLoudVehicles() {
  const to = Date.now() / 1000;
  const p = { from: to - 21 * 86400, to };
  await loadCounts();  // fills state.groupMembers
  const members = (state.groupMembers.Motor || []).join(";");
  const heat = await get("/api/hourly",
    { ...p, event: members, by: "daybands" });
  // by="daybands" rows: [date, hour, audible, loud, veryLoud]
  const rows = heat.rows.map(([ds, h, , loud, very]) => [ds, h, 0, loud, very]);
  drawDayHeatmap("loudveh-chart", rows, null, true);
}

function drawWeekdayLoad(id, rows, maxLoad) {
  const hourList = hourCols();
  const hours = hourList.map(h => String(h).padStart(2, "0"));
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hourIdx = new Map(hourList.map((h, i) => [h, i]));
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  const data = rows.map(([wd, h, v]) => {
    const night = +h >= 22 || +h <= 6;
    const stops = night ? VIOLET_STOPS : GREEN_STOPS;
    const t = Math.min(Math.max((v / maxLoad) * (stops.length - 1), 0), stops.length - 1.001);
    const seg = Math.floor(t), f = t - seg;
    const c = stops[seg].map((x, i2) => Math.round(x + (stops[seg + 1][i2] - x) * f));
    return {
      value: [hourIdx.get(+h), dayIdx.get(days[(Number(wd) + 6) % 7]), v],
      itemStyle: { color: `rgb(${c[0]},${c[1]},${c[2]})` },
    };
  });
  mkChart(id).setOption({
    animation: false,
    grid: { left: 48, right: 16, top: 26, bottom: 16 },
    tooltip: {
      formatter: p => `${days[p.value[1]]} ${hours[p.value[0]]}:00\u2013${hours[p.value[0]]}:59<br>` +
                      `noise load <b>${p.value[2]}</b>`,
    },
    xAxis: { type: "category", data: hours, position: "top" },
    // inverse → first row (Mon) on top, reading top-down Mon…Sun
    yAxis: { type: "category", data: days, inverse: true,
             axisLabel: { color: "#57606a" } },
    series: [{ type: "heatmap", data }],
  });
}

async function loadHeatmapView() {
  // cached payload (all thresholds + noise load), recomputed every 5 min
  if (!state.weekdayPayload || Date.now() - state.weekdayFetchedAt > 300000) {
    state.weekdayPayload = await get("/api/weekday");
    state.weekdayFetchedAt = Date.now();
  }
  stopWeekdayCycle();
  const cont = document.getElementById("heatmap-list");
  disposeChartsIn(cont);
  cont.innerHTML = "";
  // pool the per-group noise-load grids into one (Background already
  // excluded server-side); noise load is additive, so sums are valid
  const merged = new Map();
  for (const cells of Object.values(state.weekdayPayload.load || {})) {
    for (const [wd, h, v] of cells) {
      const k = `${wd}|${h}`;
      merged.set(k, (merged.get(k) || 0) + v);
    }
  }
  const grid = [...merged].map(([k, v]) => {
    const [wd, h] = k.split("|").map(Number);
    return [wd, h, Math.round(v * 10) / 10];
  });
  const maxLoad = Math.max(1, ...grid.map(x => x[2]));
  const div = document.createElement("div");
  div.id = "hm-all";
  div.className = "chart";
  cont.append(div);
  drawWeekdayLoad("hm-all", grid, maxLoad);
}

/* ---------------------------------------------------------- view switching */

const VIEW_LOADERS = {
  live: loadLive,
  events: loadEventsView,
  threed: loadThreed,
  heatmap: loadHeatmapView,
  day3w: loadDay3w,
  loudveh: loadLoudVehicles,
  loudest: loadLoudList,
  readme: async () => {},  // static content, nothing to load
};
let activeView = "live";

async function showView(name) {
  if (!VIEW_LOADERS[name]) return;
  if (name !== "heatmap") stopWeekdayCycle();
  activeView = name;
  document.querySelectorAll("#nav .nav-item").forEach(b =>
    b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll("main section").forEach(s => {
    s.hidden = s.id !== "view-" + name;
  });
  // the 3D view uses the full browser area
  document.body.classList.toggle("wide", name === "threed");
  // charts created while hidden have size 0 → resize once visible
  document.getElementById("view-" + name).querySelectorAll(".chart").forEach(el => {
    const inst = echarts.getInstanceByDom(el);
    if (inst) inst.resize();
  });
  // the live strip is 1920px tall → land at the top (newest end) after render
  await VIEW_LOADERS[name]();
  if (name === "live") window.scrollTo(0, 0);
}

/* ------------------------------------------------- sidebar footer (meta) */

async function loadMeta() {
  try {
    const m = await get("/api/meta");
    if (m.version)
      document.getElementById("meta-version").textContent = "Version " + m.version;
    if (m.backup)
      document.getElementById("meta-backup").textContent = "Backup " + m.backup;
  } catch { /* footer keeps "—" placeholders */ }
}

/* ------------------------------------------------------------------ boot */

// auto-reload when the UI was updated server-side: mobile/tab Safari keeps a
// background page's old JS alive indefinitely, so new deploys never reach it.
// index.html is served with Cache-Control: no-cache → its ETag changes on
// every static-file change; poll it and reload the page when it differs.
let htmlETag = null;
async function checkUiDeploy() {
  try {
    const etag = (await fetch("/", { method: "HEAD" })).headers.get("etag");
    if (!etag) return;
    if (htmlETag === null) { htmlETag = etag; return; }
    if (etag !== htmlETag) location.reload();
  } catch { /* server hiccup — retry on the next tick */ }
}

async function boot() {
  loadMeta();
  checkUiDeploy();
  try {
    const r = await get("/api/range");
    state.dataMin = r.spl.min ?? r.events.min;
  } catch { /* empty db */ }

  document.getElementById("nav").addEventListener("click", e => {
    const b = e.target.closest(".nav-item");
    if (b) showView(b.dataset.view).catch(console.error);
  });
  const syncThrTags = () => {
    const cls = state.loudDb <= -50 ? "thr-blue"
              : state.loudDb <= -42 ? "thr-yellow" : "thr-red";
    document.querySelectorAll(".tag.thr").forEach(t => {
      t.classList.remove("thr-blue", "thr-yellow", "thr-red");
      t.classList.add(cls);
      t.textContent = ">" + state.loudDb;
    });
  };
  syncThrTags();
  window.addEventListener("resize", () => Object.values(charts).forEach(c => c.resize()));

  await showView("live");
  // only the Last-5-min strip auto-refreshes; all other views load on entry
  setInterval(() => {
    if (activeView === "live") loadLive().catch(console.error);
  }, 5000);
  // keep the "last backup" footer date current + pick up UI deploys
  setInterval(() => { loadMeta(); checkUiDeploy(); }, 60000);
}

boot().catch(console.error);
