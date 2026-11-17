import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { json, urlencoded, type NextFunction, type Request, type Response } from 'express';
import { AppModule } from './app.module';
import { authGuard, authToken, DEV_ORIGINS } from './auth';
import { markBackend } from './startup-trace';

/**
 * 本地后端：仅监听 127.0.0.1，不暴露外网（系统总体架构第 3 节约束）。
 * 端口可被 DEVIPILOT_BACKEND_PORT 覆盖。
 */
async function bootstrap() {
  const port = Number(process.env.DEVIPILOT_BACKEND_PORT ?? 37100);
  markBackend('requireDone');
  // bodyParser:false → 自挂 json/urlencoded：默认 json 上限 100KB 会让 2MB 项目图标
  // 的 base64 请求体在进控制器前就被 413（request entity too large）拒掉
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'], bodyParser: false });
  markBackend('nestCreated');

  // 本机防 CSRF 守卫必须在 body parser 之前：被拒绝的跨源请求不消耗解析开销，
  // 也不进入任何控制器（审计 S-01 修复）。
  app.use(authGuard);

  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));

  // body parser 错误语义修正：解析失败/超限应返回 400/413，而不是 Nest 兜底的 500（审计 F-04）。
  app.use((err: Error & { type?: string; status?: number; statusCode?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    const status = err.status ?? err.statusCode ?? (err.type === 'entity.too.large' ? 413 : 400);
    if (status >= 400 && status < 500) {
      res.status(status).json({
        statusCode: status,
        error: status === 413 ? 'Payload Too Large' : 'Bad Request',
        message: err.type === 'entity.too.large' ? '请求体超过 10MB 上限' : `请求体解析失败：${err.message}`,
      });
      return;
    }
    next(err);
  });

  // CORS：只回显 DevPilot 自己的前端来源（真防线是 authGuard 的 token，CORS 只负责让前端能读到响应）。
  // 'null' 是打包态 file:// 渲染层的 Origin，必须回显，否则响应被浏览器拦掉。
  app.enableCors({
    origin: (origin, cb) => {
      const ok = origin === undefined || DEV_ORIGINS.has(origin) || origin === 'null' || origin === 'file://';
      cb(null, ok);
    },
    allowedHeaders: ['Content-Type', 'X-DevPilot-Token'],
  });
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(port, '127.0.0.1');
  markBackend('listening', { port });
  // 本机 token 写盘（0600），Electron 打包态渲染层从 preload 取得同一份 token
  authToken();
  markBackend('authTokenReady');
  // eslint-disable-next-line no-console
  console.log(`[DevPilot] backend listening on http://127.0.0.1:${port}/api/v1`);
}
void bootstrap();
