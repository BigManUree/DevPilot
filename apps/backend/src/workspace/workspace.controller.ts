import { Controller, Get, Post, Query, Body, BadRequestException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ToolGatewayService } from '../permissions/tool-gateway.service';
import { DatabaseService } from '../database/database.module';

/**
 * 代码工作区：目录浏览 / 文件读写。
 * 安全修复（审计 S1）：
 * - 所有访问限制在已注册项目的 root_path 之内（真实路径校验 + realpath 符号链接校验 + 穿越/绝对路径拒绝）
 * - 读也走网关（审计落库），并限制大小
 */
@Controller('api/v1/workspace')
export class WorkspaceController {
  constructor(
    private readonly gateway: ToolGatewayService,
    private readonly ds: DatabaseService,
  ) {}

  /** 校验目标路径位于某个已注册项目根之内；返回归一化后的绝对路径 */
  private assertProjectPath(target: string): string {
    if (!target) throw new BadRequestException('缺少路径参数');
    const abs = path.resolve(target);
    const projects = this.ds.db.prepare('SELECT id, root_path FROM projects').all() as Array<{ id: string; root_path: string }>;
    const inside = projects.find((p) => {
      const root = path.resolve(p.root_path);
      const rel = path.relative(root, abs);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!inside) throw new BadRequestException(`路径不在任何已注册项目内，拒绝访问：${abs}`);
    // 符号链接逃逸防护：真实路径仍必须落在项目根内
    try {
      const real = fs.realpathSync(abs);
      const root = fs.realpathSync(path.resolve(inside.root_path));
      const rel = path.relative(root, real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new BadRequestException('路径经符号链接逃逸出项目目录，拒绝访问');
      return real;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`路径不存在或不可访问：${abs}`);
    }
  }

  /** 目录列表（一层；带 file 类型标记） */
  @Get('dir')
  listDir(@Query('dirPath') dirPath: string) {
    const root = this.assertProjectPath(dirPath);
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

  /** 读文件（限制大小 2MB，走网关审计） */
  @Get('file')
  async readFile(@Query('filePath') filePath: string) {
    const real = this.assertProjectPath(filePath);
    const st = fs.statSync(real);
    if (!st.isFile()) throw new BadRequestException('目标不是文件');
    if (st.size > 2 * 1024 * 1024) throw new BadRequestException(`文件超过 2MB 读取上限（${st.size}B）`);
    const r = await this.gateway.call({
      subjectType: 'user',
      subjectId: 'local-user',
      tool: 'fs.read',
      params: { path: real },
    });
    if (!r.ok) throw new BadRequestException(r.error ?? '读取失败');
    const content = (r.data as { content: string }).content;
    return { path: real, content, size: Buffer.byteLength(content) };
  }

  /** 写文件：user 身份走网关（原子写 + .devpilot-backup + 审计），路径必须在项目内 */
  @Post('file')
  async writeFile(@Body() body: { filePath: string; content: string }) {
    const real = this.assertProjectPath(body.filePath);
    const r = await this.gateway.call({
      subjectType: 'user',
      subjectId: 'local-user',
      tool: 'fs.write',
      params: { path: real, content: body.content },
    });
    return { ok: r.ok, error: r.error ?? null, path: real };
  }
}
