#!/usr/bin/env python3
"""Purge a time window of events as a measuring error.

Removes episodes from events.jsonl (source of truth) and the dashboard's
SQLite index. The ingester notices the shrunk file, replays it from scratch
and re-indexes only the surviving lines (idempotent), so the deletion is
stable across container rebuilds and log rotation.

Usage (local time, end exclusive):
  python3 purge_events.py "2026-09-30 07:00" "2026-09-30 08:00"
  python3 purge_events.py "2026-09-30 07:00" "2026-09-30 08:00" --tz Europe/Berlin

The SPL level log (spl.jsonl) is left untouched — episodes and levels are
independent stores.
"""

import argparse
import json
import os
import sqlite3
from datetime import datetime
from zoneinfo import ZoneInfo


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("from_ts", help='window start, e.g. "2026-09-30 07:00"')
    p.add_argument("to_ts", help="window end (exclusive)")
    p.add_argument("--tz", default=None,
                   help="IANA zone for the window (default: system local)")
    p.add_argument("--log-dir", default=os.environ.get("LOG_DIR", "."))
    a = p.parse_args()

    tz = ZoneInfo(a.tz) if a.tz else datetime.now().astimezone().tzinfo
    lo = datetime.fromisoformat(a.from_ts).replace(tzinfo=tz).timestamp()
    hi = datetime.fromisoformat(a.to_ts).replace(tzinfo=tz).timestamp()
    if hi <= lo:
        p.error("window end must be after start")

    path = os.path.join(a.log_dir, "events.jsonl")
    kept = dropped = 0
    tmp = path + ".purge-tmp"
    with open(path) as src, open(tmp, "w") as dst:
        for line in src:
            try:
                ts = datetime.fromisoformat(
                    json.loads(line)["ts"].replace("Z", "+00:00")).timestamp()
            except (json.JSONDecodeError, KeyError, ValueError):
                ts = None  # keep malformed lines rather than losing data
            if ts is not None and lo <= ts < hi:
                dropped += 1
                continue
            dst.write(line)
            kept += 1
    os.replace(tmp, path)  # atomic: next append lands in the new file

    db = os.path.join(a.log_dir, "dashboard.db")
    n = 0
    if os.path.exists(db):
        con = sqlite3.connect(db, timeout=10)
        con.execute("PRAGMA busy_timeout=5000")
        n = con.execute("DELETE FROM events WHERE ts >= ? AND ts < ?",
                        (lo, hi)).rowcount
        con.commit()
        con.close()
    print(f"events.jsonl: kept {kept}, removed {dropped}; "
          f"dashboard.db: deleted {n}")


if __name__ == "__main__":
    main()
