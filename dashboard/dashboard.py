#!/usr/bin/env python3
"""Noise dashboard: serves an interactive web UI over the JSONL logs.

A background thread tails spl.jsonl / events.jsonl into a SQLite database
(disposable derived index; JSONL stays the source of truth). FastAPI serves
aggregate/range queries plus a static single-page UI (vendored ECharts, no
CDN, works fully offline).
"""

import contextlib
import json
import math
import os
import re
import sqlite3
import threading
import time
from datetime import datetime

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

LOG_DIR = os.environ.get("LOG_DIR", "/data/logs")
DB_PATH = os.environ.get("DB_PATH", os.path.join(LOG_DIR, "dashboard.db"))
INGEST_INTERVAL = float(os.environ.get("INGEST_INTERVAL", "2"))
# mirror of the analyzer's filter; keeps historical JSONL lines out of the
# index on rebuilds. Separator ";" (AudioSet names can contain commas).
EVENT_BLOCKLIST = {
    s.strip() for s in os.environ.get("EVENT_BLOCKLIST", "").split(";") if s.strip()
}
PORT = int(os.environ.get("PORT", "8080"))
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS spl (
  ts    REAL PRIMARY KEY,
  spl   REAL, spl_min REAL, spl_max REAL,
  low   REAL, mid REAL, high REAL
);
CREATE TABLE IF NOT EXISTS events (
  ts REAL, event TEXT, confidence REAL, spl REAL, duration REAL,
  spl_peak REAL,
  UNIQUE(ts, event)
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_event_ts ON events(event, ts);
CREATE INDEX IF NOT EXISTS idx_events_peak ON events(spl_peak);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


def parse_ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError):
        return None


def connect():
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=5000")
    return con


# ---------------------------------------------------------------- ingester

def tail_file(con, name, insert_sql, row_fn):
    """Append complete new lines from LOG_DIR/name into the DB. Idempotent
    (INSERT OR IGNORE + stored offsets), handles rotation/truncation."""
    path = os.path.join(LOG_DIR, name)
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return

    off_key, ino_key = f"offset:{name}", f"inode:{name}"
    meta = dict(con.execute("SELECT key, value FROM meta").fetchall())
    offset = int(meta.get(off_key, "0"))
    inode = int(meta.get(ino_key, "-1"))
    if st.st_ino != inode or st.st_size < offset:
        offset = 0  # rotated/truncated: re-ingest from scratch
        if name == "events.jsonl":
            _last_episode["ts"] = 0.0  # replay collapses episodes the same way

    rows, new_offset = [], offset
    with open(path, "rb") as f:
        f.seek(offset)
        while True:
            data = f.read(1 << 20)
            if not data:
                break
            nl = data.rfind(b"\n")
            if nl < 0:
                break  # no complete line yet
            for line in data[:nl].split(b"\n"):
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                row = row_fn(e)
                if row:
                    rows.append(row)
            new_offset = f.tell() - (len(data) - nl - 1)
            if len(data) < (1 << 20):
                break

    if rows:
        con.executemany(insert_sql, rows)
    con.execute(
        "INSERT OR REPLACE INTO meta VALUES (?, ?)", (off_key, str(new_offset))
    )
    con.execute(
        "INSERT OR REPLACE INTO meta VALUES (?, ?)", (ino_key, str(st.st_ino))
    )
    con.commit()
    return len(rows)


def spl_row(e):
    ts = parse_ts(e.get("ts"))
    b = e.get("bands") or {}
    if ts is None or e.get("spl_db") is None:
        return None
    return (
        ts,
        e.get("spl_db"),
        e.get("spl_db_min"),
        e.get("spl_db_max"),
        b.get("low"),
        b.get("mid"),
        b.get("high"),
    )


# episodes: mirror of the analyzer's collapse — when re-indexing historical
# JSONL, keep only the first event of each acoustic episode (bursts of nested
# classes within EPISODE_REFRACTORY seconds count as one event)
EPISODE_REFRACTORY = float(os.environ.get("EPISODE_REFRACTORY", "10.0"))
_last_episode = {"ts": 0.0, "init": False}


