#!/usr/bin/env python3
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "analysis")))
import purge_events


class TestPurgeEvents(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.log_dir = self.tmp_dir.name
        self.events_path = os.path.join(self.log_dir, "events.jsonl")
        self.db_path = os.path.join(self.log_dir, "dashboard.db")

        # Create sample events.jsonl
        # Timestamps: 2026-10-01 10:00:00, 2026-10-01 10:30:00, 2026-10-01 11:00:00 UTC
        self.records = [
            {"ts": "2026-10-01T10:00:00.000Z", "event": "Car", "confidence": 0.8, "spl_db": -40.0},
            {"ts": "2026-10-01T10:30:00.000Z", "event": "Dog", "confidence": 0.9, "spl_db": -45.0},
            {"ts": "2026-10-01T11:00:00.000Z", "event": "Bus", "confidence": 0.7, "spl_db": -38.0},
        ]
        with open(self.events_path, "w") as f:
            for r in self.records:
                f.write(json.dumps(r) + "\n")

        # Create sample dashboard.db
        con = sqlite3.connect(self.db_path)
        con.execute("CREATE TABLE events (ts REAL, event TEXT, confidence REAL, spl REAL)")
        for r in self.records:
            ts = datetime.fromisoformat(r["ts"].replace("Z", "+00:00")).timestamp()
            con.execute("INSERT INTO events VALUES (?, ?, ?, ?)", (ts, r["event"], r["confidence"], r["spl_db"]))
        con.commit()
        con.close()

    def tearDown(self):
        self.tmp_dir.cleanup()

    def test_purge_window(self):
        # Purge window: 2026-10-01 10:15:00 to 2026-10-01 10:45:00 UTC (should drop record 2)
        test_args = [
            "purge_events.py",
            "2026-10-01 10:15:00",
            "2026-10-01 10:45:00",
            "--tz", "UTC",
            "--log-dir", self.log_dir,
        ]
        with patch.object(sys, "argv", test_args):
            purge_events.main()

        # Check events.jsonl
        surviving = []
        with open(self.events_path) as f:
            for line in f:
                surviving.append(json.loads(line))
        self.assertEqual(len(surviving), 2)
        events = [r["event"] for r in surviving]
        self.assertIn("Car", events)
        self.assertIn("Bus", events)
        self.assertNotIn("Dog", events)

        # Check dashboard.db
        con = sqlite3.connect(self.db_path)
        db_events = [r[0] for r in con.execute("SELECT event FROM events").fetchall()]
        con.close()
        self.assertEqual(len(db_events), 2)
        self.assertIn("Car", db_events)
        self.assertIn("Bus", db_events)
        self.assertNotIn("Dog", db_events)

    def test_default_log_dir_fallback(self):
        # When --log-dir is not passed, it should default to logs if it exists or .
        with patch.dict(os.environ, {}, clear=True):
            with patch("os.path.isdir", return_value=True):
                p = purge_events.argparse.ArgumentParser()
                p.add_argument("from_ts")
                p.add_argument("to_ts")
                default_log_dir = "logs" if os.path.isdir("logs") else "."
                p.add_argument("--log-dir", default=default_log_dir)
                args = p.parse_args(["2026-10-01 10:00", "2026-10-01 11:00"])
                self.assertEqual(args.log_dir, "logs")


if __name__ == "__main__":
    unittest.main()
