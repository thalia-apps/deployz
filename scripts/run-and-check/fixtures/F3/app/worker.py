import os

import redis

queue = redis.Redis.from_url(os.environ["REDIS_URL"])

while True:
    item = queue.blpop("jobs", timeout=5)
    if item is not None:
        print("processed", item[1].decode(), flush=True)
