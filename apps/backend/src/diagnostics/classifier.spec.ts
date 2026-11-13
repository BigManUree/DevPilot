import { classifyError, listRules } from './classifier';

describe('错误分类器（确定性规则）', () => {
  it('Java 字节码版本不匹配 → version_mismatch', () => {
    const r = classifyError('Exception in thread "main" java.lang.UnsupportedClassVersionError: com/demo/App has been compiled by a more recent version (61.0), this version only supports 52.0');
    expect(r.category).toBe('version_mismatch');
    expect(r.ruleId).toBe('java-unsupported-class-version');
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(r.evidence.length).toBeGreaterThan(0);
  });

  it('端口占用 → port_conflict', () => {
    const r = classifyError('Error: listen EADDRINUSE: address already in use 127.0.0.1:8080');
    expect(r.category).toBe('port_conflict');
  });

  it('Python 模块缺失 → dependency_install_failed', () => {
    const r = classifyError('Traceback (most recent call last):\n  File "app.py", line 1, in <module>\nModuleNotFoundError: No module named \'fastapi\'');
    expect(r.category).toBe('dependency_install_failed');
    expect(r.ruleId).toBe('python-module-not-found');
  });

  it('npm ERESOLVE → dependency_install_failed', () => {
    const r = classifyError('npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree');
    expect(r.category).toBe('dependency_install_failed');
    expect(r.ruleId).toBe('npm-eresolve');
  });

  it('数据库连接拒绝 → database_connection', () => {
    const r = classifyError('com.mysql.cj.jdbc.exceptions.CommunicationsException: Communications link failure\nCaused by: Connection refused');
    expect(r.category).toBe('database_connection');
  });

  it('Docker daemon 未运行 → docker_error', () => {
    const r = classifyError('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
    expect(r.category).toBe('docker_error');
  });

  it('未知错误不瞎分类（低置信度）', () => {
    const r = classifyError('something totally unrelated happened 42');
    expect(r.category).toBe('unknown');
    expect(r.confidence).toBeLessThan(0.5);
  });

  it('规则库非空且类别合法', () => {
    const rules = listRules();
    expect(rules.length).toBeGreaterThanOrEqual(15);
    const valid = new Set(['env_missing', 'version_mismatch', 'dependency_install_failed', 'network', 'permission', 'port_conflict', 'database_connection', 'cache_connection', 'config_missing', 'config_invalid', 'compile_error', 'runtime_exception', 'process_crash', 'docker_error', 'health_check_failed', 'business_error', 'unknown']);
    for (const r of rules) expect(valid.has(r.category)).toBe(true);
  });
});
