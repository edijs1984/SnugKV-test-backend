import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { RedisService } from './redis.service';
import { ScenariosController } from './scenarios.controller';
import { ScenariosService } from './scenarios.service';

@Module({
  controllers: [AppController, ScenariosController],
  providers: [RedisService, ScenariosService],
})
export class AppModule {}
