import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

export type KvTarget = 'redis' | 'snug';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly target: KvTarget =
    process.env.TARGET?.toLowerCase() === 'redis' ? 'redis' : 'snug';
  readonly host = process.env.KV_HOST ?? '127.0.0.1';
  readonly port = Number(
    process.env.KV_PORT ?? (this.target === 'redis' ? 6390 : 6383),
  );
  readonly prefix = process.env.KEY_PREFIX ?? 'real:';

  readonly client = new Redis({
    host: this.host,
    port: this.port,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    lazyConnect: false,
    connectionName: `snug-real-life-${this.target}`,
  });

  key(...parts: Array<string | number>) {
    return this.prefix + parts.join(':');
  }

  async metrics() {
    const [info, dbsize] = await Promise.all([
      this.client.info('memory'),
      this.client.dbsize(),
    ]);

    const memory: Record<string, number> = {};
    for (const line of info.split('\r\n')) {
      const index = line.indexOf(':');
      if (index <= 0) continue;
      const name = line.slice(0, index);
      const value = Number(line.slice(index + 1));
      if (Number.isFinite(value)) memory[name] = value;
    }

    let snugStats: unknown = null;
    if (this.target === 'snug') {
      try {
        snugStats = await this.client.call('SNUG.STATS');
      } catch {
        // Keep the HTTP comparison compatible with Redis and older SnugKV builds.
      }
    }

    return {
      target: this.target,
      address: `${this.host}:${this.port}`,
      dbsize,
      usedMemory: memory.used_memory ?? null,
      usedMemoryRss: memory.used_memory_rss ?? null,
      maxMemory: memory.maxmemory ?? null,
      snugStats,
    };
  }

  async reset() {
    await this.client.flushdb();
    return { ok: true, target: this.target };
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