def event_row(e):
    global _last_episode
    if not _last_episode["init"]:
        con = connect()
        try:
            row = con.execute("SELECT MAX(ts) FROM events").fetchone()
            _last_episode["ts"] = row[0] or 0.0
        finally:
            con.close()
        _last_episode["init"] = True
    ts = parse_ts(e.get("ts"))
    if ts is None or not e.get("event"):
        return None
    if e["event"] in EVENT_BLOCKLIST:
        return None
    if ts - _last_episode["ts"] < EPISODE_REFRACTORY:
        return None  # belongs to the previous episode
    _last_episode["ts"] = ts
    dur = e.get("duration_s")
    return (ts, e["event"], e.get("confidence"), e.get("spl_db"),
            float(dur) if dur is not None else None, e.get("spl_db_max"))


def ingester(stop):
    con = connect()
    con.executescript(SCHEMA)
    # migrate pre-duration databases
    cols = [r[1] for r in con.execute("PRAGMA table_info(events)")]
    if "duration" not in cols:
        con.execute("ALTER TABLE events ADD COLUMN duration REAL")
    if "spl_peak" not in cols:
        con.execute("ALTER TABLE events ADD COLUMN spl_peak REAL")
    con.commit()
    backfill_peaks(con)
    while not stop.is_set():
        try:
            n1 = tail_file(
                con,
                "spl.jsonl",
                "INSERT OR IGNORE INTO spl VALUES (?,?,?,?,?,?,?)",
                spl_row,
            )
            n2 = tail_file(
                con,
                "events.jsonl",
                "INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?)",
                event_row,
            )
            if n1 or n2:
                print(f"ingested {n1 or 0} spl, {n2 or 0} events", flush=True)
        except Exception as exc:
            print(f"ingest error: {exc!r}", flush=True)
        stop.wait(INGEST_INTERVAL)


# --------------------------------------------------------------------- API


def backfill_peaks(con):
    """Episodes logged before the analyzer wrote spl_db_max: derive the peak
    from the per-second maxima in the spl table over [ts, ts + duration].
    Runs at boot and only touches NULLs, so it self-heals after upgrades."""
    n = con.execute(
        """
        UPDATE events SET spl_peak = (
            SELECT MAX(spl_max) FROM spl
            WHERE spl.ts >= events.ts
              AND spl.ts <= events.ts + COALESCE(events.duration, 0)
        )
        WHERE spl_peak IS NULL AND duration IS NOT NULL
        """
    ).rowcount
    con.commit()
    if n:
        print(f"backfilled spl_peak for {n} episodes", flush=True)

_stop = threading.Event()


@contextlib.asynccontextmanager
async def lifespan(_app):
    con = connect()
    con.executescript(SCHEMA)
    con.close()
    t = threading.Thread(target=ingester, args=(_stop,), daemon=True)
    t.start()
    wd = threading.Thread(target=weekday_recalculator, args=(_stop,), daemon=True)
    wd.start()
    yield
    _stop.set()


app = FastAPI(title="noise-dashboard", lifespan=lifespan)


def q(sql, params=()):
    con = connect()
    try:
        return con.execute(sql, params).fetchall()
    finally:
        con.close()


def columnar(rows):
    if not rows:
        return {"t": [], "avg": [], "min": [], "max": [], "low": [], "mid": [], "high": []}
    cols = list(zip(*rows))
    return {
        "t": list(cols[0]),
        "avg": list(cols[1]),
        "min": list(cols[2]),
        "max": list(cols[3]),
        "low": list(cols[4]),
        "mid": list(cols[5]),
        "high": list(cols[6]),
    }


@app.get("/api/range")
def api_range():
    spl = q("SELECT MIN(ts), MAX(ts), COUNT(*) FROM spl")[0]
    ev = q("SELECT MIN(ts), MAX(ts), COUNT(*) FROM events")[0]
    return {
        "spl": {"min": spl[0], "max": spl[1], "count": spl[2]},
        "events": {"min": ev[0], "max": ev[1], "count": ev[2]},
        "now": time.time(),
    }


