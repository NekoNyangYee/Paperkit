#!/usr/bin/env python3
"""Read-only health/auth probe. Does not print keys or response data."""
import argparse
import json
import os
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

parser = argparse.ArgumentParser()
parser.add_argument("base", help="e.g. http://127.0.0.1:18080/paperkit")
args = parser.parse_args()
base = args.base.rstrip("/")
url = urlparse(base)
if url.scheme != "https" and not (
    url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost", "::1")
):
    parser.error("Credentials may only be sent over HTTPS or local loopback HTTP")
key = os.environ.get("PAPERKIT_ACCESS_TOKEN")


def check(path, expected, authorized=False):
    headers = {"Authorization": "Bearer " + key} if authorized else {}
    request = Request(base + path, headers=headers)
    try:
        # Never forward a Bearer credential to a different URL on redirect.
        from urllib.request import HTTPRedirectHandler, build_opener

        class NoRedirect(HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None

        with build_opener(NoRedirect).open(request, timeout=10) as response:
            status = response.status
            if path == "/healthz" and json.load(response) != {"status": "ok"}:
                raise SystemExit("Unexpected health response")
    except HTTPError as error:
        status = error.code
    if status != expected:
        raise SystemExit(f"FAIL {path}: expected {expected}, received {status}")
    print(f"PASS {path}: HTTP {status}")


check("/healthz", 200)
check("/v1/documents", 401)
if key:
    check("/v1/me", 200, authorized=True)
    check("/v1/documents?limit=1", 200, authorized=True)
else:
    print("SKIP authenticated probe: set PAPERKIT_ACCESS_TOKEN to a Supabase user access token")
