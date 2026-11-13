import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { safeExtractZip, safeExtractArchive } from './safe-archive';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-zip-'));
}

/** 手工构造 ZIP（STORE/DEFLATE）：允许任意恶意条目名（adm-zip 的 addFile 会净化 ../，测不到真实攻击面） */
function buildRawZip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  const crc32 = (buf: Buffer): number => {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return ~c >>> 0;
  };

  for (const e of entries) {
    const nameBytes = Buffer.from(e.name, 'utf-8');
    const payload = e.deflate ? zlib.deflateRawSync(e.data) : e.data;
    const method = e.deflate ? 8 : 0;
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version
    local.writeUInt16LE(0x0800, 6);    // flags: UTF-8
    local.writeUInt16LE(method, 8);    // store/deflate
    local.writeUInt16LE(0, 10);        // time
    local.writeUInt16LE(0x2100, 12);   // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);   // compressed size
    local.writeUInt32LE(e.data.length, 22);    // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x2100, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBytes]));
    offset += local.length + nameBytes.length + payload.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

describe('安全解压（ZIP Slip / 压缩炸弹 / 恶意文件名）', () => {
  it('正常 zip 解压成功并统计文件数', () => {
    const dir = tmp();
    try {
      const archive = path.join(dir, 'demo.zip');
      fs.writeFileSync(archive, buildRawZip([
        { name: 'project/src/index.js', data: Buffer.from('console.log(1)') },
        { name: 'project/README.md', data: Buffer.from('# demo') },
      ]));
      const dest = path.join(dir, 'out');
      const r = safeExtractZip(archive, dest);
      expect(r.files).toBe(2);
      expect(fs.existsSync(path.join(dest, 'project/src/index.js'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ZIP Slip：../ 路径穿越条目被拒绝', () => {
    const dir = tmp();
    try {
      const archive = path.join(dir, 'evil.zip');
      fs.writeFileSync(archive, buildRawZip([{ name: '../evil.txt', data: Buffer.from('pwned') }]));
      const dest = path.join(dir, 'out');
      expect(() => safeExtractZip(archive, dest)).toThrow(/穿越/);
      expect(fs.existsSync(dest)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('绝对路径条目被拒绝', () => {
    const dir = tmp();
    try {
      const archive = path.join(dir, 'evil2.zip');
      fs.writeFileSync(archive, buildRawZip([{ name: 'C:/Windows/evil.txt', data: Buffer.from('pwned') }]));
      expect(() => safeExtractZip(archive, path.join(dir, 'out'))).toThrow(/绝对路径/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Windows 保留文件名被拒绝', () => {
    const dir = tmp();
    try {
      const archive = path.join(dir, 'reserved.zip');
      fs.writeFileSync(archive, buildRawZip([{ name: 'CON.txt', data: Buffer.from('x') }]));
      expect(() => safeExtractZip(archive, path.join(dir, 'out'))).toThrow(/保留文件名/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('压缩炸弹：压缩比超限被拒绝（DEFLATE 高压缩比）', () => {
    const dir = tmp();
    try {
      const archive = path.join(dir, 'bomb.zip');
      fs.writeFileSync(archive, buildRawZip([{ name: 'bomb.bin', data: Buffer.alloc(1024 * 1024, 0), deflate: true }]));
      expect(() => safeExtractZip(archive, path.join(dir, 'out'), { maxRatio: 50 })).toThrow(/压缩炸弹/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('文件数超限被拒绝', () => {
    const dir = tmp();
    try {
      const archive = path.join(dir, 'many.zip');
      const entries = [];
      for (let i = 0; i < 20; i++) entries.push({ name: `f${i}.txt`, data: Buffer.from('x') });
      fs.writeFileSync(archive, buildRawZip(entries));
      expect(() => safeExtractZip(archive, path.join(dir, 'out'), { maxFiles: 10 })).toThrow(/条目数/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('失败时清理临时目录，不残留半解压状态', () => {
    const dir = tmp();
    try {
      const archive = path.join(dir, 'mixed.zip');
      fs.writeFileSync(archive, buildRawZip([
        { name: 'a.txt', data: Buffer.from('ok') },
        { name: '../evil.txt', data: Buffer.from('pwned') },
      ]));
      const dest = path.join(dir, 'out');
      expect(() => safeExtractZip(archive, dest)).toThrow();
      const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith('out'));
      expect(leftovers.length).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('统一入口：不支持的格式明确报错（不假装支持）', () => {
    const dir = tmp();
    try {
      const fake = path.join(dir, 'fake.tar.gz');
      fs.writeFileSync(fake, 'not really');
      expect(() => safeExtractArchive(fake, path.join(dir, 'out'))).toThrow(/不支持的压缩格式/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

void zlib;