@app.get("/api/spl")
def api_spl(
    from_: float = Query(alias="from"),
    to: float = Query(...),
    points: int = Query(default=600, le=5000),
):
    bucket = max(1.0, (to - from_) / points)
    rows = q(
        """
        SELECT CAST(ts / :b AS INTEGER) * :b AS t,
               ROUND(AVG(spl), 2), ROUND(MIN(spl_min), 2), ROUND(MAX(spl_max), 2),
               ROUND(AVG(low), 2), ROUND(AVG(mid), 2), ROUND(AVG(high), 2)
        FROM spl
        WHERE ts BETWEEN :f AND :t
        GROUP BY t ORDER BY t
        """,
        {"b": bucket, "f": from_, "t": to},
    )
    out = columnar(rows)
    out["bucket"] = bucket
    return out


@app.get("/api/live")
def api_live(secs: float = Query(default=300, le=3600)):
    since = time.time() - secs
    rows = q(
        "SELECT ts, spl, spl_min, spl_max, low, mid, high FROM spl "
        "WHERE ts >= ? ORDER BY ts",
        (since,),
    )
    out = {
        "t": [r[0] for r in rows],
        "spl": [r[1] for r in rows],
        "min": [r[2] for r in rows],
        "max": [r[3] for r in rows],
        "low": [r[4] for r in rows],
        "mid": [r[5] for r in rows],
        "high": [r[6] for r in rows],
        "events": [],
    }
    if rows:
        ev = q(
            "SELECT ts, event, confidence, spl FROM events WHERE ts >= ? ORDER BY ts",
            (rows[0][0],),
        )
        out["events"] = [
            {"t": r[0], "event": r[1], "confidence": r[2], "spl": r[3]} for r in ev
        ]
    return out


@app.get("/api/events")
def api_events(
    from_: float = Query(alias="from"),
    to: float = Query(...),
    classes: str = Query(default=""),
    limit: int = Query(default=20000, le=50000),
):
    sql = "SELECT ts, event, confidence, spl FROM events WHERE ts BETWEEN :f AND :t"
    params = {"f": from_, "t": to}
    cls = [c for c in classes.split(",") if c]
    if cls:
        sql += " AND event IN (%s)" % ",".join(f":c{i}" for i in range(len(cls)))
        params.update({f"c{i}": c for i, c in enumerate(cls)})
    sql += " ORDER BY ts LIMIT :lim"
    params["lim"] = limit
    rows = q(sql, params)
    return {
        "t": [r[0] for r in rows],
        "event": [r[1] for r in rows],
        "confidence": [r[2] for r in rows],
        "spl": [r[3] for r in rows],
        "truncated": len(rows) >= limit,
    }


@app.get("/api/counts")
def api_counts(from_: float = Query(alias="from"), to: float = Query(...)):
    rows = q(
        "SELECT event, COUNT(*) FROM events WHERE ts BETWEEN ? AND ? "
        "GROUP BY event ORDER BY COUNT(*) DESC",
        (from_, to),
    )
    return {"classes": [r[0] for r in rows], "counts": [r[1] for r in rows]}


