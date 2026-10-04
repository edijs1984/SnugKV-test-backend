type TargetName = 'redis' | 'snug';

type Config = {
  requests: number;
  concurrency: number;
  seed: number;
  redisUrl: string;
  snugUrl: string;
  warmup: number;
};

type Metrics = {
  target: string;
  dbsize: number;
  usedMemory: number | null;
  usedMemoryRss: number | null;
};

type RunResult = {
  target: TargetName;
  requests: number;
  errors: number;
  durationMs: number;
  requestsPerSecond: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  memoryBefore: Metrics;
  memoryAfter: Metrics;
};

function arg(name: string, fallback: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const config: Config = {
  requests: Number(arg('requests', '50000')),
  concurrency: Number(arg('concurrency', '100')),
  seed: Number(arg('seed', '1')),
  redisUrl: arg('redis-url', 'http://127.0.0.1:3001'),
  snugUrl: arg('snug-url', 'http://127.0.0.1:3002'),
  warmup: Number(arg('warmup', '2000')),
};

function hash32(n: number) {
  let x = n | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function requestFor(index: number) {
  const n = hash32(index + config.seed * 1_000_003);
  const bucket = n % 100;
  const userId = (hash32(n + 11) % 25000) + 1;
  const productId = (hash32(n + 29) % 100000) + 1;

  if (bucket < 35) {
    return { method: 'GET', path: `/api/scenarios/catalog/${productId}` };
  }
  if (bucket < 48) {
    return {
      method: 'POST',
      path: `/api/scenarios/session/${userId}`,
      body: JSON.stringify({ device: `device-${n % 5000}`, request: index }),
    };
  }
  if (bucket < 56) {
    return { method: 'GET', path: `/api/scenarios/session/${userId}` };
  }
  if (bucket < 68) {
    return {
      method: 'POST',
      path: `/api/scenarios/cart/${userId}/${productId}/${(n % 5) + 1}`,
    };
  }
  if (bucket < 76) {
    return {
      method: 'POST',
      path: `/api/scenarios/activity/${userId}/view/${productId}`,
    };
  }
  if (bucket < 83) {
    return { method: 'POST', path: `/api/scenarios/rate-limit/${userId}` };
  }
  if (bucket < 89) {
    return {
      method: 'POST',
      path: `/api/scenarios/tags/${userId}/tag-${n % 250}`,
    };
  }
  if (bucket < 95) {
    return {
      method: 'POST',
      path: `/api/scenarios/leaderboard/${userId}/${(n % 10) + 1}`,
    };
  }
  return { method: 'POST', path: `/api/scenarios/counter/api-requests/1` };
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return response.json() as Promise<T>;
}

async function execute(baseUrl: string, index: number) {
  const request = requestFor(index);
  const start = performance.now();
  const response = await fetch(baseUrl + request.path, {
    method: request.method,
    headers: request.body ? { 'content-type': 'application/json' } : undefined,
    body: request.body,
  });
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return performance.now() - start;
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index];
}

async function warmup(baseUrl: string) {
  let next = 0;
  const workers = Array.from({ length: Math.min(config.concurrency, 32) }, async () => {
    while (true) {
      const index = next++;
      if (index >= config.warmup) return;
      try {
        await execute(baseUrl, index);
      } catch {
        // The measured run reports errors. Warmup only prepares caches/JIT/connections.
      }
    }
  });
  await Promise.all(workers);
}

async function run(target: TargetName, baseUrl: string): Promise<RunResult> {
  await json(baseUrl + '/api/scenarios/reset', { method: 'DELETE' });
  await warmup(baseUrl);
  const memoryBefore = await json<Metrics>(baseUrl + '/api/metrics');

  const latencies: number[] = [];
  let errors = 0;
  let next = 0;
  const started = performance.now();

  const workers = Array.from({ length: config.concurrency }, async () => {
    while (true) {
      const index = next++;
      if (index >= config.requests) return;
      try {
        latencies.push(await execute(baseUrl, index));
      } catch {
        errors++;
      }
    }
  });

  await Promise.all(workers);
  const durationMs = performance.now() - started;
  const memoryAfter = await json<Metrics>(baseUrl + '/api/metrics');
  latencies.sort((a, b) => a - b);

  return {
    target,
    requests: config.requests,
    errors,
    durationMs,
    requestsPerSecond: (config.requests / durationMs) * 1000,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    maxMs: latencies.at(-1) ?? 0,
    memoryBefore,
    memoryAfter,
  };
}

function pct(snug: number, redis: number) {
  return ((snug / redis) - 1) * 100;
}

async function main() {
  console.log('Real-life workload mix:');
  console.log('35% cache JSON, 13% session write, 8% session read, 12% hash cart,');
  console.log('8% activity list, 7% rate limit, 6% set tags, 6% zset leaderboard, 5% counter');
  console.log(`requests=${config.requests} concurrency=${config.concurrency} seed=${config.seed}`);

  const redis = await run('redis', config.redisUrl);
  const snug = await run('snug', config.snugUrl);

  const redisMem = Math.max(
    0,
    (redis.memoryAfter.usedMemory ?? 0) - (redis.memoryBefore.usedMemory ?? 0),
  );
  const snugMem = Math.max(
    0,
    (snug.memoryAfter.usedMemory ?? 0) - (snug.memoryBefore.usedMemory ?? 0),
  );

  console.table([
    {
      target: 'Redis',
      rps: redis.requestsPerSecond.toFixed(0),
      p50_ms: redis.p50Ms.toFixed(2),
      p95_ms: redis.p95Ms.toFixed(2),
      p99_ms: redis.p99Ms.toFixed(2),
      errors: redis.errors,
      dbsize: redis.memoryAfter.dbsize,
      memory_delta_mb: (redisMem / 1024 / 1024).toFixed(2),
    },
    {
      target: 'SnugKV',
      rps: snug.requestsPerSecond.toFixed(0),
      p50_ms: snug.p50Ms.toFixed(2),
      p95_ms: snug.p95Ms.toFixed(2),
      p99_ms: snug.p99Ms.toFixed(2),
      errors: snug.errors,
      dbsize: snug.memoryAfter.dbsize,
      memory_delta_mb: (snugMem / 1024 / 1024).toFixed(2),
    },
  ]);

  console.log(
    `SnugKV vs Redis: throughput ${pct(snug.requestsPerSecond, redis.requestsPerSecond).toFixed(1)}%, ` +
      `p95 ${pct(snug.p95Ms, redis.p95Ms).toFixed(1)}%, ` +
      `memory ${redisMem > 0 ? pct(snugMem, redisMem).toFixed(1) + '%' : 'n/a'}`,
  );

  console.log(JSON.stringify({ config, redis, snug }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
