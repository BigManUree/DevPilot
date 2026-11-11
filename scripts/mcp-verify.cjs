/* MCP server 端到端验证（自包含；全局收集响应避免时序竞态） */
const { spawn, execSync } = require('node:child_process');
const readline = require('node:readline');
(async () => {
  try { execSync('powershell -NoProfile -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort 37100 -State Listen)[0].OwningProcess -Force -Confirm:$false"', { stdio: 'ignore' }); } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  const backend = spawn('node', ['dist/main.js'], { cwd: 'C:/Users/administer/WorkBuddy/DevPilot/apps/backend', stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { const h = await fetch('http://127.0.0.1:37100/api/v1/health'); if (h.ok) break; } catch {}
  }
  console.log('backend up');

  const mcp = spawn('node', ['C:/Users/administer/WorkBuddy/DevPilot/scripts/mcp-server.mjs'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const responses = [];
  readline.createInterface({ input: mcp.stdout }).on('line', (line) => {
    try { responses.push(JSON.parse(line)); } catch {}
  });
  const waitResponse = (id) => new Promise(async (res) => {
    for (let i = 0; i < 40; i++) {
      const r = responses.find((x) => x.id === id);
      if (r) return res(r);
      await new Promise((r2) => setTimeout(r2, 100));
    }
    res(null);
  });

  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  const init = await waitResponse(1);
  console.log('1 initialize:', init ? `protocol=${init.result.protocolVersion} server=${init.result.serverInfo.name}` : 'TIMEOUT');

  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  const tools = await waitResponse(2);
  console.log('2 tools/list:', tools ? tools.result.tools.map((t) => t.name).join(', ') : 'TIMEOUT');

  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'devpilot.health', arguments: {} } }) + '\n');
  const health = await waitResponse(3);
  console.log('3 call health:', health ? health.result.content[0].text.slice(0, 80) : 'TIMEOUT');

  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'devpilot.projects', arguments: {} } }) + '\n');
  const projects = await waitResponse(4);
  const plist = projects ? JSON.parse(projects.result.content[0].text) : [];
  console.log('4 call projects:', plist.length, '个项目:', plist.map((p) => p.name).slice(0, 3).join('/'));

  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'devpilot.task.create', arguments: { goal: '__mcp_test__ 验证任务创建' } } }) + '\n');
  const created = await waitResponse(5);
  const c = created ? JSON.parse(created.result.content[0].text) : {};
  console.log('5 task.create:', c.taskId ? 'taskId=' + c.taskId.slice(0, 8) : JSON.stringify(c).slice(0, 100));

  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'devpilot.task.run', arguments: { taskId: c.taskId } } }) + '\n');
  const run = await waitResponse(7);
  const runBody = run ? JSON.parse(run.result.content[0].text) : {};
  console.log('7 task.run（外部触发）:', runBody.pendingApproval ? `pendingApproval=true approvalId=${runBody.approvalId.slice(0, 8)}` : JSON.stringify(runBody).slice(0, 100));

  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'devpilot.unknown', arguments: {} } }) + '\n');
  const err = await waitResponse(6);
  console.log('6 unknown tool:', err ? `error.code=${err.error.code} msg=${err.error.message.slice(0, 50)}` : 'TIMEOUT');

  mcp.kill();
  try { execSync('taskkill /pid ' + backend.pid + ' /T /F', { stdio: 'ignore' }); } catch {}
  console.log('cleaned');
  process.exit(0);
})();
