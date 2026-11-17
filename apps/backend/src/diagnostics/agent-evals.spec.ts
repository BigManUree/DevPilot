import { classifyError } from './classifier';

/**
 * Agent 可靠性评估（任务书 §4.4）——确定性规则档：
 * 14 类故障场景的错误证据 → 分类/置信度断言。纯规则计算，无 LLM、无付费依赖、可日常执行。
 * Mock Agent 档见 agent-loop-safety.spec.ts（stub 模型驱动完整执行循环）；
 * 真实 LLM 档见 scripts/agent-evals-real.mjs（需配置真实 Key，独立运行，不混入本套件）。
 */

interface Scenario {
  id: string;
  name: string;
  logText: string;
  expectCategory: string;
}

const SCENARIOS: Scenario[] = [
  { id: 'S01', name: 'Node 模块缺失', logText: 'Error: Cannot find module \'express\'\n    at Object.<anonymous> (server.js:1:1)', expectCategory: 'dependency_install_failed' },
  { id: 'S02', name: 'Node 版本不匹配', logText: 'The engine "node" is incompatible with this module. Expected version ">=20". Got "18.0.0"', expectCategory: 'version_mismatch' },
  { id: 'S03', name: '环境变量缺失', logText: 'Environment variable DATABASE_URL is not set', expectCategory: 'config_missing' },
  { id: 'S04', name: '端口被占用', logText: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:3000', expectCategory: 'port_conflict' },
  { id: 'S05', name: '启动命令错误', logText: "'node-app' 不是内部或外部命令，也不是可运行的程序", expectCategory: 'unknown' },
  { id: 'S06', name: 'Java 编译失败（字节码版本）', logText: 'java.lang.UnsupportedClassVersionError: com/app/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0)', expectCategory: 'version_mismatch' },
  { id: 'S07', name: 'Python 模块缺失', logText: "ModuleNotFoundError: No module named 'fastapi'", expectCategory: 'dependency_install_failed' },
  { id: 'S08', name: 'npm 依赖解析失败', logText: 'npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree', expectCategory: 'dependency_install_failed' },
  { id: 'S09', name: 'MySQL 连接失败', logText: 'Communications link failure. The last packet sent successfully to the server was 0 milliseconds ago. Connection refused: localhost:3306', expectCategory: 'database_connection' },
  { id: 'S10', name: 'Redis 连接失败', logText: 'Could not connect to Redis at 127.0.0.1:6379: Connection refused', expectCategory: 'cache_connection' },
  { id: 'S11', name: '前端构建错误', logText: '[vite] Internal server error: Failed to resolve import "./App.vue"', expectCategory: 'compile_error' },
  { id: 'S12', name: '健康检查失败（服务退出）', logText: 'service exited code=1（启动后立即退出，端口未监听）', expectCategory: 'unknown' },
  { id: 'S13', name: 'Docker daemon 不可用', logText: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', expectCategory: 'docker_error' },
  { id: 'S14', name: '项目配置格式错误（Spring Bean）', logText: 'org.springframework.beans.factory.BeanCreationException: Error creating bean with name \'dataSource\'', expectCategory: 'config_invalid' },
];

describe('Agent 评估：确定性规则档（14 类故障场景）', () => {
  for (const s of SCENARIOS) {
    it(`[${s.id}] ${s.name} → ${s.expectCategory}`, () => {
      const r = classifyError(s.logText);
      expect(r.category).toBe(s.expectCategory);
      expect(r.confidence).toBeGreaterThan(0);
      // 分类必须带证据，不允许只给结论
      expect(Array.isArray(r.evidence)).toBe(true);
    });
  }

  it('场景覆盖清单：14/14 且编号唯一', () => {
    expect(SCENARIOS.length).toBe(14);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(14);
  });

  it('S05/S12 未命中规则的诚实降级为 unknown（不伪造分类）', () => {
    // 启动命令错误与健康检查失败目前无确定性规则，宁可 unknown 交 LLM 也不误报
    const r = classifyError(SCENARIOS[4].logText);
    expect(r.category).toBe('unknown');
  });

  it('敏感信息不进入分类证据（脱敏）', () => {
    const r = classifyError('Access denied for user \'root\'@\'localhost\' (using password: YES) password=SuperSecret123');
    expect(JSON.stringify(r)).not.toContain('SuperSecret123');
  });
});
