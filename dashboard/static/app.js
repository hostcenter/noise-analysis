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

const FROM_DATE = "2026-10-04";
function sinceOct4Params() {
  const from = new Date(2026, 9, 4).getTime() / 1000;  // 04.10.2026 00:00 local
  return { from, to: Date.now() / 1000 };
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

  // logarithmic loudness axis: plot log(dB + 56) so −55→0, −25→log31
  const LOG_OFF = 56;
  const toLog = v => Math.log(Math.max(v + LOG_OFF, 0.5));
  const dB_TICKS = [-55, -50, -45, -40, -35, -30, -25];

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
      type: "value", min: 0, max: Math.log(31), position: "top", name: "dB",
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
            [{ xAxis: toLog(-55), itemStyle: { color: "rgba(26,127,55,0.07)" } },
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

async function loadThreed() {
  await loadDist3D();
}

const WDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const dist3dState = {
  data: [],
  days: [],
  labels: [],
  counts: new Map(),
  centerZ: null,
  minCenterZ: -250,
  maxCenterZ: 250,
  keyBound: false,
};

function getGrid3DView(chart) {
  try {
    const model = chart.getModel().getComponent("grid3D");
    return chart._componentsViews.find(v => v.type === "grid3D" || v._model === model);
  } catch (e) {
    return null;
  }
}

function getGrid3DControl(chart) {
  const view = getGrid3DView(chart);
  return view && view._control;
}

function patchOppositeAxes(chart) {
  const view = getGrid3DView(chart);
  if (!view || view._oppositePatched || !view._axes || view._axes.length < 3) return;
  view._oppositePatched = true;

  const origUpdatePos = view._updateAxisLinePosition;
  view._updateAxisLinePosition = function() {
    origUpdatePos.call(this);
    const coordSys = this._model.coordinateSystem;
    const xAx = coordSys.getAxis("x");
    const yAx = coordSys.getAxis("y");
    const zAx = coordSys.getAxis("z");
    const zMax = zAx.getExtentMax(), zMin = zAx.getExtentMin();
    const xMin = xAx.getExtentMin(), xMax = xAx.getExtentMax();
    const yMax = yAx.getExtentMax(), yMin = yAx.getExtentMin();
    const f = this._faces;

    // Default ECharts-GL places both Y (Day) and Z (Noise level) on the same X side:
    //   g (for Y) = f[0].invisible ? xMin : xMax
    //   v (for Z) = f[0].invisible ? xMax : xMin
    // When looking straight down the airstrip (beta=0), f[0] and f[1] have equal Z,
    // so both Y and Z end up on the right side (+60).
    // Move the Y (Day) axis to the opposite X side from Z (Noise level),
    // and ensure ticks/labels point outward on that side:
    const c = this._axes[1].rootNode;  // Y (Day) axis
    const d = this._axes[2].rootNode;  // Z (Noise level) axis
    const zPosX = d.position.x;        // Where Z axis is placed (e.g. +60 right)
    const yPosX = zPosX >= 0 ? xMin : xMax; // Opposite side for Day axis (e.g. -60 left)
    const _ = f[2].rootNode.invisible ? zMax : zMin;

    c.rotation.identity();
    if (yPosX < 0) {
      this._axes[1].flipped = true;
      c.rotation.rotateZ(Math.PI);
    } else {
      this._axes[1].flipped = false;
    }
    c.position.set(yPosX, _, 0);
    c.update();

    this._updateAxisLabelAlign();
  };

  view._updateAxisLinePosition();
}

function flyAirstrip(deltaZ) {
  const chart = charts["dist3d"];
  if (!chart || dist3dState.centerZ === null) return;
  const ctrl = getGrid3DControl(chart);
  const curCenter = ctrl ? ctrl.getCenter() : [0, -10, dist3dState.centerZ];
  const nextZ = Math.max(dist3dState.minCenterZ, Math.min(dist3dState.maxCenterZ, curCenter[2] + deltaZ));
  dist3dState.centerZ = nextZ;
  const newCenter = [curCenter[0], curCenter[1], nextZ];
  if (ctrl) {
    ctrl.setCenter(newCenter);
    ctrl.update();
  } else {
    chart.setOption({ grid3D: { viewControl: { center: newCenter } } });
  }
}

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

function bicubicEval(grid, x, y, rows, cols, maxCap) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = x - xi;
  const ty = y - yi;

  const getZ = (r, c) => {
    const rr = Math.max(0, Math.min(rows - 1, r));
    const cc = Math.max(0, Math.min(cols - 1, c));
    return grid[rr][cc];
  };

  const colVals = [];
  for (let m = -1; m <= 2; m++) {
    const p0 = getZ(yi + m, xi - 1);
    const p1 = getZ(yi + m, xi);
    const p2 = getZ(yi + m, xi + 1);
    const p3 = getZ(yi + m, xi + 2);
    colVals.push(catmullRom(p0, p1, p2, p3, tx));
  }
  const val = catmullRom(colVals[0], colVals[1], colVals[2], colVals[3], ty);
  return Math.max(0, Math.min(maxCap, +val.toFixed(1)));
}

async function loadDist3D() {
  const p = sinceOct4Params();
  await loadCounts();
  const members = Object.entries(state.groupMembers)
    .filter(([g]) => !EXCLUDED_GROUPS.has(g))
    .flatMap(([, m]) => m).join(";");
  const res = await get("/api/hourly", { ...p, event: members, by: "dayload" });

  const filtered = res.rows.filter(r => r[0] >= FROM_DATE);
  // In ECharts-GL, y=0 is mapped to +boxDepth/2 (front, closest to camera at +Z)
  // and y=days.length-1 is mapped to -boxDepth/2 (back, away from camera at -Z).
  // Put earliest date (Oct 4th) at y=0 (very front) and newest date at y=days.length-1 (back).
  const days = [...new Set(filtered.map(r => r[0]))].sort();
  const labels = days.map(formatDaySelector);
  const lookup = new Map();
  let maxLoad = 1;
  for (const [ds, h, loadVal] of filtered) {
    if (loadVal != null) {
      lookup.set(`${ds}-${h}`, +loadVal);
      if (loadVal > maxLoad) maxLoad = +loadVal;
    }
  }
  const zMax = Math.ceil(maxLoad * 1.05);

  const now = new Date();
  const p2 = n => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  const nowH = now.getHours();

  const numDays = days.length;
  // Build raw 2D grid [yi][x] for bicubic spline interpolation
  const rawGrid = [];
  for (let yi = 0; yi < numDays; yi++) {
    const ds = days[yi];
    const row = [];
    let lastValid = 0;
    for (let x = 0; x < 24; x++) {
      const val = lookup.get(`${ds}-${x}`);
      if (val != null) {
        lastValid = val;
        row.push(val);
      } else {
        row.push(ds === today && x > nowH ? lastValid : 0);
      }
    }
    rawGrid.push(row);
  }

  // Subdivide 4x along X (hours) and 3x along Y (days) for smooth spline surface
  const subX = 4;
  const subY = 3;
  const stepsX = (24 - 1) * subX + 1;
  const stepsY = Math.max(1, (numDays - 1) * subY + 1);
  const data = [];

  for (let j = 0; j < stepsY; j++) {
    const y = j / subY;
    const nearYi = Math.round(y);
    const ds = days[nearYi];
    for (let i = 0; i < stepsX; i++) {
      const x = i / subX;
      if (ds === today && x > nowH + 0.25) {
        data.push([+x.toFixed(2), +y.toFixed(2), null]);
      } else {
        const zSmooth = bicubicEval(rawGrid, x, y, numDays, 24, zMax);
        data.push([+x.toFixed(2), +y.toFixed(2), zSmooth]);
      }
    }
  }

  const boxDepth = Math.max(240, numDays * 16);
  dist3dState.data = data;
  dist3dState.dataShape = [stepsY, stepsX];
  dist3dState.days = days;
  dist3dState.labels = labels;
  dist3dState.lookup = lookup;
  dist3dState.maxLoad = maxLoad;
  dist3dState.zMax = zMax;
  dist3dState.boxDepth = boxDepth;
  // In ECharts-GL, y=0 (Oct 4th) is at +boxDepth/2 (very front, maxCenterZ)
  // and y=max (newest date) is at -boxDepth/2 (back, minCenterZ).
  dist3dState.minCenterZ = -boxDepth / 2 + 20;
  dist3dState.maxCenterZ = boxDepth / 2 - 20;
  if (dist3dState.centerZ === null) {
    dist3dState.centerZ = dist3dState.maxCenterZ; // Start at the most arrow-down point (very front, Oct 4th)
  } else {
    dist3dState.centerZ = Math.max(dist3dState.minCenterZ, Math.min(dist3dState.maxCenterZ, dist3dState.centerZ));
  }

  if (!dist3dState.keyBound) {
    dist3dState.keyBound = true;
    window.addEventListener("keydown", e => {
      if (activeView !== "threed") return;
      if (e.target && (e.target.tagName === "SELECT" || e.target.tagName === "INPUT")) return;
      const step = 20;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        flyAirstrip(-step);  // Up arrow (inverted)
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        flyAirstrip(step);   // Down arrow (inverted)
      }
    });
  }

  applyDist3D();
}

