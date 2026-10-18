import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import redis

queue = redis.Redis.from_url(os.environ["REDIS_URL"])
queue.ping()


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body=b""):
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, b"ok")
        else:
            self.reply(404)

    def do_POST(self):
        if self.path == "/jobs":
            queue.rpush("jobs", "job")
            self.reply(202, b"queued")
        else:
            self.reply(404)


ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
