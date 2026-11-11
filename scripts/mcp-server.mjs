#!/usr/bin/env node
/**
 * DevPilot MCP Server（第三阶段 9.20 开放接口第一批）
 *
 * MCP stdio 传输：newline-delimited JSON-RPC 2.0（MCP 2024-11-05 spec）。
 * 零依赖——node:readline 读 stdin 行，逐行解析 JSON-RPC，响应写 stdout。
 *
 * 暴露 tools（全部只读或幂等操作，走本机 127.0.0.1:37100 REST）：
 *   devpilot.health        后端健康与版本
 *   devpilot.projects      项目列表
 *   devpilot.tasks         任务列表
 *   devpilot.task.create   创建任务（goal 必填）
 *   devpilot.services      运行中服务状态
 *   devpilot.notifications 最近通知
 *
 * 接入示例（Claude Desktop / 任意 MCP 客户端）：
 *   { "command": "node", "args": ["C:/Users/administer/WorkBuddy/DevPilot/scripts/mcp-server.mjs"] }
 */
import readline from 'node:readline';

const API = process.env.DEVIPILOT_API ?? 'http://127.0.0.1:37100/api/v1';
const SERVER_INFO = { name: 'devpilot', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'devpilot.health',
    description: 'DevPilot 后端健康状态与版本',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'devpilot.projects',
    description: '列出 DevPilot 管理的全部项目（名称/路径/类型/分析状态）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'devpilot.tasks',
    description: '列出最近任务（目标/状态/结果摘要）',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '返回条数，默认 10' } } },
  },
  {
    name: 'devpilot.task.create',
    description: '创建一个 Agent 任务（可选 run=true 立即执行；执行需后端已配置模型 Key）',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '任务目标描述' },
        run: { type: 'boolean', description: '创建后立即执行，默认 false' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'devpilot.task.run',
    description: '外部触发执行一个已创建的任务。首次调用会生成待审批记录（返回 approvalId），用户在 DevPilot 审批中心批准后重试即执行',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: '任务 ID' } },
      required: ['taskId'],
    },
  },
  {
    name: 'devpilot.services',
    description: '列出服务运行状态（名称/状态/端口）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'devpilot.notifications',
    description: '最近通知（标题/类型/优先级/已读）',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '返回条数，默认 10' } } },
  },
];

async function apiGet(path) {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return r.json();
}

async function callTool(name, args) {
  switch (name) {
    case 'devpilot.health':
      return await apiGet('/health');
    case 'devpilot.projects': {
      const rows = await apiGet('/projects');
      return rows.map((p) => ({ id: p.id, name: p.name, root_path: p.root_path, type: p.project_type, analysis: p.analysis_status }));
    }
    case 'devpilot.tasks': {
      const rows = await apiGet('/tasks');
      return (Array.isArray(rows) ? rows : []).slice(0, args?.limit ?? 10).map((t) => ({
        id: t.id, goal: (t.input_summary ?? '').slice(0, 100), status: t.status, result: (t.result_summary ?? '').slice(0, 150),
      }));
    }
    case 'devpilot.task.create': {
      const created = await fetch(`${API}/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: String(args.goal) }),
      }).then((r) => r.json());
      if (args?.run === true) {
        await fetch(`${API}/tasks/${created.taskId}/run`, { method: 'POST' }).catch(() => {});
      }
      return created;
    }
    case 'devpilot.task.run': {
      const r = await fetch(`${API}/tasks/${args.taskId}/run-external`, { method: 'POST' });
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      return r.json();
    }
    case 'devpilot.services': {
      const rows = await apiGet('/services/status');
      return (Array.isArray(rows) ? rows : []).map((s) => ({ name: s.name, status: s.status, port: s.port }));
    }
    case 'devpilot.notifications': {
      const rows = await apiGet('/notifications');
      return (Array.isArray(rows) ? rows : []).slice(0, args?.limit ?? 10).map((n) => ({
        title: n.title, type: n.type, priority: n.priority, read: !!n.read, at: n.created_at,
      }));
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    respondError(null, -32700, 'Parse error');
    return;
  }
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      respond(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    } else if (method === 'notifications/initialized') {
      /* 客户端确认，无响应 */
    } else if (method === 'ping') {
      respond(id, {});
    } else if (method === 'tools/list') {
      respond(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      const out = await callTool(params.name, params.arguments ?? {});
      respond(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
    } else if (id !== undefined) {
      respondError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (id !== undefined) respondError(id, -32000, String(e).slice(0, 200));
  }
});