const NOISESCAPE_COLORS = ["#1a7f37", "#2f9e44", "#8ce99a", "#f59f00", "#e8590c", "#cf222e", "#82071e"];

function applyDist3D() {
  const { data, dataShape, days, labels, lookup, maxLoad, zMax, boxDepth, centerZ } = dist3dState;
  const chart = mkChart("dist3d");
  chart.setOption({
    animation: false,
    graphic: [
      {
        type: "text",
        left: 16,
        top: 10,
        style: {
          text: "Keyboard: ↑ / ↓ to fly along the timeline\nMouse: Left drag rotate · Right drag pan · Scroll zoom",
          fill: "#57606a",
          fontSize: 11,
          lineHeight: 16,
          fontFamily: "inherit",
        },
      },
    ],
    tooltip: {
      formatter: p => {
        if (!p.value || p.value[2] == null) return "";
        const x = Math.min(23, Math.max(0, Math.round(p.value[0])));
        const yi = Math.min(days.length - 1, Math.max(0, Math.round(p.value[1])));
        const ds = days[yi] || "";
        const label = labels[yi] || ds;
        const hh = String(x).padStart(2, "0");
        const exactVal = lookup.get(`${ds}-${x}`);
        const val = (exactVal != null ? exactVal : Number(p.value[2])).toFixed(1);
        return `<b>${label}</b>, ${hh}:00\u2013${hh}:59<br>` +
               `noise level <b>${val}</b>`;
      },
    },
    visualMap: {
      show: true,
      dimension: 2,
      min: 0,
      max: maxLoad,
      calculable: true,
      orient: "horizontal",
      left: 16,
      top: 48,
      itemWidth: 14,
      itemHeight: 160,
      text: ["High", "Noise level: Low"],
      inRange: {
        color: NOISESCAPE_COLORS,
      },
      textStyle: { color: "#57606a", fontSize: 11 },
    },
    xAxis3D: {
      type: "value",
      name: "Hour",
      min: 0,
      max: 23,
      interval: 3,
      axisLabel: {
        formatter: v => String(Math.round(v)).padStart(2, "0") + ":00",
        textStyle: { color: "#57606a", fontSize: 10 },
      },
    },
    yAxis3D: {
      type: "value",
      name: "Day",
      min: 0,
      max: Math.max(1, days.length - 1),
      interval: 2,
      axisLabel: {
        formatter: v => labels[Math.round(v)] || "",
        textStyle: { color: "#57606a", fontSize: 10 },
      },
    },
    zAxis3D: {
      type: "value",
      name: "Noise level",
      min: 0,
      max: zMax,
      axisLabel: {
        formatter: v => Math.round(v),
        textStyle: { color: "#57606a", fontSize: 10 },
      },
    },
    grid3D: {
      boxWidth: 200,
      boxDepth: boxDepth,
      boxHeight: 75,
      axisLine: { lineStyle: { color: "#d0d7de" } },
      axisLabel: { textStyle: { color: "#57606a" } },
      splitLine: { lineStyle: { color: "#eaeef2" } },
      light: {
        main: { intensity: 1.15, shadow: false, alpha: 35, beta: 30 },
        ambient: { intensity: 0.45 },
      },
      viewControl: {
        projection: "perspective",
        alpha: 22,
        beta: 0,
        distance: 310,
        minDistance: 40,
        maxDistance: 500,
        center: [0, -10, centerZ],
        panMouseButton: "right",
        rotateMouseButton: "left",
        damping: 0.85,
      },
    },
    series: [
      {
        type: "surface",
        data: data,
        dataShape: dataShape,
        shading: "lambert",
        wireframe: {
          show: true,
          lineStyle: { color: "rgba(0,0,0,0.12)", width: 0.8 },
        },
        itemStyle: { opacity: 0.96 },
      },
    ],
  }, { notMerge: true });
  patchOppositeAxes(chart);
}

