import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

function productPayload(id: number) {
  const category = ['compute', 'storage', 'network', 'security'][id % 4];
  return {
    id,
    sku: `SKU-${String(id).padStart(8, '0')}`,
    name: `Production product ${id}`,
    category,
    priceCents: 999 + (id % 50000),
    stock: 10 + (id % 500),
    flags: { featured: id % 11 === 0, discounted: id % 7 === 0 },
    description: `Reliable ${category} component. `.repeat(28),
    updatedAt: '2026-10-04T00:00:00.000Z',
  };
}

@Injectable()
export class ScenariosService {
  private readonly benchmarkMode = process.env.BENCHMARK_MODE !== '0';
  private readonly longTtl = Number(process.env.BENCHMARK_TTL_SECONDS ?? 21600);

  constructor(private readonly kv: RedisService) {}

  private ttl(normalSeconds: number) {
    return this.benchmarkMode ? this.longTtl : normalSeconds;
  }

  async catalog(id: number) {
    const key = this.kv.key('catalog', id);
    const cached = await this.kv.client.get(key);
    if (cached) return { cache: 'hit', data: JSON.parse(cached) };

    const data = productPayload(id);
    await this.kv.client.set(key, JSON.stringify(data), 'EX', this.ttl(300));
    return { cache: 'miss', data };
  }

  async setSession(userId: number, body: Record<string, unknown>) {
    const session = {
      userId,
      email: `user${userId}@example.test`,
      roles: userId % 20 === 0 ? ['user', 'admin'] : ['user'],
      locale: userId % 3 === 0 ? 'lv-LV' : 'en-GB',
      recentViews: Array.from({ length: 12 }, (_, i) => (userId * 31 + i) % 100000),
      preferences: {
        currency: 'EUR',
        compact: userId % 2 === 0,
        recommendations: true,
      },
      ...body,
      touchedAt: Date.now(),
    };
    await this.kv.client.set(
      this.kv.key('session', userId),
      JSON.stringify(session),
      'EX',
      this.ttl(1800),
    );
    return session;
  }

  async getSession(userId: number) {
    const value = await this.kv.client.get(this.kv.key('session', userId));
    return value ? JSON.parse(value) : null;
  }

  async addCart(userId: number, productId: number, quantity: number) {
    const key = this.kv.key('cart', userId);
    const value = JSON.stringify({
      productId,
      quantity: Math.max(1, Math.min(quantity, 99)),
      priceCents: 999 + (productId % 50000),
      updatedAt: Date.now(),
    });
    const pipeline = this.kv.client.pipeline();
    pipeline.hset(key, String(productId), value);
    pipeline.expire(key, this.ttl(86400));
    await pipeline.exec();
    return { userId, productId, quantity };
  }

  async getCart(userId: number) {
    const entries = await this.kv.client.hgetall(this.kv.key('cart', userId));
    return Object.values(entries as Record<string, string>).map((value) =>
      JSON.parse(value),
    );
  }

  async addActivity(userId: number, type: string, entityId: number) {
    const key = this.kv.key('activity', userId);
    const event = JSON.stringify({ type, entityId, at: Date.now() });
    const pipeline = this.kv.client.pipeline();
    pipeline.lpush(key, event);
    pipeline.ltrim(key, 0, 99);
    pipeline.expire(key, this.ttl(3600));
    await pipeline.exec();
    return { ok: true };
  }

  async getActivity(userId: number) {
    const values = await this.kv.client.lrange(this.kv.key('activity', userId), 0, 19);
    return values.map((value) => JSON.parse(value));
  }

  async addTag(userId: number, tag: string) {
    const key = this.kv.key('tags', userId);
    const pipeline = this.kv.client.pipeline();
    pipeline.sadd(key, tag);
    pipeline.expire(key, this.ttl(86400));
    await pipeline.exec();
    return { ok: true };
  }

  async getTags(userId: number) {
    return this.kv.client.smembers(this.kv.key('tags', userId));
  }

  async leaderboard(userId: number, delta: number) {
    const key = this.kv.key('leaderboard', 'global');
    await this.kv.client.zincrby(key, delta, String(userId));
    const pipeline = this.kv.client.pipeline();
    pipeline.zrevrank(key, String(userId));
    pipeline.zrevrange(key, 0, 9, 'WITHSCORES');
    const result = await pipeline.exec();
    return {
      rank: Number(result?.[0]?.[1] ?? -1),
      top: result?.[1]?.[1] ?? [],
    };
  }

  async rateLimit(userId: number) {
    const bucket = this.benchmarkMode
      ? 'benchmark'
      : String(Math.floor(Date.now() / 60_000));
    const key = this.kv.key('rate', userId, bucket);
    const value = await this.kv.client.incr(key);
    if (value === 1) await this.kv.client.expire(key, this.ttl(65));
    return { count: value, allowed: value <= 120 };
  }

  async counter(name: string, delta: number) {
    const value = await this.kv.client.incrby(this.kv.key('counter', name), delta);
    return { name, value };
  }
}
