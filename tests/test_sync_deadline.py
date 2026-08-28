"""Unit tests for sync_to_dashboard.py's pure helpers.

These cover the board-level logic added on feat/repo-adoption-upgrades:
URL-key normalization + dedup, application-deadline extraction/expiry, and the
source-health sentinel. turso_helper is stubbed so the module imports without
Turso credentials.

Run: python3 -m unittest tests.test_sync_deadline -v
"""

import sys
import unittest
from datetime import date
from pathlib import Path
from types import ModuleType

REPO = Path(__file__).resolve().parent.parent

# Stub the Turso bridge BEFORE sync_to_dashboard is imported: it is only used
# by the query functions, none of which these tests exercise.
stub = ModuleType("turso_helper")
stub.turso_query = lambda *a, **k: []
stub.turso_execute = lambda *a, **k: []
stub.turso_scalar = lambda *a, **k: None
sys.modules.setdefault("turso_helper", stub)
sys.path.insert(0, str(REPO))

import sync_to_dashboard as sync  # noqa: E402


class NormalizeUrlKeyTest(unittest.TestCase):
    def test_collapses_tracking_params_case_and_slash(self):
        a = sync.normalize_url_key(
            "https://Jobs.Example.com/role/123/?utm_source=indeed&rx_id=9&id=123"
        )
        b = sync.normalize_url_key("http://jobs.example.com/role/123?id=123")
        self.assertEqual(a, b)
        # scheme is canonicalized to https: same posting either way
        self.assertEqual(a, "https://jobs.example.com/role/123?id=123")

    def test_sorts_remaining_query_params(self):
        self.assertEqual(
            sync.normalize_url_key("https://x.com/j?b=2&a=1"),
            "https://x.com/j?a=1&b=2",
        )

    def test_fragment_only_difference_collapses(self):
        self.assertEqual(
            sync.normalize_url_key("https://x.com/j#a"),
            sync.normalize_url_key("https://x.com/j#b"),
        )

    def test_non_urls_and_empty_yield_empty_key(self):
        self.assertEqual(sync.normalize_url_key(""), "")
        self.assertEqual(sync.normalize_url_key("not a url"), "")


class DedupeJobsTest(unittest.TestCase):
    def test_keeps_first_and_drops_later_same_key(self):
        jobs = [
            {"id": 1, "url_key": "https://x.com/j/1"},
            {"id": 2, "url_key": "https://x.com/j/1"},
            {"id": 3, "url_key": ""},
            {"id": 4, "url_key": "https://x.com/j/2"},
        ]
        kept, dropped = sync.dedupe_jobs(jobs)
        self.assertEqual([j["id"] for j in kept], [1, 3, 4])
        self.assertEqual(dropped, 1)


class ExtractDeadlineTest(unittest.TestCase):
    today = date(2026, 8, 14)

    def test_iso_date_after_apply_by(self):
        text = "Interested? Apply by 2026-09-30 through our careers portal."
        self.assertEqual(sync.extract_deadline(text, self.today), "2026-09-30")

    def test_text_date_after_closing(self):
        text = "Closing date: September 30, 2026 at 11:59 p.m. EST."
        self.assertEqual(sync.extract_deadline(text, self.today), "2026-09-30")

    def test_day_first_date_after_deadline(self):
        text = "Application deadline: 30 September 2026."
        self.assertEqual(sync.extract_deadline(text, self.today), "2026-09-30")

    def test_yearless_date_assumes_future_cycle(self):
        text = "We will remain open until March 1."
        self.assertEqual(sync.extract_deadline(text, self.today), "2027-03-01")

    def test_random_date_without_deadline_language_is_ignored(self):
        text = "Since 2026-01-05 we have offered a great benefits package."
        self.assertEqual(sync.extract_deadline(text, self.today), "")

    def test_no_text_no_deadline(self):
        self.assertEqual(sync.extract_deadline(""), "")
        self.assertEqual(sync.extract_deadline(None), "")


class DeadlineStatusTest(unittest.TestCase):
    today = date(2026, 8, 14)

    def test_past_is_expired(self):
        self.assertEqual(sync.deadline_status("2026-08-13", self.today), "expired")

    def test_within_week_is_closing_soon(self):
        self.assertEqual(sync.deadline_status("2026-08-21", self.today), "closing_soon")

    def test_later_is_open(self):
        self.assertEqual(sync.deadline_status("2026-12-01", self.today), "open")

    def test_empty_and_garbage_are_blank(self):
        self.assertEqual(sync.deadline_status("", self.today), "")
        self.assertEqual(sync.deadline_status("soon", self.today), "")