function hexToRgb(hex) {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}
const NOISESCAPE_STOPS = NOISESCAPE_COLORS.map(hexToRgb);
// greyscale twin of the ramps above — marks the cell of the actual day+hour
const GREY_STOPS = ["#f4f4f4", "#c8c8c8", "#8a8a8a", "#3d3d3d"].map(hexToRgb);
// greyscale loudness bands: audible, loud, very loud (louder = darker)
const NOW_BANDS = ["#b3b3b3", "#7a7a7a", "#333333"];

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
    // slot 7: 1 = cell of the actual day+hour → greyscale instead of color
    const nowCell = api.value(7) === 1;
    const g = 1; // gap between cells
    let bgFill = "#eaeef2";
    if (bg === "hours-violet") {
      const hr = hourList ? hourList[v0] : v0;
      if (nowCell) bgFill = "#ebebeb";           // actual hour: neutral grey
      else if (hr !== undefined && (hr >= 22 || hr <= 6)) bgFill = "#f3e8ff";
      else bgFill = "#e3f7e8";   // 07-22: light green
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
    if (typeof v3 === "number" && typeof v4 === "number" && typeof v5 === "number") {
      // three-band stack: green audible base, yellow loud middle, red very-loud top
      const bH = unit * (v3 / maxN);
      const yH = unit * (v4 / maxN);
      const rH = unit * (v5 / maxN);
      // any non-zero band gets a minimum visible sliver (a 1-episode cell
      // must not vanish next to the busiest cell of the shared scale)
      const MIN_SEG = 1.5;
      const segs = [
        [v3 > 0 ? Math.max(bH, MIN_SEG) : bH,
         nowCell ? NOW_BANDS[0] : typeof v6 === "string" ? v6 : "#1a7f37"],
        [v4 > 0 ? Math.max(yH, MIN_SEG) : yH, nowCell ? NOW_BANDS[1] : "#f59f00"],
        [v5 > 0 ? Math.max(rH, MIN_SEG) : rH, nowCell ? NOW_BANDS[2] : "#cf222e"],
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
  const now = new Date();
  const p2 = n => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  const nowH = now.getHours();
  const days = [...new Set(rows.map(r => r[0]).filter(ds => ds >= FROM_DATE))].sort();
  const lookup = new Map(rows.map(([ds, h, b, y, r]) => [`${ds}-${h}`, [b, y, r]]));
  const data = [];
  days.forEach((ds, yi) => {
    for (const h of hourList) {
      const x = hourList.indexOf(h);
      const [b, y, r] = lookup.get(`${ds}-${h}`) ?? [0, 0, 0];
      // audible base segment: violet at night (22-07), green by day
      const baseCol = (h >= 22 || h <= 6) ? "#8b5cf6" : "#1a7f37";
      // slot 8: greyscale marker for the actual day+hour cell
      data.push([x, yi, b + y + r, b, y, r, baseCol,
                 ds === today && h === nowH ? 1 : 0]);
    }
  });
  const maxN = maxNOverride ?? Math.max(...data.map(d2 => d2[2]), 1);
  const labels = dayLabels(days);
  const el = document.getElementById(id);
  el.style.height = `${Math.max(640, days.length * 28 + 42)}px`;
  const chart = mkChart(id);
  chart.setOption({
    animation: false,
    grid: { left: 86, right: 16, top: 26, bottom: 16 },
    tooltip: {
      formatter: p => `${labels[p.value[1]]}, ${hours[p.value[0]]}:00\u2013${hours[p.value[0]]}:59<br>` +
                      `<b>${p.value[2]}</b> events`,
    },
    xAxis: { type: "category", data: hours, position: "top" },
    yAxis: { type: "category", data: labels, axisLabel: { color: "#57606a", interval: 0 } },
    series: [{ type: "custom", encode: { x: 0, y: 1 }, data,
               renderItem: fillCellsRender(maxN, showText, "hours-violet", hourList) }],
  });
  chart.resize();
}

function formatDaySelector(ds) {
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const [y, m, dd] = ds.split("-");
  const wd = WD[new Date(+y, +m - 1, +dd).getDay()];
  const day = String(dd).padStart(2, "0");
  const mon = String(m).padStart(2, "0");
  const yr = String(y).slice(-2);
  return `${wd} ${day}.${mon}.${yr}`;
}

let day3wHeatRows = [];
let day3wWheelAt = 0;
let day3wGlobalMax = null;
const day3wCache = {};

function getFilterMembers(filterName) {
  if (filterName === "Vehicles") {
    return (state.groupMembers.Motor || []).join(";");
  }
  if (filterName === "Speech") {
    const all = Object.values(state.groupMembers).flat();
    const speech = all.filter(c => /speech|conversation|voice|whisper|shout|yell|scream|chatter|talk/i.test(c));
    return (speech.length ? speech : ["Speech"]).join(";");
  }
  // "All" (non-background)
  return Object.entries(state.groupMembers)
    .filter(([g]) => !EXCLUDED_GROUPS.has(g))
    .flatMap(([, m]) => m).join(";");
}

function getDayHour(ds, hData) {
  const [y, m, dd] = ds.split("-");
  const d = new Date(Date.UTC(+y, +m - 1, +dd, hData, 0, 0));
  const p2 = n => String(n).padStart(2, "0");
  const dateStr = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  const hour = d.getUTCHours();
  return { dateStr, hour, ts: d.getTime() };
}

async function fetchDay3wRows(filterName) {
  if (day3wCache[filterName]) return day3wCache[filterName];
  const p = sinceOct4Params();
  const from = p.from - 86400 * 2;
  const members = getFilterMembers(filterName);
  const heat = await get("/api/hourly", { ...p, from, event: members, by: "daybands" });
  day3wCache[filterName] = heat.rows;
  return heat.rows;
}

function updateDaySelectorUI() {
  const sel = document.getElementById("day3w-select");
  const prevBtn = document.getElementById("day3w-prev");
  const nextBtn = document.getElementById("day3w-next");
  if (!sel) return;
  if (prevBtn) prevBtn.disabled = sel.selectedIndex >= sel.options.length - 1;
  if (nextBtn) nextBtn.disabled = sel.selectedIndex <= 0;
}

function stepDay(delta) {
  const sel = document.getElementById("day3w-select");
  if (!sel || !sel.options.length) return;
  const newIdx = sel.selectedIndex + delta;
  if (newIdx >= 0 && newIdx < sel.options.length) {
    sel.selectedIndex = newIdx;
    state.selectedDay3w = sel.value;
    updateDaySelectorUI();
    renderDaySpline(state.selectedDay3w);
  }
}

// spline chart for a single selected day, 3 loudness bands
function renderDaySpline(ds) {
  if (!ds) return;

  const now = new Date();
  const p2 = n => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  const nowH = now.getHours();
  const lookup = new Map(day3wHeatRows.map(([d, h, b, y, r, bc, yc, rc]) => [`${d}-${h}`, [b, y, r, bc, yc, rc]]));
  const label = formatDaySelector(ds);
  const filter = state.selectedFilter3w || "All";
  const filterSuffix = filter !== "All" ? ` \u00B7 ${filter}` : "";

  const [y, m, dd] = ds.split("-");
  const prevD = new Date(Date.UTC(+y, +m - 1, +dd - 1));
  const prevDay = `${prevD.getUTCFullYear()}-${p2(prevD.getUTCMonth() + 1)}-${p2(prevD.getUTCDate())}`;
  const prevLabel = formatDaySelector(prevDay);

  const t0 = Date.UTC(+y, +m - 1, +dd, 0, 0, 0);
  const tEnd = t0 + 24 * 3600 * 1000;

  const earliestDate = day3wHeatRows.length ? day3wHeatRows.map(r => r[0]).sort()[0] : FROM_DATE;

  const BUFFER = 4; // buffer hours before & after for seamless spline curvature across day boundaries
  const audible = [], loud = [], veryLoud = [];
  for (let hTick = -BUFFER; hTick <= 24 + BUFFER; hTick++) {
    const t = t0 + hTick * 3600 * 1000;
    const hData = hTick - 1;
    const { dateStr, hour } = getDayHour(ds, hData);

    const isFuture = dateStr > today || (dateStr === today && hour >= nowH);
    const isPrior = dateStr < earliestDate;

    if (isFuture || isPrior) {
      if (hTick >= 0 && hTick <= 24) {
        audible.push([t, null, null]);
        loud.push([t, null, null]);
        veryLoud.push([t, null, null]);
      }
    } else {
      const [b, yVal, r, bc, yc, rc] = lookup.get(`${dateStr}-${hour}`) ?? [0, 0, 0, 0, 0, 0];
      audible.push([t, b, bc]);
      loud.push([t, yVal, yc]);
      veryLoud.push([t, r, rc]);
    }
  }

  // Fixed on the global maximum of this view across all dates and categories
  const maxY = day3wGlobalMax || 230;

  const chart = mkChart("day3w-chart");
  chart.setOption({
    animation: false,
    useUTC: true,
    grid: { left: 56, right: 16, top: 18, bottom: 24 },
    tooltip: {
      trigger: "axis",
      formatter: params => {
        const p0 = params[0];
        if (!p0 || !p0.value) return "";
        const ts = p0.value[0];
        const hTick = Math.max(0, Math.min(24, Math.round((ts - t0) / (3600 * 1000))));
        let dateStr, rangeStr;
        if (hTick === 0) {
          dateStr = prevLabel;
          rangeStr = "23:00\u201323:59";
        } else {
          dateStr = label;
          const hStart = String(hTick - 1).padStart(2, "0");
          rangeStr = `${hStart}:00\u2013${hStart}:59`;
        }
        let sumLoad = 0;
        let sumCount = 0;
        const lines = params
          .filter(p => p.value && p.value[1] != null)
          .map(p => {
            const v = Number(p.value[1]) || 0;
            const cnt = Number(p.value[2]) || 0;
            sumLoad += v;
            sumCount += cnt;
            const epStr = `${cnt} ${cnt === 1 ? "episode" : "episodes"}`;
            return `${p.marker}${p.seriesName}: <b>${v.toFixed(1)}</b> (${epStr})`;
          });
        if (!lines.length) return `${dateStr}${filterSuffix}, ${rangeStr}`;
        const totalLoadStr = (Math.round(sumLoad * 10) / 10).toFixed(1);
        const totalEpStr = `${sumCount} ${sumCount === 1 ? "episode" : "episodes"}`;
        return `${dateStr}${filterSuffix}, ${rangeStr} (noise level <b>${totalLoadStr}</b> \u00B7 <b>${totalEpStr}</b>)<br>` + lines.join("<br>");
      },
    },
    xAxis: {
      type: "time",
      min: t0,
      max: tEnd,
      splitNumber: 24,
      interval: 3600 * 1000,
      minInterval: 3600 * 1000,
      maxInterval: 3600 * 1000,
      axisLabel: {
        showMinLabel: true,
        showMaxLabel: true,
        hideOverlap: false,
        formatter: (val) => {
          if (Math.abs(val - tEnd) < 60000) return "24";
          const d = new Date(val);
          return String(d.getUTCHours()).padStart(2, "0");
        },
        color: "#57606a",
        fontSize: 11,
      },
      splitLine: { show: true, lineStyle: { color: "#eaeef2" } },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: maxY,
      axisLabel: { color: "#57606a", fontSize: 11 },
      splitLine: { lineStyle: { color: "#eaeef2" } },
    },
    series: [
      {
        name: "Audible (<62 dB)",
        type: "line",
        stack: "bands",
        smooth: true,
        clip: true,
        showSymbol: false,
        encode: { x: 0, y: 1 },
        data: audible,
        itemStyle: { color: "#1a7f37" },
        lineStyle: { width: 2, color: "#1a7f37" },
        areaStyle: { color: "rgba(26,127,55,0.28)" },
        markArea: {
          silent: true,
          itemStyle: { color: "rgba(139,92,246,0.07)" },
          data: [
            [{ xAxis: t0 }, { xAxis: t0 + 7 * 3600 * 1000 }],
            [{ xAxis: t0 + 22 * 3600 * 1000 }, { xAxis: tEnd }],
          ],
        },
      },
      {
        name: "Loud (62\u201367 dB)",
        type: "line",
        stack: "bands",
        smooth: true,
        clip: true,
        showSymbol: false,
        encode: { x: 0, y: 1 },
        data: loud,
        itemStyle: { color: "#f59f00" },
        lineStyle: { width: 2, color: "#f59f00" },
        areaStyle: { color: "rgba(245,159,0,0.32)" },
      },
      {
        name: "Very loud (\u226567 dB)",
        type: "line",
        stack: "bands",
        smooth: true,
        clip: true,
        showSymbol: false,
        encode: { x: 0, y: 1 },
        data: veryLoud,
        itemStyle: { color: "#cf222e" },
        lineStyle: { width: 2, color: "#cf222e" },
        areaStyle: { color: "rgba(207,34,46,0.35)" },
      },
    ],
  }, true);
  chart.resize();
}

async function loadDay3w() {
  await loadCounts();  // fills state.groupMembers
  state.selectedFilter3w = state.selectedFilter3w || "All";

  // Preload "All" so the view's global maximum is always known and fixed
  const allRows = await fetchDay3wRows("All");
  day3wGlobalMax = Math.ceil(Math.max(5, ...allRows.filter(r => r[0] >= FROM_DATE).map(([, , b, y, r]) => b + y + r)));

  const filterSel = document.getElementById("day3w-filter");
  if (filterSel) {
    filterSel.value = state.selectedFilter3w;
    const onFilterChange = async () => {
      state.selectedFilter3w = filterSel.value;
      day3wHeatRows = await fetchDay3wRows(state.selectedFilter3w);
      renderDaySpline(state.selectedDay3w);
    };
    filterSel.onchange = onFilterChange;
    filterSel.oninput = onFilterChange;
  }

  day3wHeatRows = await fetchDay3wRows(state.selectedFilter3w);

  const filtered = day3wHeatRows.filter(r => r[0] >= FROM_DATE);
  const days = [...new Set(filtered.map(r => r[0]))].sort().reverse();

  const sel = document.getElementById("day3w-select");
  const prevBtn = document.getElementById("day3w-prev");
  const nextBtn = document.getElementById("day3w-next");
  const chartEl = document.getElementById("day3w-chart");

  if (sel) {
    const current = sel.value || state.selectedDay3w || days[0];
    sel.innerHTML = "";
    days.forEach(ds => {
      const opt = document.createElement("option");
      opt.value = ds;
      opt.textContent = formatDaySelector(ds);
      sel.appendChild(opt);
    });
    if (days.includes(current)) {
      sel.value = current;
    } else if (days.length > 0) {
      sel.value = days[0];
    }
    state.selectedDay3w = sel.value;

    const onSelectChange = () => {
      state.selectedDay3w = sel.value;
      updateDaySelectorUI();
      renderDaySpline(state.selectedDay3w);
    };

    sel.onchange = onSelectChange;
    sel.oninput = onSelectChange;

    sel.onkeydown = e => {
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        stepDay(1); // older day
      } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        stepDay(-1); // newer day
      }
    };

    sel.onwheel = e => {
      const now = Date.now();
      if (now - day3wWheelAt < 160) return;
      if (e.deltaX > 15 || e.deltaY > 15) {
        day3wWheelAt = now;
        e.preventDefault();
        stepDay(1); // older day
      } else if (e.deltaX < -15 || e.deltaY < -15) {
        day3wWheelAt = now;
        e.preventDefault();
        stepDay(-1); // newer day
      }
    };
  }

  if (prevBtn) prevBtn.onclick = () => stepDay(1);
  if (nextBtn) nextBtn.onclick = () => stepDay(-1);

  if (chartEl && !chartEl.dataset.dragBound) {
    chartEl.dataset.dragBound = "1";
    let startX = null;
    let startY = null;
    chartEl.addEventListener("pointerdown", e => {
      startX = e.clientX;
      startY = e.clientY;
    });
    chartEl.addEventListener("pointerup", e => {
      if (startX === null) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      startX = null;
      startY = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        if (dx > 0) stepDay(1);   // dragged right -> older day
        else stepDay(-1);         // dragged left -> newer day
      }
    });
    chartEl.addEventListener("wheel", e => {
      if (Math.abs(e.deltaX) > 20 && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const now = Date.now();
        if (now - day3wWheelAt < 160) return;
        day3wWheelAt = now;
        e.preventDefault();
        if (e.deltaX > 20) stepDay(-1);
        else stepDay(1);
      }
    }, { passive: false });
  }

  updateDaySelectorUI();
  renderDaySpline(state.selectedDay3w || days[0]);
}