@app.get("/api/hourly")
def api_hourly(
    from_: float = Query(alias="from"),
    to: float = Query(...),
    event: str = Query(default=""),
    by: str = Query(default="weekday"),
    min_db: float = Query(default=-45),
):
    sql = "FROM events WHERE ts BETWEEN :f AND :t"
    params = {"f": from_, "t": to}
    evs = [e.strip() for e in event.split(";") if e.strip()]
    if evs:
        # ";"-separated: AudioSet display names may contain commas
        sql += " AND event IN (%s)" % ",".join(f":ev{i}" for i in range(len(evs)))
        params.update({f"ev{i}": e for i, e in enumerate(evs)})

    if by == "day":
        rows = q(
            """
            SELECT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime'),
                   CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER),
                   COUNT(*), ROUND(AVG(spl), 1), ROUND(MAX(spl), 1),
                   SUM(CASE WHEN COALESCE(spl, -999) >= :mindb THEN 1 ELSE 0 END)
            """ + sql + " GROUP BY 1, 2 ORDER BY 1",
            {**params, "mindb": min_db},
        )
        return {"rows": [[r[0], r[1], r[2], r[3], r[4], r[5]] for r in rows]}

    if by == "daybands":
        # audible (<= BAND_LOUD), loud (BAND_LOUD..BAND_VERY), very loud (>= BAND_VERY)
        # bands key off the episode's strict peak level (spl_peak; falls back
        # to the confidence-moment spl for legacy rows without a peak)
        rows = q(
            """
            SELECT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime'),
                   CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER),
                   SUM(CASE WHEN COALESCE(COALESCE(spl_peak, spl), -999) < :b1 THEN 1 ELSE 0 END),
                   SUM(CASE WHEN COALESCE(COALESCE(spl_peak, spl), -999) >= :b1 AND COALESCE(COALESCE(spl_peak, spl), -999) < :b2 THEN 1 ELSE 0 END),
                   SUM(CASE WHEN COALESCE(COALESCE(spl_peak, spl), -999) >= :b2 THEN 1 ELSE 0 END)
            """ + sql + " GROUP BY 1, 2 ORDER BY 1",
            {**params, "b1": BAND_LOUD, "b2": BAND_VERY},
        )
        return {"rows": [[r[0], r[1], r[2], r[3], r[4]] for r in rows]}

    if by == "week":
        rows = q(
            "SELECT strftime('%H', ts, 'unixepoch', 'localtime'), ts " + sql +
            " ORDER BY ts",
            params,
        )
        agg = {}
        for hour_s, ts in rows:
            iso = datetime.fromtimestamp(ts).isocalendar()
            key = (iso[0], iso[1], int(hour_s))
            agg[key] = agg.get(key, 0) + 1
        return {"rows": [[y, w, h, n] for (y, w, h), n in sorted(agg.items())]}

    rows = q(
        """
        SELECT CAST(strftime('%w', ts, 'unixepoch', 'localtime') AS INTEGER),
               CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER),
               COUNT(*)
        """ + sql + " GROUP BY 1, 2",
        params,
    )
    # divide by how often each weekday occurred in the range (coverage from
    # the continuous SPL log), so partially-recorded weekdays don't over-weight
    days = q(
        """
        SELECT CAST(strftime('%w', ts, 'unixepoch', 'localtime') AS INTEGER),
               COUNT(DISTINCT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime'))
        FROM spl WHERE ts BETWEEN :f AND :t GROUP BY 1
        """,
        params,
    )
    coverage = {wd: n for wd, n in days}
    return {
        "cells": [
            [wd, h, round(n / coverage.get(wd, 1), 1)] for wd, h, n in rows
        ]
    }


@app.get("/api/weekcounts")
def api_weekcounts(
    from_: float = Query(alias="from"),
    to: float = Query(...),
    split_db: float = Query(default=None),
    hourly: int = Query(default=0),
    min_db: float = Query(default=-45),
):
    """[weekday 0=Sun, class, count] over the range — for the 3D distribution.
    With split_db: [weekday, class, count_below, count_above] instead.
    With hourly: [weekday, hour, class, count]."""
    if hourly:
        rows = q(
            """
            SELECT CAST(strftime('%w', ts, 'unixepoch', 'localtime') AS INTEGER),
                   CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER),
                   event, COUNT(*), ROUND(AVG(spl), 1), ROUND(MAX(spl), 1),
                   ROUND(SUM(duration), 1),
                   SUM(CASE WHEN COALESCE(spl, -999) >= :mindb THEN 1 ELSE 0 END)
            FROM events WHERE ts BETWEEN :f AND :t
            GROUP BY 1, 2, 3
            """,
            {"f": from_, "t": to, "mindb": min_db},
        )
        return {"rows": [[r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]] for r in rows]}
    if split_db is None:
        rows = q(
            """
            SELECT CAST(strftime('%w', ts, 'unixepoch', 'localtime') AS INTEGER),
                   event, COUNT(*)
            FROM events WHERE ts BETWEEN ? AND ?
            GROUP BY 1, 2
            """,
            (from_, to),
        )
        return {"rows": [[r[0], r[1], r[2]] for r in rows]}
    rows = q(
        """
        SELECT CAST(strftime('%w', ts, 'unixepoch', 'localtime') AS INTEGER),
               event,
               SUM(CASE WHEN COALESCE(spl, -999) < :db THEN 1 ELSE 0 END),
               SUM(CASE WHEN COALESCE(spl, -999) >= :db THEN 1 ELSE 0 END)
        FROM events WHERE ts BETWEEN :f AND :t
        GROUP BY 1, 2
        """,
        {"f": from_, "t": to, "db": split_db},
    )
    return {"rows": [[r[0], r[1], r[2], r[3]] for r in rows]}


