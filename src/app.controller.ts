import { Controller, Get } from '@nestjs/common';
import { RedisService } from './redis.service';

@Controller('api')
export class AppController {
  constructor(private readonly redis: RedisService) {}

  @Get('health')
  async health() {
    const start = process.hrtime.bigint();
    const pong = await this.redis.client.ping();
    const latencyUs = Number(process.hrtime.bigint() - start) / 1_000;
    return {
      ok: pong === 'PONG',
      target: this.redis.target,
      host: this.redis.host,
      port: this.redis.port,
      pingUs: Math.round(latencyUs * 100) / 100,
    };
  }

  @Get('metrics')
  async metrics() {
    return this.redis.metrics();
  }
}
