"""Lima's anonymous usage collector (Cloud Run).

Accepts one daily report per install from people who turned on "Share
anonymous usage statistics", validates it against a strict schema and stores
it as installs/<random id>/<day>.json in a private bucket. It never stores IP
addresses or headers (request logs for this service are excluded in Cloud
Logging), and DELETE /v1/installs/<id> removes everything sent under an ID.
Standard library only: the GCS JSON API with the service's own token.
"""
import json
import os
import re
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BUCKET = os.environ["USAGE_BUCKET"]
MAX_BODY = 16 * 1024
ID = re.compile(r"^[0-9a-f]{32}$")
DAY = re.compile(r"^20\d\d-[01]\d-[0-3]\d$")
VERSION = re.compile(r"^\d{1,3}\.\d{1,3}\.\d{1,4}$")
REGION = re.compile(r"^[A-Z]{2}$")
OS = re.compile(r"^\d{1,3}(\.\d{1,3}){0,2}$")
EVENTS = {
    "app.active", "search.opened", "search.addressBar", "search.quickAsk", "chat.sent", "chat.attachment",
    "companion.request", "workspace.created", "agent.spawned", "schedule.created", "schedule.ran", "note.created",
    "download.finished", "music.spotify", "music.appleMusic", "music.tab", "image.generated", "capability.ran",
    "update.installed", "provider.failover",
}
SETTINGS = {
    "theme": {"system", "light", "dark"},
    "provider": {"claude", "codex", "opencode", "none"},
    "tabSize": {"compact", "default", "large"},
    "hideAI": {True, False}, "hideAds": {True, False}, "hideShorts": {True, False}, "addressBar": {True, False},
}


def valid(report):
    if not isinstance(report, dict) or report.get("v") != 1:
        return None
    if set(report) - {"v", "id", "day", "version", "build", "os", "region", "counts", "settings"}:
        return None
    if not (isinstance(report.get("id"), str) and ID.match(report["id"]) and isinstance(report.get("day"), str)
            and DAY.match(report["day"]) and isinstance(report.get("version"), str) and VERSION.match(report["version"])
            and isinstance(report.get("os"), str) and OS.match(report["os"])
            and isinstance(report.get("build"), int)):
        return None
    region = report.get("region")
    if region is not None and not (isinstance(region, str) and REGION.match(region)):
        return None
    counts = report.get("counts")
    if not isinstance(counts, dict) or set(counts) - EVENTS:
        return None
    if any(not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 100_000 for value in counts.values()):
        return None
    settings = report.get("settings", {})
    if not isinstance(settings, dict) or set(settings) - set(SETTINGS):
        return None
    if any(value not in SETTINGS[key] for key, value in settings.items()):
        return None
    return report


def token():
    request = urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
        headers={"Metadata-Flavor": "Google"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)["access_token"]


def gcs(method, url, body=None, content_type=None):
    headers = {"Authorization": f"Bearer {token()}"}
    if content_type:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.read()


def store(report):
    name = urllib.parse.quote(f"installs/{report['id']}/{report['day']}.json", safe="")
    gcs("POST", f"https://storage.googleapis.com/upload/storage/v1/b/{BUCKET}/o?uploadType=media&name={name}",
        json.dumps(report, separators=(",", ":")).encode(), "application/json")


def forget(install):
    prefix = urllib.parse.quote(f"installs/{install}/", safe="")
    listing = json.loads(gcs("GET", f"https://storage.googleapis.com/storage/v1/b/{BUCKET}/o?prefix={prefix}&fields=items(name)"))
    for item in listing.get("items", []):
        gcs("DELETE", f"https://storage.googleapis.com/storage/v1/b/{BUCKET}/o/{urllib.parse.quote(item['name'], safe='')}")


class Handler(BaseHTTPRequestHandler):
    server_version = "lima-usage"
    sys_version = ""

    def log_message(self, *args):  # no access logs: they would hold addresses
        pass

    def reply(self, status):
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        if self.path != "/v1/report":
            return self.reply(404)
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BODY:
            return self.reply(413)
        try:
            report = valid(json.loads(self.rfile.read(length)))
        except ValueError:
            report = None
        if report is None:
            return self.reply(400)
        try:
            store(report)
        except Exception:
            return self.reply(503)
        self.reply(204)

    def do_DELETE(self):
        match = re.match(r"^/v1/installs/([0-9a-f]{32})$", self.path)
        if not match:
            return self.reply(404)
        try:
            forget(match.group(1))
        except Exception:
            return self.reply(503)
        self.reply(204)

    def do_GET(self):
        self.reply(204 if self.path == "/healthz" else 404)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