@app.get("/api/loudest")
def api_loudest(
    from_: float = Query(alias="from"),
    to: float = Query(...),
    event: str = Query(default=""),
    min_db: float = Query(default=-999),
    limit: int = Query(default=50000, le=50000),
):
    """All episodes in the window, loudest first. event: ";"-separated
    class names to restrict the ranking (AudioSet names may contain commas).
    min_db (dBFS): only episodes whose peak level (fallback: spl) reached
    it; the returned level column is that peak."""
    sql = ("SELECT ts, event, confidence, COALESCE(spl_peak, spl), duration "
           "FROM events "
           "WHERE ts BETWEEN :f AND :t AND spl IS NOT NULL "
           "AND COALESCE(spl_peak, spl) >= :mindb")
    params = {"f": from_, "t": to, "mindb": min_db}
    evs = [e.strip() for e in event.split(";") if e.strip()]
    if evs:
        sql += " AND event IN (%s)" % ",".join(f":ev{i}" for i in range(len(evs)))
        params.update({f"ev{i}": e for i, e in enumerate(evs)})
    sql += " ORDER BY 4 DESC LIMIT :lim"
    params["lim"] = limit
    rows = q(sql, params)
    return {"rows": [[r[0], r[1], r[2], r[3], r[4]] for r in rows]}


@app.get("/api/classdist")
def api_classdist(
    from_: float = Query(alias="from"),
    to: float = Query(...),
):
    """[event, 1dB bucket, nightCount, dayCount] over the range; buckets from
    -60 dBFS up (no upper cap, loud events must not be cut off).
    night = hours 22-06, day = 07-21 (local time)."""
    rows = q(
        """
        SELECT event,
               CAST(spl - 0.5 AS INTEGER) AS bucket_dbfs,
               SUM(CASE WHEN CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER) >= 22
                         OR CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER) <= 6
                        THEN 1 ELSE 0 END),
               SUM(CASE WHEN CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER) >= 7
                         AND CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER) <= 21
                        THEN 1 ELSE 0 END)
        FROM events
        WHERE ts BETWEEN :f AND :t AND spl IS NOT NULL
        GROUP BY 1, 2
        """,
        {"f": from_, "t": to},
    )
    return {"rows": [[r[0], r[1], r[2], r[3]] for r in rows if r[1] >= -60]}


# ---------------------------------------------------------------- weekday cache
# The Weekday view is served from a snapshot that a background thread
# recomputes every RECALC_SECONDS — opening the view costs one cached fetch.

WEEKDAY_RECALC = float(os.environ.get("WEEKDAY_RECALC", "300"))
EXCLUDED_GROUPS = {"Background"}

# mirror of dashboard/static/app.js GROUP_RULES (first match wins, \b prefix)
_GROUP_RULES = [
    ("Other", ["siren", "horn", "honk", "toot", "beep", "bell", "chime", "gong", "toll"]),
    ("Other", ["train", "rail", "tram", "subway", "metro", "locomotive"]),
    ("Other", ["aircraft", "airplane", "helicopter", "jet", "propeller"]),
    ("Other", ["music", "singing", "choir", "guitar", "piano", "organ", "drum", "violin", "cello", "orchestra", "flute", "trumpet", "trombone", "brass", "woodwind", "saxophone", "clarinet", "harp", "banjo", "mandolin", "marimba", "xylophone", "percussion", "timpani", "instrument", "opera", "techno", "jazz", "reggae"]),
    ("Motor", ["motor vehicle", "motorcycle", "car", "truck", "bus", "vehicle", "engine", "idling", "skidding", "accelerating", "revving", "vroom", "traffic", "tire", "brake", "driv"]),
    ("Human", ["speech", "conversation", "voice", "whisper", "shout", "yell", "scream", "cry", "sob", "whimper", "sigh", "gasp", "snor", "breath", "cough", "sneeze", "hiccup", "chatter", "crowd", "laugh", "giggle", "baby", "child", "kid", "talk", "man", "woman", "male", "female", "human"]),
    ("Human", ["bird", "pigeon", "dove", "crow", "caw", "coo", "chirp", "tweet", "owl", "hoot", "gull", "raven", "magpie", "wings", "duck", "goose", "animal", "cat", "meow", "purr", "caterwaul", "dog", "bark", "yip", "howl", "growl", "pets", "rodent", "insect", "bee", "wasp", "fly", "cricket", "frog", "snake", "fox", "horse", "livestock", "farm"]),
    ("Other", ["door", "slam", "glass", "tap", "knock", "clink", "chink", "thump", "thud", "crash", "splash", "camera", "mechanism", "switch", "button"]),
    ("Background", ["silence", "noise", "static", "rumble", "hum", "buzz", "field recording", "environmental", "vibration", "whoosh", "swoosh", "swish", "wind"]),
]
_GROUP_RES = [
    (name, [re.compile(r"\b" + re.escape(k)) for k in keys])
    for name, keys in _GROUP_RULES
]