function drawDayLoad(id, rows, maxLoad) {
  // rows: [date, hour, v]; one row per day from Oct 4th onwards, newest on top
  const hourList = hourCols();
  const hours = hourList.map(h => String(h).padStart(2, "0"));
  const hourIdx = new Map(hourList.map((h, i) => [h, i]));
  const days = [...new Set(rows.map(r => r[0]).filter(ds => ds >= FROM_DATE))].sort();
  const lookup = new Map(rows.map(([ds, h, v]) => [`${ds}-${h}`, v]));
  // cell of the actual day+hour → greyscale ramp instead of color
  const now = new Date();
  const p2 = n => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  const nowH = now.getHours();
  const data = [];
  days.forEach((ds, yi) => {
    for (const h of hourList) {
      const v = lookup.get(`${ds}-${h}`) ?? 0;
      const isNow = ds === today && +h === nowH;
      const stops = isNow ? GREY_STOPS : NOISESCAPE_STOPS;
      const t = Math.min(Math.max((v / maxLoad) * (stops.length - 1), 0), stops.length - 1.001);
      const seg = Math.floor(t), f = t - seg;
      const c = stops[seg].map((x, i2) => Math.round(x + (stops[seg + 1][i2] - x) * f));
      data.push({
        value: [hourIdx.get(+h), yi, v],
        itemStyle: { color: `rgb(${c[0]},${c[1]},${c[2]})` },
      });
    }
  });
  const labels = dayLabels(days);
  const el = document.getElementById(id);
  el.style.height = `${Math.max(640, days.length * 28 + 42)}px`;
  const chart = mkChart(id);
  chart.setOption({
    animation: false,
    grid: { left: 86, right: 16, top: 26, bottom: 16 },
    tooltip: {
      formatter: p => `${labels[p.value[1]]}, ${hours[p.value[0]]}:00\u2013${hours[p.value[0]]}:59<br>` +
                      `noise level <b>${p.value[2]}</b>`,
    },
    xAxis: { type: "category", data: hours, position: "top" },
    yAxis: { type: "category", data: labels, axisLabel: { color: "#57606a", interval: 0 } },
    series: [{ type: "heatmap", data }],
  });
  chart.resize();
}

