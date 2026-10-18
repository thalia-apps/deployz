import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def schedule():
    while True:
        time.sleep(30)
        print("scheduled tick", flush=True)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == "/health" else 404)
        self.send_header("Content-Length", "0")
        self.end_headers()


threading.Thread(target=schedule, daemon=True).start()
ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