def group_of(cls):
    c = cls.lower()
    for name, res in _GROUP_RES:
        if any(r.search(c) for r in res):
            return name
    return "Other"


WEEKDAY_CACHE = {"ts": 0.0, "payload": {"groups": [], "grids": {}}}
_weekday_lock = threading.Lock()


# loudness band edges (dB SPL): green audible <= 62, yellow loud 62-67, red very loud >= 67
DB_OFFSET = 106.6                              # calibration (dB SPL - dBFS)
BAND_LOUD = round(62 - DB_OFFSET, 1)           # ~ -44.6 dBFS
BAND_VERY = round(67 - DB_OFFSET, 1)           # ~ -39.6 dBFS
WEEKDAY_THRESHOLDS = [BAND_LOUD, BAND_VERY]


def compute_weekday_cache():
    sum_cols = (
        "SUM(CASE WHEN COALESCE(spl, -999) >= -999 THEN 1 ELSE 0 END) AS tall, "
        + ", ".join(
            f"SUM(CASE WHEN COALESCE(spl, -999) >= {t} THEN 1 ELSE 0 END) AS t{i}"
            for i, t in enumerate(WEEKDAY_THRESHOLDS)
        )
    )
    rows = q(
        f"""
        SELECT CAST(strftime('%w', ts, 'unixepoch', 'localtime') AS INTEGER),
               CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER),
               event, {sum_cols}
        FROM events
        WHERE ts >= strftime('%s', 'now') - 28 * 86400
        GROUP BY 1, 2, 3
        """
    )
    days = q(
        """
        SELECT CAST(strftime('%w', ts, 'unixepoch', 'localtime') AS INTEGER),
               COUNT(DISTINCT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime'))
        FROM spl
        WHERE ts >= strftime('%s', 'now') - 28 * 86400
        GROUP BY 1
        """
    )
    coverage = {wd: n for wd, n in days}
    grids_by_t = {"all": {}, **{str(t): {} for t in WEEKDAY_THRESHOLDS}}
    totals = {"all": {}, **{str(t): {} for t in WEEKDAY_THRESHOLDS}}
    for row in rows:
        wd, h, ev = row[0], row[1], row[2]
        g = group_of(ev)
        if g in EXCLUDED_GROUPS:
            continue
        for i, key in enumerate(["all"] + [str(t) for t in WEEKDAY_THRESHOLDS]):
            n = row[3 + i]
            if not n:
                continue
            grids = grids_by_t[key].setdefault(g, {})
            k = (wd, h)
            grids[k] = grids.get(k, 0) + n
            totals[key][g] = totals[key].get(g, 0) + n
    order = sorted(totals["all"], key=lambda g: -totals["all"][g])
    thresholds = {
        key: {
            g: [[wd, h, round(n / coverage.get(wd, 1), 1)]
                for (wd, h), n in sorted(v.items())]
            for g, v in grids_by_t[key].items()
        }
        for key in grids_by_t
    }
    # noise load per group: episodes x loudness above -60 dBFS noise floor accumulated over 3 weeks
    load_rows = q(
        """
        SELECT CAST(strftime('%w', ts, 'unixepoch', 'localtime') AS INTEGER),
               CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER),
               event, ROUND(SUM(MAX(COALESCE(spl_peak, spl, -60) + 60, 0)), 1)
        FROM events
        WHERE ts >= strftime('%s', 'now') - 21 * 86400
        GROUP BY 1, 2, 3
        """
    )
    load = {}
    for wd, h, ev, v in load_rows:
        g = group_of(ev)
        if g in EXCLUDED_GROUPS:
            continue
        ld = load.setdefault(g, {})
        k = (wd, h)
        ld[k] = ld.get(k, 0) + v
    load_payload = {
        g: [[wd, h, round(v, 1)] for (wd, h), v in sorted(l.items())]
        for g, l in load.items()
    }
    return {"groups": order, "thresholds": thresholds, "load": load_payload}


