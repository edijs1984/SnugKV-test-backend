# SnugKV Real-Life Comparison Backend

NestJS workload backend for comparing **Redis vs SnugKV under application-shaped traffic**, not only raw RESP microbenchmarks.

Both backend instances use the **same NestJS code and the same ioredis client**. The only variable is the database endpoint:

- Redis: `127.0.0.1:6390`
- SnugKV: `127.0.0.1:6383`

This lets us measure the cost users actually see through an HTTP application: serialization, network round trips, pipelines, TTLs, mixed Redis data types, cache hits/misses, and concurrent requests.

## Scenarios

The API intentionally mixes common production patterns:

- cache-aside product/API JSON with TTL
- session JSON with TTL
- shopping cart backed by a Redis hash
- recent activity backed by a list
- user tags backed by a set
- leaderboard backed by a sorted set
- rate limiting with increment + expiry
- global counters

The comparison runner uses this deterministic mix:

| Share | Scenario |
| ---: | --- |
| 35% | cached product/API JSON |
| 13% | session write |
| 8% | session read |
| 12% | hash cart update |
| 8% | activity list append |
| 7% | rate limiting |
| 6% | set/tag update |
| 6% | sorted-set leaderboard |
| 5% | counter |

The same seed generates the same users, products, request types, and request ordering for both targets.

## Setup

Install dependencies:

```bash
npm install
```

Start Redis and SnugKV yourself. The expected local ports are:

```text
Redis   127.0.0.1:6390
SnugKV  127.0.0.1:6383
```

Then run two identical backend instances.

Terminal 1 — Redis-backed API:

```bash
TARGET=redis KV_PORT=6390 PORT=3001 npm run start:redis
```

Terminal 2 — SnugKV-backed API:

```bash
TARGET=snug KV_PORT=6383 PORT=3002 npm run start:snug
```

Verify:

```bash
curl http://127.0.0.1:3001/api/health
curl http://127.0.0.1:3002/api/health
```

## Compare real-life traffic

Terminal 3:

```bash
npm run compare -- --requests 50000 --concurrency 100 --seed 1
```

A larger run:

```bash
npm run compare -- --requests 1000000 --concurrency 256 --seed 1
```

Custom API URLs:

```bash
npm run compare -- \
  --requests 250000 \
  --concurrency 128 \
  --redis-url http://127.0.0.1:3001 \
  --snug-url http://127.0.0.1:3002
```

The runner:

1. flushes the selected database
2. warms the Nest/Node/database path
3. records database memory
4. executes the deterministic mixed workload
5. records RPS and HTTP p50/p95/p99 latency
6. records error count, DB key count, and memory growth
7. prints Redis and SnugKV side-by-side plus JSON for later analysis

Redis is run first and SnugKV second so the two database processes do not compete for benchmark traffic at the same time.

## Useful endpoints

```text
GET    /api/health
GET    /api/metrics
DELETE /api/scenarios/reset

GET    /api/scenarios/catalog/:id
POST   /api/scenarios/session/:userId
GET    /api/scenarios/session/:userId

POST   /api/scenarios/cart/:userId/:productId/:quantity
GET    /api/scenarios/cart/:userId

POST   /api/scenarios/activity/:userId/:type/:entityId
GET    /api/scenarios/activity/:userId

POST   /api/scenarios/tags/:userId/:tag
GET    /api/scenarios/tags/:userId

POST   /api/scenarios/leaderboard/:userId/:delta
POST   /api/scenarios/rate-limit/:userId
POST   /api/scenarios/counter/:name/:delta
```

## Fair-comparison rule

Do not give SnugKV a different client, different endpoint implementation, different payload, or different concurrency from Redis.

Both sides intentionally use ioredis. SnugKV is Redis-protocol compatible, so this measures whether an existing Node application could switch its Redis endpoint to SnugKV and what happens to throughput, latency, and memory.

For publication-quality numbers, run each configuration multiple times and alternate run order to control for OS cache, CPU temperature, and background activity.
