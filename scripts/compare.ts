type TargetName = 'redis' | 'snug';

type Config = {
  requests: number;
  concurrency: number;
  seed: number;
  redisUrl: string;
  snugUrl: string;
  warmup: number;
  only: 'redis' | 'snug' | 'both';
};

type Metrics = {
  target: string;
  dbsize: number;
  usedMemory: number | null;
  usedMemoryRss: number | null;
};

type ScenarioName =
  | 'catalog'
  | 'session-write'
  | 'session-read'
  | 'cart'
  | 'activity'
  | 'rate-limit'
  | 'tags'
  | 'leaderboard'
  | 'counter';

type ScenarioStats = {
  requests: number;
  errors: number;
  requestsPerSecond: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
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
  scenarios: Record<string, ScenarioStats>;
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
  only: arg('only', 'both') as 'redis' | 'snug' | 'both',
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
    return { scenario: 'catalog' as ScenarioName, method: 'GET', path: `/api/scenarios/catalog/${productId}` };
  }
  if (bucket < 48) {
    return {
      scenario: 'session-write' as ScenarioName,
      method: 'POST',
      path: `/api/scenarios/session/${userId}`,
      body: JSON.stringify({ device: `device-${n % 5000}`, request: index }),
    };
  }
  if (bucket < 56) {
    return { scenario: 'session-read' as ScenarioName, method: 'GET', path: `/api/scenarios/session/${userId}` };
  }
  if (bucket < 68) {
    return {
      scenario: 'cart' as ScenarioName,
      method: 'POST',
      path: `/api/scenarios/cart/${userId}/${productId}/${(n % 5) + 1}`,
    };
  }
  if (bucket < 76) {
    return {
      scenario: 'activity' as ScenarioName,
      method: 'POST',
      path: `/api/scenarios/activity/${userId}/view/${productId}`,
    };
  }
  if (bucket < 83) {
    return { scenario: 'rate-limit' as ScenarioName, method: 'POST', path: `/api/scenarios/rate-limit/${userId}` };
  }
  if (bucket < 89) {
    return {
      scenario: 'tags' as ScenarioName,
      method: 'POST',
      path: `/api/scenarios/tags/${userId}/tag-${n % 250}`,
    };
  }
  if (bucket < 95) {
    return {
      scenario: 'leaderboard' as ScenarioName,
      method: 'POST',
      path: `/api/scenarios/leaderboard/${userId}/${(n % 10) + 1}`,
    };
  }
  return { scenario: 'counter' as ScenarioName, method: 'POST', path: `/api/scenarios/counter/api-requests/1` };
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return response.json() as Promise<T>;
}

async function execute(baseUrl: string, index: number): Promise<{ latency: number; scenario: ScenarioName }> {
  const request = requestFor(index);
  const start = performance.now();
  const response = await fetch(baseUrl + request.path, {
    method: request.method,
    headers: request.body ? { 'content-type': 'application/json' } : undefined,
    body: request.body,
  });
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { latency: performance.now() - start, scenario: request.scenario };
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
  const byScenario = new Map<ScenarioName, { latencies: number[]; errors: number }>();
  let errors = 0;
  let next = 0;
  const started = performance.now();

  const workers = Array.from({ length: config.concurrency }, async () => {
    while (true) {
      const index = next++;
      if (index >= config.requests) return;
      try {
        const result = await execute(baseUrl, index);
        latencies.push(result.latency);
        const current = byScenario.get(result.scenario) ?? { latencies: [], errors: 0 };
        current.latencies.push(result.latency);
        byScenario.set(result.scenario, current);
      } catch {
        errors++;
      }
    }
  });

  await Promise.all(workers);
  const durationMs = performance.now() - started;
  const memoryAfter = await json<Metrics>(baseUrl + '/api/metrics');
  latencies.sort((a, b) => a - b);

  const scenarios: Record<string, ScenarioStats> = {};
  for (const [name, stats] of byScenario) {
    stats.latencies.sort((a, b) => a - b);
    scenarios[name] = {
      requests: stats.latencies.length,
      errors: stats.errors,
      requestsPerSecond: (stats.latencies.length / durationMs) * 1000,
      p50Ms: percentile(stats.latencies, 0.5),
      p95Ms: percentile(stats.latencies, 0.95),
      p99Ms: percentile(stats.latencies, 0.99),
    };
  }

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
    scenarios,
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

  if (config.only === 'redis') {
    const redis = await run('redis', config.redisUrl);
    console.log(JSON.stringify({ config, redis }, null, 2));
    return;
  }
  if (config.only === 'snug') {
    const snug = await run('snug', config.snugUrl);
    console.log(JSON.stringify({ config, snug }, null, 2));
    return;
  }

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

  console.log('\nPer-scenario latency:');
  const scenarioNames = Array.from(
    new Set([...Object.keys(redis.scenarios), ...Object.keys(snug.scenarios)]),
  );
  console.table(
    scenarioNames.map((name) => ({
      scenario: name,
      redis_count: redis.scenarios[name]?.requests ?? 0,
      redis_p95_ms: redis.scenarios[name]?.p95Ms.toFixed(2) ?? '-',
      snug_count: snug.scenarios[name]?.requests ?? 0,
      snug_p95_ms: snug.scenarios[name]?.p95Ms.toFixed(2) ?? '-',
      p95_delta_pct:
        redis.scenarios[name] && snug.scenarios[name]
          ? pct(snug.scenarios[name].p95Ms, redis.scenarios[name].p95Ms).toFixed(1)
          : '-',
    })),
  );

  console.log(JSON.stringify({ config, redis, snug }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