def weekday_recalculator(stop):
    while not stop.is_set():
        try:
            payload = compute_weekday_cache()
            with _weekday_lock:
                WEEKDAY_CACHE["ts"] = time.time()
                WEEKDAY_CACHE["payload"] = payload
            print("weekday cache recomputed", flush=True)
        except Exception as exc:
            print(f"weekday cache error: {exc!r}", flush=True)
        stop.wait(WEEKDAY_RECALC)


@app.get("/api/weekday")
def api_weekday():
    with _weekday_lock:
        return WEEKDAY_CACHE["payload"]


@app.get("/api/longest")
def api_longest(
    from_: float = Query(alias="from"),
    to: float = Query(...),
    limit: int = Query(default=50000, le=50000),
):
    """Episodes with known duration in the window, longest first."""
    rows = q(
        "SELECT ts, event, duration, spl FROM events "
        "WHERE ts BETWEEN ? AND ? AND duration IS NOT NULL "
        "ORDER BY duration DESC LIMIT ?",
        (from_, to, limit),
    )
    return {"rows": [[r[0], r[1], r[2], r[3]] for r in rows]}


LOUD_EDGES = [-60, -55, -50, -45, -40, -35, -30, -25]  # 5 dB buckets, from -60


@app.get("/api/louddist")
def api_louddist(
    from_: float = Query(alias="from"),
    to: float = Query(...),
    event: str = Query(default=""),
):
    sql = (
        "SELECT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime'), spl "
        "FROM events WHERE ts BETWEEN :f AND :t AND spl IS NOT NULL"
    )
    params = {"f": from_, "t": to}
    evs = [e.strip() for e in event.split(";") if e.strip()]
    if evs:
        sql += " AND event IN (%s)" % ",".join(f":ev{i}" for i in range(len(evs)))
        params.update({f"ev{i}": e for i, e in enumerate(evs)})
    rows = q(sql, params)
    agg = {}
    for day, spl in rows:
        b = min(max(int((spl - LOUD_EDGES[0]) // 5), 0), len(LOUD_EDGES) - 2)
        agg[(day, b)] = agg.get((day, b), 0) + 1
    return {"rows": [[d, b, n] for (d, b), n in sorted(agg.items())]}


@app.get("/api/meta")
def api_meta():
    # sidebar footer: code version (date of the committed code, written by
    # the post-commit hook into version.txt) + date of the
    # last successful off-site backup (epoch marker written by the sync
    # service into the .rclone bind mount)
    def read_text(path):
        try:
            with open(path) as f:
                return f.read().strip()
        except OSError:
            return None

    version = read_text(os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "version.txt"))
    backup = None
    raw = read_text(os.environ.get("BACKUP_STATE", "/backup-state")
                    + "/last-backup")
    if raw:
        try:
            backup = datetime.fromtimestamp(float(raw)).strftime(
                "%d.%m.%Y - %H:%M")
        except (ValueError, OSError, OverflowError):
            backup = None
    return {"version": version, "backup": backup}


@app.exception_handler(sqlite3.Error)
def db_error(_, exc):
    return JSONResponse(status_code=500, content={"detail": str(exc)})


@app.middleware("http")
async def no_cache_static(request, call_next):
    # browsers otherwise cache app.js/index.html across rebuilds and the UI
    # breaks (old JS + new HTML). no-cache = revalidate every load (ETag →
    # cheap 304 when unchanged).
    resp = await call_next(request)
    if not request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
