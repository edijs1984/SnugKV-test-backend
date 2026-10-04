import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { RedisService } from './redis.service';
import { ScenariosService } from './scenarios.service';

const int = (value: string, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};

@Controller('api/scenarios')
export class ScenariosController {
  constructor(
    private readonly scenarios: ScenariosService,
    private readonly kv: RedisService,
  ) {}

  @Delete('reset')
  reset() {
    return this.kv.reset();
  }

  @Get('catalog/:id')
  catalog(@Param('id') id: string) {
    return this.scenarios.catalog(int(id));
  }

  @Post('session/:userId')
  setSession(
    @Param('userId') userId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.scenarios.setSession(int(userId), body ?? {});
  }

  @Get('session/:userId')
  getSession(@Param('userId') userId: string) {
    return this.scenarios.getSession(int(userId));
  }

  @Post('cart/:userId/:productId/:quantity')
  addCart(
    @Param('userId') userId: string,
    @Param('productId') productId: string,
    @Param('quantity') quantity: string,
  ) {
    return this.scenarios.addCart(int(userId), int(productId), int(quantity, 1));
  }

  @Get('cart/:userId')
  getCart(@Param('userId') userId: string) {
    return this.scenarios.getCart(int(userId));
  }

  @Post('activity/:userId/:type/:entityId')
  addActivity(
    @Param('userId') userId: string,
    @Param('type') type: string,
    @Param('entityId') entityId: string,
  ) {
    return this.scenarios.addActivity(int(userId), type, int(entityId));
  }

  @Get('activity/:userId')
  getActivity(@Param('userId') userId: string) {
    return this.scenarios.getActivity(int(userId));
  }

  @Post('tags/:userId/:tag')
  addTag(@Param('userId') userId: string, @Param('tag') tag: string) {
    return this.scenarios.addTag(int(userId), tag);
  }

  @Get('tags/:userId')
  getTags(@Param('userId') userId: string) {
    return this.scenarios.getTags(int(userId));
  }

  @Post('leaderboard/:userId/:delta')
  leaderboard(@Param('userId') userId: string, @Param('delta') delta: string) {
    return this.scenarios.leaderboard(int(userId), int(delta, 1));
  }

  @Post('rate-limit/:userId')
  rateLimit(@Param('userId') userId: string) {
    return this.scenarios.rateLimit(int(userId));
  }

  @Post('counter/:name/:delta')
  counter(@Param('name') name: string, @Param('delta') delta: string) {
    return this.scenarios.counter(name, int(delta, 1));
  }
}
