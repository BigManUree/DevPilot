import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';

/**
 * 本地后端：仅监听 127.0.0.1，不暴露外网（系统总体架构第 3 节约束）。
 * 端口可被 DEVIPILOT_BACKEND_PORT 覆盖。
 */
async function bootstrap() {
  const port = Number(process.env.DEVIPILOT_BACKEND_PORT ?? 37100);
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });
  // 开发期 CORS：vite dev(5173) / vite preview(4173) / Electron file://
  app.enableCors({ origin: ['http://localhost:5173', 'http://127.0.0.1:4173', 'file://'] });
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(port, '127.0.0.1');
  // eslint-disable-next-line no-console
  console.log(`[DevPilot] backend listening on http://127.0.0.1:${port}/api/v1`);
}
void bootstrap();
