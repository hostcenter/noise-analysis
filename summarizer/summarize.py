#!/usr/bin/env python3
"""Daily noise-log summarizer.

Reads JSONL logs (events.jsonl, spl.jsonl), asks a local Ollama model for a
human-readable daily summary, and writes logs/summaries/summary-YYYY-MM-DD.md
plus an append-only summaries.jsonl index.
"""

import json
import os
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2:3b")
LOG_DIR = os.environ.get("LOG_DIR", "/data/logs")
SUMMARY_HOUR = int(os.environ.get("SUMMARY_HOUR", "7"))
RUN_ONCE = os.environ.get("RUN_ONCE", "") == "1"
SUMMARY_DATE = os.environ.get("SUMMARY_DATE", "")


def http_json(path, payload, timeout):
    req = urllib.request.Request(
        OLLAMA_URL.rstrip("/") + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def ensure_model():
    try:
        http_json("/api/pull", {"model": OLLAMA_MODEL, "stream": False}, timeout=7200)
    except Exception as exc:
        print(f"model pull failed (continuing): {exc!r}", flush=True)


def generate(prompt):
    return http_json(
        "/api/generate",
        {
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0.4, "num_predict": 350},
        },
        timeout=900,
    )["response"].strip()


def read_day(day, name):
    path = os.path.join(LOG_DIR, name)
    if not os.path.exists(path):
        return []
    out = []
    with open(path) as f:
        for line in f:
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("ts", "").startswith(day):
                out.append(e)
    return out


def digest(day):
    events = read_day(day, "events.jsonl")
    spl = read_day(day, "spl.jsonl")
    if not events and not spl:
        return None
    counts = Counter(e["event"] for e in events)
    hours = defaultdict(Counter)
    for e in events:
        try:
            hours[int(e["ts"][11:13])][e["event"]] += 1
        except ValueError:
            pass
    vals = [s.get("spl_db") for s in spl if s.get("spl_db") is not None]
    spl_stats = (
        {
            "avg": round(sum(vals) / len(vals), 1),
            "min": min(vals),
            "max": max(vals),
            "samples": len(vals),
        }
        if vals
        else None
    )
    busiest = (
        max(hours, key=lambda h: sum(hours[h].values())) if hours else None
    )
    return {"day": day, "counts": counts, "busiest_hour": busiest, "spl": spl_stats}


def build_prompt(d):
    lines = [f"Date: {d['day']} (UTC)"]
    if d["counts"]:
        top = ", ".join(f"{k} x{v}" for k, v in d["counts"].most_common(15))
        lines.append(f"Detected sound events: {top}")
        if d["busiest_hour"] is not None:
            lines.append(f"Noisiest hour: {d['busiest_hour']:02d}:00 UTC")
    if d["spl"]:
        s = d["spl"]
        lines.append(
            f"SPL (A-weighted, uncalibrated dBFS): avg {s['avg']}, "
            f"min {s['min']}, max {s['max']} ({s['samples']} samples)"
        )
    facts = "\n".join(lines)
    return (
        "You summarize daily street-noise monitoring reports. Using ONLY the "
        "facts below, write a 3-5 sentence summary of the noise situation. "
        "Be factual, do not invent events.\n\n" + facts
    )


def summarize(day):
    summary_path = os.path.join(LOG_DIR, "summaries", f"summary-{day}.md")
    if os.path.exists(summary_path):
        print(f"{day}: summary exists, skipping", flush=True)
        return
    d = digest(day)
    if d is None:
        print(f"{day}: no log data, skipping", flush=True)
        return
    text = generate(build_prompt(d))
    os.makedirs(os.path.dirname(summary_path), exist_ok=True)
    with open(summary_path, "w") as f:
        f.write(text + "\n")
    with open(os.path.join(LOG_DIR, "summaries.jsonl"), "a") as f:
        f.write(
            json.dumps(
                {"ts": datetime.utcnow().isoformat() + "Z", "date": day, "summary": text},
                separators=(",", ":"),
            )
            + "\n"
        )
    print(f"{day}: summary written", flush=True)


def next_run():
    now = datetime.now()
    run = now.replace(hour=SUMMARY_HOUR, minute=0, second=0, microsecond=0)
    if run <= now:
        run += timedelta(days=1)
    return run


def main():
    if RUN_ONCE:
        day = SUMMARY_DATE or (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        ensure_model()
        summarize(day)
        return

    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    try:
        summarize(yesterday)
    except Exception as exc:
        print(f"startup catch-up failed: {exc!r}", flush=True)

    while True:
        target = next_run()
        wait = (target - datetime.now()).total_seconds()
        print(f"next summary at {target} ({wait/3600:.1f}h)", flush=True)
        time.sleep(max(wait, 1))
        day = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        try:
            summarize(day)
        except Exception as exc:
            print(f"summary failed: {exc!r}", flush=True)


if __name__ == "__main__":
    main()
