import { Controller, Get, Post, Query, Body, BadRequestException, ConflictException } from '@nestjs/common';
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
    // 符号链接逃逸防护：真实路径仍必须落在项目根内。
    // 新建文件（目标尚不存在）时 realpath 会失败——改为校验父目录真实路径，
    // 否则「在工作区里新建文件」永远 400（审计 F-01）。
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      try {
        const parentReal = fs.realpathSync(path.dirname(abs));
        real = path.join(parentReal, path.basename(abs));
      } catch {
        throw new BadRequestException(`路径不存在或不可访问：${abs}`);
      }
    }
    try {
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
    let st: fs.Stats;
    try {
      st = fs.statSync(root);
    } catch {
      throw new BadRequestException(`目录不存在：${root}`);
    }
    if (!st.isDirectory()) throw new BadRequestException(`不是目录：${root}`);
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
    let st: fs.Stats;
    try {
      st = fs.statSync(real);
    } catch {
      throw new BadRequestException(`文件不存在：${real}`);
    }
    if (!st.isFile()) throw new BadRequestException('目标不是文件');
    if (st.size > 2 * 1024 * 1024) throw new BadRequestException(`文件超过 2MB 读取上限（${st.size}B）`);
    const r = await this.gateway.call({
      subjectType: 'user',
      subjectId: 'local-user',
      tool: 'fs.read',
      params: { path: real },
    });
    if (!r.ok) throw new BadRequestException(r.error ?? '读取失败');
    // 编码兜底（审计 C-03）：旧实现一律按 UTF-8 解码，GBK 文件在编辑器里是乱码。
    // 先严格 UTF-8 解码，失败再试 GBK；二进制（含 NUL）直接标记 binary，不返回垃圾文本。
    const buf = fs.readFileSync(real);
    if (buf.includes(0)) {
      return { path: real, content: '', size: buf.byteLength, binary: true, encoding: null };
    }
    let content: string;
    let encoding = 'utf-8';
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      try {
        content = new TextDecoder('gbk').decode(buf);
        encoding = 'gbk';
      } catch {
        content = buf.toString('utf-8');
      }
    }
    return { path: real, content, size: Buffer.byteLength(content), encoding, binary: false };
  }

  /** 写文件：user 身份走网关（原子写 + .devpilot-backup + 审计），路径必须在项目内 */
  @Post('file')
  async writeFile(@Body() body: { filePath: string; content: string }) {
    if (typeof body?.content !== 'string') throw new BadRequestException('缺少 content（必须为字符串）');
    const real = this.assertProjectPath(body.filePath);
    const r = await this.gateway.call({
      subjectType: 'user',
      subjectId: 'local-user',
      tool: 'fs.write',
      params: { path: real, content: body.content },
    });
    // 审计 F-04：写入失败不能返回 2xx，否则前端会把「没写进去」当成功
    if (!r.ok) throw new ConflictException(r.error ?? '写入失败');
    return { ok: true, error: null, path: real };
  }
}
