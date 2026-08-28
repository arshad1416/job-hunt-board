"""Unit tests for scripts/lib/public_ats.py (ATS board ingestion).

Covers config parsing/allowlisting, API-URL planning (the 'no arbitrary URLs'
enforcement point), the three provider parsers, HTML-to-text, the freshness
window, and fetch_board's non-fatal error handling with an injected urlopen.

Run: python3 -m unittest tests.test_public_ats -v
"""

import base64
import io
import json
import sys
import unittest
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts" / "lib"))

import public_ats as pa  # noqa: E402


class ProviderConfigTest(unittest.TestCase):
    def test_parses_env_style_list_with_validation(self):
        boards, warn = pa.parse_provider_config(
            "greenhouse:stripe, lever:zeekr, ashby:anthropic"
        )
        self.assertEqual(
            [(b["provider"], b["slug"]) for b in boards],
            [("greenhouse", "stripe"), ("lever", "zeekr"), ("ashby", "anthropic")],
        )
        self.assertEqual(boards[0]["label"], "Stripe")  # slug-derived label
        self.assertEqual(warn, [])

    def test_rejects_unknown_provider_and_bad_slug_with_warnings(self):
        boards, warn = pa.parse_provider_config(
            "indeed:whatever, greenhouse:../etc, greenhouse:OK slug, greenhouse:good"
        )
        self.assertEqual([(b["provider"], b["slug"]) for b in boards],
                         [("greenhouse", "good")])
        self.assertEqual(len(warn), 3)

    def test_dedupes_and_labels_explicit_label(self):
        boards, _ = pa.parse_provider_config("lever:zeekr, lever:zeekr:Zeekr EV")
        self.assertEqual(len(boards), 1)
        self.assertEqual(boards[0]["label"], "Zeekr")  # first spec wins
        labelled, _ = pa.parse_provider_config("lever:zeekr:Zeekr EV")
        self.assertEqual(labelled[0]["label"], "Zeekr EV")

    def test_profile_section_routes_through_same_validation(self):
        profile = {"ats_boards": [
            {"provider": "ashby", "slug": "anthropic", "label": "Anthropic"},
            {"provider": "marzipan", "slug": "x"},
            "greenhouse:stripe",
        ]}
        boards, warn = pa.boards_from_profile(profile)
        self.assertEqual([b["slug"] for b in boards], ["anthropic", "stripe"])
        self.assertEqual(len(warn), 1)

    def test_default_is_empty_no_behavior_change(self):
        self.assertEqual(pa.configured_boards({})[0], [])
        self.assertEqual(pa.configured_boards({"ats_boards": []})[0], [])


class BoardApiUrlTest(unittest.TestCase):
    def test_documented_endpoints(self):
        self.assertEqual(
            pa.board_api_url("greenhouse", "stripe"),
            "https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true",
        )
        self.assertEqual(
            pa.board_api_url("lever", "zeekr"),
            "https://api.lever.co/v0/postings/zeekr?mode=json",
        )
        self.assertEqual(
            pa.board_api_url("ashby", "anthropic"),
            "https://api.ashbyhq.com/posting-api/job-board/anthropic",
        )

    def test_no_arbitrary_targets(self):
        for bad in [("greenhouse", "../../admin"), ("lever", "a/b?x=1"),
                    ("unknown", "ok"), ("greenhouse", ""), ("", "ok")]:
            self.assertEqual(pa.board_api_url(*bad), "")


