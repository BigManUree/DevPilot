import { Controller, Get, Post, Query, Body } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ToolGatewayService } from '../permissions/tool-gateway.service';

/** 代码工作区：目录浏览 / 文件读写（写走 ToolGateway，含备份+审计） */
@Controller('api/v1/workspace')
export class WorkspaceController {
  constructor(private readonly gateway: ToolGatewayService) {}

  /** 目录列表（一层；带 file 类型标记） */
  @Get('dir')
  listDir(@Query('dirPath') dirPath: string) {
    const root = dirPath || 'C:/';
    const entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => !/^(node_modules|\.git|dist|build|target)$/.test(e.name))
      .map((e) => ({
        name: e.name,
        path: path.join(root, e.name).replace(/\\/g, '/'),
        isDir: e.isDirectory(),
        ext: path.extname(e.name).slice(1),
      }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return { root, entries };
  }

  /** 读文件 */
  @Get('file')
  readFile(@Query('filePath') filePath: string) {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { path: filePath, content, size: Buffer.byteLength(content) };
  }

  /** 写文件：user 身份走网关（原子写 + .devpilot-backup + 审计） */
  @Post('file')
  async writeFile(@Body() body: { filePath: string; content: string }) {
    const r = await this.gateway.call({
      subjectType: 'user',
      subjectId: 'local-user',
      tool: 'fs.write',
      params: { path: body.filePath, content: body.content },
    });
    return { ok: r.ok, error: r.error ?? null, path: body.filePath };
  }
}
