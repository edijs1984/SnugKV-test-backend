import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableCors();
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), '127.0.0.1');
}

void bootstrap();
