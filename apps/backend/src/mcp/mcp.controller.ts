import { Body, Controller, Post } from '@nestjs/common';

/**
 * MCP Streamable HTTP 端点（第三阶段 9.20，B3 第一批）：
 * 单端点 POST /api/v1/mcp，接受 JSON-RPC 2.0 请求，application/json 单响应
 * （MCP spec 允许非流式响应；SSE 流式待议）。
 * 能力与 scripts/mcp-server.mjs（stdio）一致：tools/resources/prompts。
 * 工具执行经本机 REST 自环（与 stdio server 相同路径，行为一致）。
 */
const API = process.env.DEVIPILOT_MCP_API ?? 'http://127.0.0.1:37100/api/v1';

const TOOLS = [
  { name: 'devpilot.health', description: 'DevPilot 后端健康状态与版本', inputSchema: { type: 'object', properties: {} } },
  { name: 'devpilot.projects', description: '列出项目', inputSchema: { type: 'object', properties: {} } },
  { name: 'devpilot.tasks', description: '列出最近任务', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'devpilot.task.create', description: '创建任务', inputSchema: { type: 'object', properties: { goal: { type: 'string' }, run: { type: 'boolean' } }, required: ['goal'] } },
  { name: 'devpilot.task.run', description: '外部触发执行任务（审批双门）', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } },
  { name: 'devpilot.services', description: '服务状态', inputSchema: { type: 'object', properties: {} } },
  { name: 'devpilot.notifications', description: '最近通知', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
];

const RESOURCES = [
  { uri: 'devpilot://projects', name: '项目清单', mimeType: 'application/json' },
  { uri: 'devpilot://notifications', name: '最近通知', mimeType: 'application/json' },
];

const PROMPTS = [
  { name: 'devpilot-task-summary', description: '基于最近任务生成工作摘要', arguments: [{ name: 'limit', required: false }] },
];

async function apiGet(path: string) {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return r.json();
}

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'devpilot.health': return await apiGet('/health');
    case 'devpilot.projects': return await apiGet('/projects');
    case 'devpilot.tasks': {
      const rows = await apiGet('/tasks');
      return (Array.isArray(rows) ? rows : []).slice(0, Number(args?.limit ?? 10)).map((t: any) => ({ id: t.id, goal: (t.input_summary ?? '').slice(0, 100), status: t.status }));
    }
    case 'devpilot.task.create': {
      const created = await fetch(`${API}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal: String(args.goal) }) }).then((r) => r.json());
      if (args?.run === true) await fetch(`${API}/tasks/${created.taskId}/run-external`, { method: 'POST' }).catch(() => {});
      return created;
    }
    case 'devpilot.task.run': {
      const r = await fetch(`${API}/tasks/${args.taskId}/run-external`, { method: 'POST' });
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      return r.json();
    }
    case 'devpilot.services': {
      const rows = await apiGet('/services/status');
      return (Array.isArray(rows) ? rows : []).map((s: any) => ({ name: s.name, status: s.status, port: s.port }));
    }
    case 'devpilot.notifications': {
      const rows = await apiGet('/notifications');
      return (Array.isArray(rows) ? rows : []).slice(0, Number(args?.limit ?? 10)).map((n: any) => ({ title: n.title, type: n.type, priority: n.priority, read: !!n.read }));
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

@Controller('api/v1/mcp')
export class McpController {
  @Post()
  async handle(@Body() msg: any) {
    const { id, method, params } = msg ?? {};
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    const err = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      switch (method) {
        case 'initialize':
          return ok({ protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'devpilot', version: '0.1.0' } });
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({ tools: TOOLS });
        case 'tools/call': {
          const out = await callTool(params.name, params.arguments ?? {});
          return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
        }
        case 'resources/list':
          return ok({ resources: RESOURCES });
        case 'resources/read': {
          const data = params.uri === 'devpilot://projects'
            ? await apiGet('/projects')
            : params.uri === 'devpilot://notifications'
              ? await apiGet('/notifications')
              : (() => { throw new Error(`unknown resource: ${params.uri}`); })();
          return ok({ contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] });
        }
        case 'prompts/list':
          return ok({ prompts: PROMPTS });
        case 'prompts/get': {
          if (params.name !== 'devpilot-task-summary') throw new Error(`unknown prompt: ${params.name}`);
          const rows = await apiGet('/tasks');
          const lines = (Array.isArray(rows) ? rows : []).slice(0, Number(params.arguments?.limit ?? 5)).map((t: any) => `- [${t.status}] ${(t.input_summary ?? '').slice(0, 80)}`);
          return ok({ messages: [{ role: 'user', content: { type: 'text', text: `以下是 DevPilot 最近任务状态：\n${lines.join('\n')}\n\n请用中文写一段不超过 200 字的工作进展摘要。` } }] });
        }
        default:
          return err(-32601, `Method not found: ${method}`);
      }
    } catch (e) {
      return err(-32000, String(e).slice(0, 200));
    }
  }
}
