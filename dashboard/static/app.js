/* global echarts */
"use strict";

const state = { dataMin: null, groupMembers: {}, weekdayPayload: null, weekdayFetchedAt: 0 };

/* group raw AudioSet classes into city-relevant families (prefix match on
   word boundaries; order matters — first hit wins) */
const GROUP_RULES = [
  { name: "Other", keys: ["siren", "horn", "honk", "toot", "beep", "bell", "chime", "gong", "toll"] },
  { name: "Other", keys: ["train", "rail", "tram", "subway", "metro", "locomotive"] },
  { name: "Other", keys: ["aircraft", "airplane", "helicopter", "jet", "propeller"] },
  { name: "Music", keys: ["music", "singing", "choir", "guitar", "piano", "organ", "drum", "violin", "cello", "orchestra", "flute", "trumpet", "trombone", "brass", "woodwind", "saxophone", "clarinet", "harp", "banjo", "mandolin", "marimba", "xylophone", "percussion", "timpani", "instrument", "opera", "techno", "jazz", "reggae"] },
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

function stamp() {
  document.getElementById("updated").textContent =
    "updated " + fmtTime(Date.now());
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

  // pills grouped: tinted background + colored text, pinned on the line
  // (Background group events are noise-floor labels — not shown)
  const pills = d.events
    .filter(e => e.spl != null && !EXCLUDED_GROUPS.has(groupOf(e.event)))
    .map(e => {
      const g = groupOf(e.event);
      return {
        value: [toLog(e.spl), e.t * 1000],
        event: g,
        conf: e.confidence,
        label: {
          formatter: g,
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
      type: "value", min: 0, max: Math.log(36), position: "top", name: "dBFS(A)",
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
          data: dB_TICKS.map(v => ({ xAxis: toLog(v), label: { formatter: String(v) } })),
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
  const d = await get("/api/classdist");
  // rows: [event, bucket(-60..-31), count] → aggregate into groups (all of them)
  const cols = Array.from({ length: 30 }, (_, i) => -60 + i);
  const byGroup = new Map();
  for (const [ev, b, n] of d.rows) {
    const g = groupOf(ev);
    if (EXCLUDED_GROUPS.has(g)) continue;
    if (!byGroup.has(g)) byGroup.set(g, new Map());
    const m = byGroup.get(g);
    m.set(b, (m.get(b) || 0) + n);
  }
  const sumOf = g => [...byGroup.get(g).values()].reduce((s, x) => s + x, 0);
  const labels = [...byGroup.keys()].sort((a, b2) => sumOf(b2) - sumOf(a));
  const data = [];
  let maxN = 1;
  labels.forEach((g, yi) => {
    const m = byGroup.get(g);
    cols.forEach((b, xi) => {
      const n = m.get(b) ?? 0;
      maxN = Math.max(maxN, n);
      // louder than −45 dB → red fill, otherwise blue
      data.push([xi, yi, n, b >= -45 ? "#cf222e" : "#2f6feb"]);
    });
  });
  mkChart("classdist").setOption({
    animation: false,
    grid: { left: 180, right: 16, top: 34, bottom: 16 },
    tooltip: { formatter: p =>
      `${labels[p.value[1]]}, ${cols[p.value[0]]}…${cols[p.value[0]] + 1} dB<br>` +
      `<b>${p.value[2]}</b> events` },
    xAxis: { type: "category", data: cols, position: "top",
             axisLabel: { color: "#57606a" } },
    yAxis: { type: "category", data: labels, inverse: true,
             axisLabel: { color: "#57606a" } },
    series: [{ type: "custom", encode: { x: 0, y: 1 }, data,
               renderItem: fillCellsRender(maxN, false, "db45") }],
  });
}

async function loadEventsView() {
  await loadClassDist();
}

async function loadThreed() {
  await loadDist3D();
}

const WDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function loadLoudList() {
  const d = await get("/api/loudest", { limit: 100 });
  document.getElementById("loud-body").innerHTML = d.rows.length
    ? d.rows.map(r => {
        const dt = new Date(r[0] * 1000);
        const h24 = dt.getHours();
        const night = h24 >= 22 || h24 <= 6;  // 22:00–06:59
        const h = String(h24).padStart(2, "0") + "h";
        return `<tr${night ? ' class="night"' : ""}>` +
               `<td>${r[3].toFixed(1)}</td><td>${r[1]}</td>` +
               `<td>${h}</td><td>${WDAYS[dt.getDay()]}</td>` +
               `<td>${fmtDate(r[0] * 1000)}</td></tr>`;
      }).join("")
    : "<tr><td colspan='5'>none yet — nothing louder than −40 dB recorded</td></tr>";
}

async function loadDist3D() {
  const to = Date.now() / 1000;
  const d = await get("/api/weekcounts", { from: to - 7 * 86400, to, hourly: 1 });

  // aggregate [weekday, hour, class, count] → dot cloud over group/weekday/hour
  const groups = new Map();
  const cells = new Map();   // "group|wd|hour" -> count
  for (const [wd, h, cls, n] of d.rows) {
    const g = groupOf(cls);
    if (EXCLUDED_GROUPS.has(g)) continue;
    groups.set(g, (groups.get(g) || 0) + n);
    const key = `${g}|${wd}|${h}`;
    cells.set(key, (cells.get(key) || 0) + n);
  }
  const names = [...groups.keys()].sort((a, b) => groups.get(b) - groups.get(a));
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const info = new Map();
  const data = [];
  let maxN = 1;
  for (const [key, n] of cells) {
    const [g, wd, h] = key.split("|");
    const x = names.indexOf(g), y = (Number(wd) + 6) % 7, z = +h;
    maxN = Math.max(maxN, n);
    data.push([x, y, z, n]);
    info.set(`${x}|${y}|${z}`, [g, days[y], n]);
  }

  mkChart("dist3d").setOption({
    animation: false,
    tooltip: {
      formatter: p => {
        const [g, day, n] = info.get(`${p.value[0]}|${p.value[1]}|${p.value[2]}`) || ["?", "?", 0];
        return `${day}, ${g}, ${String(p.value[2]).padStart(2, "0")}:00<br><b>${n}</b> events`;
      },
    },
    visualMap: {
      show: false, dimension: 3, min: 1, max: maxN,
      inRange: { color: ["#9ec5fe", "#2f6feb", "#cf222e"] },
    },
    xAxis3D: { type: "category", data: names, name: "group",
               axisLabel: { textStyle: { color: "#57606a", fontSize: 10 } } },
    yAxis3D: { type: "category", data: days, name: "weekday",
               axisLabel: { textStyle: { color: "#57606a", fontSize: 10 } } },
    zAxis3D: { type: "value", min: -0.5, max: 23.5, name: "hour",
               axisLabel: { formatter: v => v + "h",
                            textStyle: { color: "#57606a", fontSize: 10 } } },
    grid3D: {
      boxWidth: 140, boxDepth: 90, boxHeight: 180,
      viewControl: { distance: 280, alpha: 20, beta: 40 },
      axisLine: { lineStyle: { color: "#d0d7de" } },
      axisLabel: { textStyle: { color: "#57606a" } },
      splitLine: { lineStyle: { color: "#eaeef2" } },
      light: { main: { intensity: 1.2 }, ambient: { intensity: 0.4 } },
    },
    series: [{
      type: "scatter3D", data,
      symbolSize: val => 2 + Math.sqrt(val[3]) * 2.5,
      itemStyle: { opacity: 0.85 },
      emphasis: { itemStyle: { opacity: 1 } },
    }],
  });
}

/* --------------------------------------------------------------- heatmap */

function hexToRgb(hex) {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}
const DAY_STOPS = ["#eaeef2", "#9ec5fe", "#2f6feb", "#0550ae"].map(hexToRgb);
const RED_STOPS = ["#ffebe9", "#ffa198", "#cf222e", "#a40e26"].map(hexToRgb);
function scaleColor(stops, t) {
  const seg = Math.min(Math.floor(t * (stops.length - 1)), stops.length - 2);
  const f = t * (stops.length - 1) - seg;
  const c = stops[seg].map((v, i) => Math.round(v + (stops[seg + 1][i] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function drawHeatmap(id, cells, stops = DAY_STOPS) {
  // SQLite %w: 0=Sunday; display Mon..Sun
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
  const max = cells.reduce((m, c) => Math.max(m, c[2]), 1);
  const data = cells.map(([w, h, n]) => ({
    value: [(h), (w + 6) % 7, n],
    itemStyle: {
      color: scaleColor(stops, n / max),
    },
  }));
  mkChart(id).setOption({
    animation: false,
    grid: { left: 48, right: 16, top: 10, bottom: 16 },
    tooltip: {
      formatter: p => `${days[p.value[1]]} ${hours[p.value[0]]}:00–${hours[p.value[0]]}:59<br>` +
                      `≈ <b>${(+p.value[2]).toFixed(1)}</b> events`,
    },
    xAxis: { type: "category", data: hours },
    yAxis: { type: "category", data: days },
    series: [{ type: "heatmap", data, label: { show: false } }],
  });
}

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

async function loadHeatmapView() {
  // cached payload (all thresholds), recomputed server-side every 5 min
  if (!state.weekdayPayload || Date.now() - state.weekdayFetchedAt > 300000) {
    state.weekdayPayload = await get("/api/weekday");
    state.weekdayFetchedAt = Date.now();
  }
  stopWeekdayCycle();
  const cont = document.getElementById("heatmap-list");
  disposeChartsIn(cont);
  cont.innerHTML = "";
  // per group: blue grid (all events ≥ −70) with the red grid (≥ −45) below
  for (const g of state.weekdayPayload.groups) {
    const id = "hm-" + g.replace(/[^a-z0-9]/gi, "-");
    const h3 = document.createElement("h3");
    h3.textContent = g;
    const blueDiv = document.createElement("div");
    blueDiv.id = id + "-blue";
    blueDiv.className = "chart";
    const sub = document.createElement("div");
    sub.className = "hint";
    sub.style.margin = "10px 0 6px";
    sub.textContent = "only events louder than −45 dB:";
    const redDiv = document.createElement("div");
    redDiv.id = id + "-red";
    redDiv.className = "chart";
    cont.append(h3, blueDiv, sub, redDiv);
    drawHeatmap(blueDiv.id, state.weekdayPayload.thresholds["-70"][g] || [], DAY_STOPS);
    drawHeatmap(redDiv.id, state.weekdayPayload.thresholds["-45"][g] || [], RED_STOPS);
  }
}

// all three category views use the same grouping logic, just different groups
function groupedNoiseViewLoader(prefix, group, colorBy = "hour", showText = true) {
  return async () => {
    const p = allParams();
    await loadCounts();  // fills state.groupMembers
    const members = (state.groupMembers[group]?.length ? state.groupMembers[group] : [group]).join(";");
    const heat = await get("/api/hourly", { ...p, event: members, by: "day" });
    drawDayHeatmap(prefix + "noise", heat.rows, colorBy, showText);
  };
}
const loadSpeech = groupedNoiseViewLoader("s", "Human", "loudness", false);
const loadMusic = groupedNoiseViewLoader("mu", "Music", "loudness", false);
async function loadMotorNoise() {
  return groupedNoiseViewLoader("m", "Motor", "loudness", false)();
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

function fillCellsRender(maxN, showText = true, bg = null) {
  // bg "hours": light red background for hour columns 22–06 (day tables)
  // bg "db45":  light red background for buckets −45 and louder (Loudness)
  // cell with fill level proportional to count; count label centered.
  // data [x, y, total]       → single fill, color value[3] || blue
  // data [x, y, total, q, l] → stacked fill: blue quiet base + red loud top
  return (params, api) => {
    const [cx, cy] = api.coord([api.value(0), api.value(1)]);
    const w = api.size([1, 0])[0];
    const h = api.size([0, 1])[1];
    const x = cx - w / 2, y = cy - h / 2;
    const n = api.value(2);
    const v0 = api.value(0);
    const v3 = api.value(3);
    const v4 = api.value(4);
    const g = 1; // gap between cells
    const bgLightRed =
      bg === "hours" ? (v0 >= 22 || v0 <= 6) :
      bg === "db45" ? (v0 >= 15) : false;  // v0 ≥ 15 ⇔ bucket ≥ −45
    const children = [{
      type: "rect", z2: 1,
      shape: { x, y: y + g, width: w - g, height: h - g },
      style: {
        fill: bgLightRed ? "#fdecea" : "#eaeef2",
        stroke: "#d0d7de", lineWidth: 1,
      },
    }];
    const unit = h - 2 * g;
    if (typeof v3 === "number" && typeof v4 === "number") {
      const qH = unit * (v3 / maxN);
      const lH = unit * (v4 / maxN);
      if (qH > 0.5) {
        children.push({
          type: "rect", z2: 2,
          shape: { x: x + g, y: y + h - g - qH, width: w - 2 * g, height: qH },
          style: { fill: "#2f6feb" },
        });
      }
      if (lH > 0.5) {
        children.push({
          type: "rect", z2: 2,
          shape: { x: x + g, y: y + h - g - qH - lH, width: w - 2 * g, height: lH },
          style: { fill: "#cf222e" },
        });
      }
    } else {
      const fh = unit * (n / maxN);
      if (fh > 0.5) {
        children.push({
          type: "rect", z2: 2,
          shape: { x: x + g, y: y + h - g - fh, width: w - 2 * g, height: fh },
          style: { fill: v3 || "#2f6feb" },
        });
      }
    }
    if (showText) {
      children.push({
        type: "text", z2: 3, silent: true,
        style: {
          text: String(n), x: cx, y: cy, fill: "#24292f",
          font: "11px sans-serif", align: "center", verticalAlign: "middle",
        },
      });
    }
    return { type: "group", children };
  };
}

function drawDayHeatmap(id, rows, colorBy = "hour", showText = true) {
  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
  // rows: ["YYYY-MM-DD", hour, count, avgSpl|null, maxSpl|null, loudCount]
  const days = [...new Set(rows.map(r => r[0]))].sort();
  const idx = new Map(days.map((s, i) => [s, i]));
  const lookup = new Map(rows.map(([s, h, n, , , loud]) => [`${s}-${h}`, [n, loud]]));
  const data = [];
  days.forEach((ds, yi) => {
    for (let h = 0; h < 24; h++) {
      const [n, loud] = lookup.get(`${ds}-${h}`) ?? [0, 0];
      if (colorBy === "loudness") {
        // stacked fill: blue = events < −45, red = events ≥ −45
        data.push([h, yi, n, n - loud, loud]);
      } else {
        data.push([h, yi, n, (h >= 22 || h <= 6) ? "#cf222e" : "#2f6feb"]);
      }
    }
  });
  const maxN = Math.max(...data.map(d => d[2]), 1);
  const labels = dayLabels(days);
  mkChart(id).setOption({
    animation: false,
    grid: { left: 86, right: 16, top: 26, bottom: 16 },
    tooltip: {
      formatter: p => `${labels[p.value[1]]}, ${hours[p.value[0]]}:00–${hours[p.value[0]]}:59<br>` +
                      `<b>${p.value[2]}</b> events`,
    },
    xAxis: { type: "category", data: hours, position: "top" },
    yAxis: { type: "category", data: labels, axisLabel: { color: "#57606a" } },
    series: [{ type: "custom", encode: { x: 0, y: 1 }, data,
               renderItem: fillCellsRender(maxN, showText, "hours") }],
  });
}

/* ---------------------------------------------------------- view switching */

const VIEW_LOADERS = {
  live: loadLive,
  motornoise: loadMotorNoise,
  speech: loadSpeech,
  music: loadMusic,
  events: loadEventsView,
  threed: loadThreed,
  heatmap: loadHeatmapView,
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
  stamp();
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  try {
    const r = await get("/api/range");
    state.dataMin = r.spl.min ?? r.events.min;
  } catch { /* empty db */ }

  document.getElementById("nav").addEventListener("click", e => {
    const b = e.target.closest(".nav-item");
    if (b) showView(b.dataset.view).catch(console.error);
  });
  window.addEventListener("resize", () => Object.values(charts).forEach(c => c.resize()));

  await showView("live");
  // only the Last-5-min strip auto-refreshes; all other views load on entry
  setInterval(() => {
    if (activeView === "live") loadLive().then(stamp).catch(console.error);
  }, 5000);
}

boot().catch(console.error);