class SourceHealthTest(unittest.TestCase):
    def test_empty_source_and_dominant_source_warn(self):
        jobs = (
            [{"source": "indeed", "found_at": "2026-08-14"} for _ in range(95)]
            + [{"source": "linkedin", "found_at": "2026-08-13"}]
        )
        health = sync.compute_source_health(jobs, today="2026-08-14")
        self.assertEqual(health["sources"]["adzuna"]["active_rows"], 0)
        self.assertEqual(health["sources"]["indeed"]["active_rows"], 95)
        self.assertEqual(health["sources"]["indeed"]["last_found_at"], "2026-08-14")
        joined = " ".join(health["warnings"])
        self.assertIn("adzuna: 0 active rows", joined)
        self.assertIn("indeed holds 95/96", joined)

    def test_healthy_board_has_no_warnings(self):
        jobs = (
            [{"source": "indeed", "found_at": "2026-08-14"} for _ in range(5)]
            + [{"source": "linkedin", "found_at": "2026-08-14"} for _ in range(4)]
            + [{"source": "adzuna", "found_at": "2026-08-14"}]
        )
        self.assertEqual(sync.compute_source_health(jobs)["warnings"], [])


class FetchColumnsTest(unittest.TestCase):
    def test_optional_columns_are_probed_independently(self):
        calls = []
        original = sync.turso_query

        def query(sql):
            calls.append(sql)
            if "description" in sql and "follow_up_due" not in sql:
                raise RuntimeError("no such column: description")
            return [{"id": 1, "status": "found"}]

        sync.turso_query = query
        try:
            rows = sync.fetch_all_jobs()
        finally:
            sync.turso_query = original
        self.assertEqual(rows, [{"id": 1, "status": "found"}])
        self.assertTrue(any("follow_up_due" in sql for sql in calls))
        self.assertTrue(any("applied_at" in sql for sql in calls))

    def test_transient_optional_probe_error_is_not_treated_as_missing(self):
        original = sync.turso_query
        def query(_sql):
            raise RuntimeError("Turso HTTP 503: unavailable")
        sync.turso_query = query
        try:
            with self.assertRaisesRegex(RuntimeError, "503"):
                sync.fetch_all_jobs()
        finally:
            sync.turso_query = original

    def test_schema_error_still_degrades_optional_column(self):
        original = sync.turso_query
        def query(sql):
            if "description" in sql and "follow_up_due" not in sql:
                raise RuntimeError("no such column: description")
            return [{"id": 1, "status": "found"}]
        sync.turso_query = query
        try:
            self.assertEqual(sync.fetch_all_jobs(), [{"id": 1, "status": "found"}])
        finally:
            sync.turso_query = original


class TransformIntegrationTest(unittest.TestCase):
    def test_transform_adds_url_key_and_deadline(self):
        row = {
            "id": "x", "title": "Engineer", "company": "ACME",
            "location": "Toronto, ON", "match_score": 88.0,
            "status": "found", "source": "indeed",
            "url": "https://jobs.acme.com/role/9?utm_source=indeed",
            "description": "Build things. Apply by 2026-09-30. This posting includes enough role context to be treated as a real job description.",
            "found_at": "2026-08-14",
        }
        job = sync.transform_job(row)
        self.assertEqual(job["url_key"], "https://jobs.acme.com/role/9")
        self.assertEqual(job["deadline"], "2026-09-30")
        self.assertEqual(job["deadline_status"], "open")

    def test_transform_uses_explicit_utc_today(self):
        row = {
            "id": "x", "title": "Engineer", "company": "ACME",
            "status": "found", "source": "indeed",
            "description": "Apply by 2026-08-14. This role requires relevant experience and includes a complete posting body for deadline extraction.",
        }
        self.assertEqual(sync.transform_job(row, date(2026, 8, 14))["deadline_status"], "closing_soon")
        self.assertEqual(sync.transform_job(row, date(2026, 8, 15))["deadline_status"], "expired")

    def test_deadline_falls_back_to_notes_when_description_is_title_only(self):
        row = {
            "id": "x", "title": "Engineer", "company": "ACME",
            "status": "found", "source": "indeed",
            "description": "Engineer",
            "notes": "Apply by 2026-09-30",
        }
        self.assertEqual(sync.transform_job(row, date(2026, 8, 14))["deadline"], "2026-09-30")


if __name__ == "__main__":
    unittest.main()