class ParserTest(unittest.TestCase):
    def test_parse_greenhouse(self):
        payload = {"jobs": [{
            "id": 123, "title": "Backend Engineer",
            "absolute_url": "https://boards.greenhouse.io/stripe/jobs/123",
            "location": {"name": "Toronto, ON (Remote)"},
            "content": "<p>Build &amp; ship things.</p><ul><li>Python</li></ul>",
            "metadata": [{"name": "updated_at", "value": "2026-08-01"}],
        }, {"id": 124, "title": ""}]}
        jobs = pa.parse_greenhouse(payload, "stripe", "Stripe")
        self.assertEqual(len(jobs), 1)
        job = jobs[0]
        self.assertEqual(job["id"], "greenhouse-123")
        self.assertEqual(job["title"], "Backend Engineer")
        self.assertEqual(job["company"], "Stripe")
        self.assertEqual(job["location"], "Toronto, ON (Remote)")
        self.assertIn("Build & ship things.", job["description"])
        self.assertIn("Python", job["description"])
        self.assertEqual(job["site"], "ats-greenhouse")

    def test_parse_greenhouse_base64_content(self):
        encoded = base64.b64encode("<p>Expérience au Québec</p>".encode()).decode()
        jobs = pa.parse_greenhouse({"jobs": [{"id": 9, "title": "Engineer",
                                           "content": encoded}]}, "acme")
        self.assertEqual(jobs[0]["description"], "Expérience au Québec")

    def test_profile_label_with_colon_is_preserved(self):
        boards, warnings = pa.boards_from_profile({"ats_boards": [{"provider": "greenhouse", "slug": "acme", "label": "ACME: Canada"}]})
        self.assertEqual(warnings, [])
        self.assertEqual(boards[0]["label"], "ACME: Canada")

    def test_json_label_with_colon_is_preserved(self):
        boards, warnings = pa.parse_provider_config('[{"provider": "greenhouse", "slug": "acme", "label": "ACME: Canada"}]')
        self.assertEqual(warnings, [])
        self.assertEqual(boards[0]["label"], "ACME: Canada")

    def test_parse_lever(self):
        payload = {"data": [{
            "id": "abc-1", "text": "Data Engineer",
            "hostedUrl": "https://jobs.lever.co/zeekr/abc-1",
            "categories": {"location": "Toronto, Canada"},
            "workplaceType": "remote",
            "descriptionPlain": "<p>ETL all the things</p>",
            "createdAt": 1723680000000,  # 2024-08-15T00:00:00Z
        }]}
        jobs = pa.parse_lever(payload, "zeekr")
        self.assertEqual(jobs[0]["location"], "Toronto, Canada")
        self.assertTrue(jobs[0]["is_remote"])
        self.assertTrue(jobs[0]["_created_at"].startswith("2024-08-15"))
        self.assertEqual(jobs[0]["url"] if "url" in jobs[0] else jobs[0]["job_url"],
                         "https://jobs.lever.co/zeekr/abc-1")

    def test_parse_ashby(self):
        payload = {"jobs": [{
            "id": "ash-9", "title": "Solutions Architect",
            "jobUrl": "https://jobs.ashbyhq.com/anthropic/ash-9",
            "location": "Remote — Canada",
            "descriptionPlain": "Ship AI systems",
            "isRemote": True,
            "publishedAt": "2026-07-30T12:00:00.000Z",
        }]}
        jobs = pa.parse_ashby(payload, "anthropic", "Anthropic")
        self.assertEqual(jobs[0]["id"], "ashby-ash-9")
        self.assertTrue(jobs[0]["is_remote"])
        self.assertEqual(jobs[0]["_created_at"], "2026-07-30T12:00:00.000Z")

    def test_html_to_text_entity_and_nbsp(self):
        self.assertEqual(pa.html_to_text("<p>A&nbsp;B &amp; C</p><p>D</p>"),
                         "A B & C\nD")
        self.assertEqual(pa.html_to_text(""), "")


class FreshnessTest(unittest.TestCase):
    now = datetime(2026, 8, 14, tzinfo=timezone.utc)

    def test_old_posting_is_stale(self):
        self.assertTrue(pa.is_stale("2026-01-01T00:00:00+00:00", self.now))

    def test_recent_posting_is_not_stale(self):
        self.assertFalse(pa.is_stale("2026-08-01T00:00:00+00:00", self.now))

    def test_missing_or_garbage_dates_are_kept(self):
        self.assertFalse(pa.is_stale("", self.now))
        self.assertFalse(pa.is_stale("whenever", self.now))


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FetchBoardTest(unittest.TestCase):

    def test_success_round_trip(self):
        payload = {"jobs": [{"id": 1, "title": "Eng", "absolute_url": "u",
                             "location": {"name": "ON"}, "content": "<p>d</p>"}]}

        def ok_urlopen(req, timeout=0):
            return FakeResponse(json.dumps(payload).encode())

        jobs, error = pa.fetch_board("greenhouse", "stripe", urlopen=ok_urlopen)
        self.assertIsNone(error)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["company"], "Stripe")

    def test_http_errors_are_returned_not_raised(self):
        def http_error_urlopen(req, timeout=0):
            raise urllib.error.HTTPError("u", 404, "nope", {}, io.BytesIO(b""))

        jobs, error = pa.fetch_board("greenhouse", "ghost", urlopen=http_error_urlopen)
        self.assertEqual(jobs, [])
        self.assertIn("404", error)

    def test_network_and_json_errors_are_returned(self):
        def net_err(req, timeout=0):
            raise urllib.error.URLError("refused")

        def bad_json(req, timeout=0):
            return FakeResponse(b"<html>not json</html>")

        self.assertIn("network", pa.fetch_board("lever", "zeekr", urlopen=net_err)[1])
        self.assertIn("bad JSON", pa.fetch_board("lever", "zeekr", urlopen=bad_json)[1])

    def test_unusable_spec_never_hits_network(self):
        def must_not_run(req, timeout=0):
            raise AssertionError("network must not be touched")

        self.assertEqual(pa.fetch_board("lever", "../nope", urlopen=must_not_run)[1],
                         "unusable board spec: lever:../nope")


class FetchAllBoardsHealthTest(unittest.TestCase):
    def test_health_counters_cover_ok_and_failed_boards(self):
        def urlopen(req, timeout=0):
            if "ghost" in req.full_url:
                raise urllib.error.HTTPError("u", 500, "boom", {}, io.BytesIO(b""))
            return FakeResponse(
                json.dumps({"data": [{"id": "1", "text": "Eng",
                                      "hostedUrl": "u"}]}).encode())

        boards = [{"provider": "lever", "slug": "zeekr", "label": "Zeekr"},
                  {"provider": "lever", "slug": "ghost", "label": "Ghost"}]
        jobs, health = pa.fetch_all_boards(boards, urlopen=urlopen)
        self.assertEqual(len(jobs), 1)
        self.assertTrue(health["lever:zeekr"]["ok"])
        self.assertEqual(health["lever:zeekr"]["jobs"], 1)
        self.assertFalse(health["lever:ghost"]["ok"])
        self.assertIn("500", health["lever:ghost"]["error"])


if __name__ == "__main__":
    unittest.main()
