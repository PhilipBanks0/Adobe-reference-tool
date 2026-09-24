"""Tiny stand-in for the GitHub releases API, used by installer.tests.ps1.
Usage: python mock_github.py <port> <dir>
Serves <dir>/latest.json at /repos/<owner>/<repo>/releases/latest and
files in <dir> at /download/<name>."""
import http.server, os, sys

PORT, ROOT = int(sys.argv[1]), sys.argv[2]

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.endswith("/releases/latest"):
            name, ctype = "latest.json", "application/json"
        elif self.path.startswith("/download/"):
            name, ctype = os.path.basename(self.path), "application/octet-stream"
        else:
            self.send_error(404); return
        p = os.path.join(ROOT, name)
        if not os.path.exists(p):
            self.send_error(404); return
        data = open(p, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *a): pass

http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