// one pooled grid: all noise types together, one row per day from Oct 4th onwards
async function loadHeatmapView() {
  const p = sinceOct4Params();
  await loadCounts();  // fills state.groupMembers
  stopWeekdayCycle();
  const cont = document.getElementById("heatmap-list");
  disposeChartsIn(cont);
  cont.innerHTML = "";
  // every non-Background class, ";"-joined for the API
  const members = Object.entries(state.groupMembers)
    .filter(([g]) => !EXCLUDED_GROUPS.has(g))
    .flatMap(([, m]) => m).join(";");
  const div = document.createElement("div");
  div.id = "hm-all";
  div.className = "chart";
  cont.append(div);
  const heat = await get("/api/hourly", { ...p, event: members, by: "dayload" });
  const maxLoad = Math.max(1, ...heat.rows.map(x => x[2]));
  drawDayLoad("hm-all", heat.rows, maxLoad);
}

/* ---------------------------------------------------------- view switching */

const VIEW_LOADERS = {
  heatmap: loadHeatmapView,
  day3w: loadDay3w,
  threed: loadThreed,
  live: loadLive,
  readme: async () => {},  // static content, nothing to load
};
let activeView = "day3w";

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
  window.scrollTo(0, 0);
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
  window.addEventListener("resize", () => Object.values(charts).forEach(c => c.resize()));

  await showView("day3w");
  // only the Last-5-min strip auto-refreshes; all other views load on entry
  setInterval(() => {
    if (activeView === "live") loadLive().catch(console.error);
  }, 5000);
  // keep the "last backup" footer date current + pick up UI deploys
  setInterval(() => { loadMeta(); checkUiDeploy(); }, 60000);
}

boot().catch(console.error);
