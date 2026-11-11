/* P22 三项验证（自包含）：A1 cron 触发器（API 层） / A3 拓扑（前端 build 另测） / B3 MCP SSE */
const { spawn, execSync } = require('node:child_process');
const http = require('node:http');

const call = (method, p, body, headers = {}) => new Promise((res) => {
  const req = http.request({ host: '127.0.0.1', port: 37100, path: '/api/v1' + p, method, headers: { 'Content-Type': 'application/json', ...headers } }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ code: r.statusCode, headers: r.headers, body: d })); });
  req.on('error', (e) => res({ code: 0, headers: {}, body: String(e) }));
  req.end(body ? JSON.stringify(body) : undefined);
});

(async () => {
  try { execSync('powershell -NoProfile -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort 37100 -State Listen)[0].OwningProcess -Force -Confirm:$false"', { stdio: 'ignore' }); } catch {}
  await new Promise((r) => setTimeout(r, 1200));
  const backend = spawn('node', ['dist/main.js'], { cwd: 'C:/Users/administer/WorkBuddy/DevPilot/apps/backend', stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); const h = await call('GET', '/health'); if (h.code === 200) break; }
  console.log('backend up');

  // ===== A1：cron 校验与创建 =====
  const bad = JSON.parse((await call('POST', '/workflows', { name: 'p22-badcron-' + Date.now(), definition: { name: 'bad', trigger: { type: 'schedule', cron: '99 * * * *' }, steps: [{ id: 'n', type: 'notify', title: 'x' }] } })).body);
  console.log('1 非法 cron 被拒:', (bad.message ?? '').includes('cron') ? '通过' : 'FAIL ' + JSON.stringify(bad).slice(0, 100));

  const wf = JSON.parse((await call('POST', '/workflows', { name: 'p22-cron-' + Date.now(), definition: { name: 'cron演示', trigger: { type: 'schedule', cron: '0 9 * * 1-5' }, steps: [{ id: 'n', type: 'notify', title: '工作日晨检' }] } })).body);
  const lst = JSON.parse((await call('GET', '/workflows')).body).find((w) => w.id === wf.id);
  console.log('2 cron 工作流创建 + 触发器摘要:', lst.trigger === 'cron 0 9 * * 1-5' ? `通过（${lst.trigger}）` : 'FAIL ' + lst.trigger);

  // ===== B3：MCP SSE =====
  // 2a) POST + Accept: text/event-stream → SSE 帧响应
  const ssePost = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { Accept: 'text/event-stream' });
  const sseOk = ssePost.headers['content-type']?.includes('text/event-stream') && ssePost.body.startsWith('event: message\ndata: ');
  const frame = JSON.parse((ssePost.body.match(/^data: (.*)$/m) || [])[1] || '{}');
  console.log('3 MCP POST SSE:', sseOk && frame.result ? `通过（server=${frame.result.serverInfo.name}，event-stream 帧解析成功）` : 'FAIL ' + ssePost.body.slice(0, 100));

  // 2b) POST 无 Accept → JSON（原行为回归）
  const jsonPost = JSON.parse((await call('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).body);
  console.log('4 MCP POST JSON 回归:', jsonPost.result?.tools?.length >= 7 ? `通过（${jsonPost.result.tools.length} tools）` : 'FAIL');

  // 2c) GET → SSE 通知流 + keepalive
  const getSse = await new Promise((res) => {
    const req = http.request({ host: '127.0.0.1', port: 37100, path: '/api/v1/mcp', method: 'GET', headers: { Accept: 'text/event-stream' } }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; if (d.includes('stream open')) { req.destroy(); res({ ct: r.headers['content-type'], body: d }); } });
    });
    req.on('error', () => res({ ct: 'conn-closed', body: 'ERR' }));
    req.end();
  });
  console.log('5 MCP GET SSE 流:', getSse.ct?.includes('text/event-stream') && getSse.body.includes('stream open') ? '通过（流打开 + open 注释帧）' : 'FAIL ' + JSON.stringify(getSse).slice(0, 100));

  // 2d) SSE 通道 tools/call 全链路
  const sseCall = await call('POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'devpilot.health', arguments: {} } }, { Accept: 'text/event-stream' });
  const callFrame = JSON.parse((sseCall.body.match(/^data: (.*)$/m) || [])[1] || '{}');
  const health = JSON.parse(callFrame?.result?.content?.[0]?.text || '{}');
  console.log('6 MCP SSE tools/call:', health.status ? `通过（status=${health.status}）` : 'FAIL ' + sseCall.body.slice(0, 100));

  backend.kill();
  console.log('backend stopped');
})().catch((e) => { console.error('VERIFY ERROR', e); process.exit(1); });
