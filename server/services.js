import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AsyncLocalStorage } from 'async_hooks';
import { v4 as uuidv4 } from 'uuid';
import ftp from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import ssh2 from 'ssh2';
import nodeRdp from 'node-rdpjs';
import iconv from 'iconv-lite';

const execFileAsync = promisify(execFile);
const { Client: SshClient } = ssh2;
const rdp = nodeRdp;
const operatorStorage = new AsyncLocalStorage();

export function createGuacamoleKey(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest();
}

export function createGuacamoleToken(secret, value) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('AES-256-CBC', createGuacamoleKey(secret), iv);
  let encrypted = cipher.update(JSON.stringify(value), 'utf8', 'binary');
  encrypted += cipher.final('binary');

  return Buffer.from(JSON.stringify({
    iv: Buffer.from(iv).toString('base64'),
    value: Buffer.from(encrypted, 'binary').toString('base64'),
  })).toString('base64');
}

function now() {
  return new Date().toISOString();
}

function currentOperator() {
  return operatorStorage.getStore()?.operator || 'system';
}

function normalizeHost(host) {
  const value = String(host || '').trim();
  if (['localhost', '127.0.0.1', '::1'].includes(value)) {
    return 'host.docker.internal';
  }
  return value;
}

function decodePingBuffer(buffer) {
  const encoding = process.platform === 'win32' ? 'gbk' : 'utf8';
  return iconv.decode(Buffer.from(buffer), encoding);
}

function ftpTlsOptions(useSsl) {
  if (!useSsl) return { secure: false };
  return {
    secure: true,
    secureOptions: {
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
      minVersion: 'TLSv1',
      maxVersion: 'TLSv1.3',
      minDHSize: 1,
      ciphers: 'ALL:@SECLEVEL=0',
    },
  };
}

function ftpPermissiveTlsOptions(host) {
  return {
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
    servername: host,
    minVersion: 'TLSv1',
    maxVersion: 'TLSv1.3',
    minDHSize: 1,
    ciphers: 'ALL:@SECLEVEL=0',
  };
}

function pingEntryToText(entry) {
  if (entry.ok) {
    return `Reply from ${entry.address} bytes=32 time=${entry.time ?? 0}ms ttl=${entry.ttl ?? 0}`;
  }
  if (entry.line) return String(entry.line);
  return `Request timed out ${entry.address || ''}`.trim();
}

function probeTcpConnection(host, port, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const realHost = normalizeHost(host);
    const socket = net.createConnection({ host: realHost, port: Number(port) });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接 ${realHost}:${port} 超时`));
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('close', () => clearTimeout(timer));
  });
}

function probeSshConnection({ host, port, username, password, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    const realHost = normalizeHost(host);
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        // ignore
      }
      if (error) reject(error);
      else resolve(true);
    };

    const timer = setTimeout(() => finish(new Error(`SSH 连接 ${realHost}:${port} 超时`)), timeoutMs);

    client.on('ready', () => {
      clearTimeout(timer);
      finish();
    });
    client.on('error', (error) => {
      clearTimeout(timer);
      finish(error);
    });
    client.on('close', () => {
      clearTimeout(timer);
      if (!settled) finish(new Error('SSH 连接被关闭'));
    });

    client.connect({
      host: realHost,
      port: Number(port),
      username,
      password,
      readyTimeout: timeoutMs,
      keepaliveInterval: 10000,
      hostVerifier: () => true,
      tryKeyboard: true,
    });
  });
}

async function withFtpClient(connectOptions, useSsl, task) {
  const attempts = useSsl ? [
    { secure: true, secureOptions: ftpPermissiveTlsOptions(connectOptions.host) },
    { secure: 'implicit', secureOptions: ftpPermissiveTlsOptions(connectOptions.host) },
  ] : [{ secure: false }];

  let lastError = null;
  for (const attempt of attempts) {
    const client = new ftp.Client();
    client.ftp.timeout = 15000;
    try {
      await client.access({ ...connectOptions, ...attempt });
      return await task(client);
    } catch (error) {
      lastError = error;
    } finally {
      client.close();
    }
  }
  throw lastError || new Error('FTP 连接失败');
}

function buildPingScript(target, count, unlimited = false) {
  const quotedTarget = JSON.stringify(target);
  const countLine = unlimited || !count ? '' : `$count = ${Number(count)};`;
  return `
$target = ${quotedTarget};
${countLine}
$i = 0;
while ($true) {
  $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff');
  $reply = Test-Connection -ComputerName $target -Count 1 -ErrorAction SilentlyContinue | Select-Object -First 1;
  if ($reply) {
    $addr = if ($reply.Address) { $reply.Address.IPAddressToString } else { $target };
    if (-not $addr) { $addr = $target; }
    $time = $reply.ResponseTime;
    $ttl = $reply.TimeToLive;
    Write-Output (@{ timestamp = $ts; ok = $true; address = $addr; time = $time; ttl = $ttl } | ConvertTo-Json -Compress);
  } else {
    Write-Output (@{ timestamp = $ts; ok = $false; address = $target; time = $null; ttl = $null } | ConvertTo-Json -Compress);
  }
  $i++;
  if (${count ? '$count' : '0'} -gt 0 -and $i -ge ${count ? '$count' : '0'}) { break }
  Start-Sleep -Seconds 1;
}
`;
}

function buildUnixPingArgs(target, count) {
  const total = Number(count) || 0;
  return total > 0 ? ['-c', String(total), target] : [target];
}

export class PortalService {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.vncSessions = new Map();
    this.sshSessions = new Map();
    this.rdpSessions = new Map();
    this.pingStreams = new Map();
  }

  withOperator(operator, fn) {
    return operatorStorage.run({ operator: operator || 'system' }, fn);
  }

  cleanupExpiredVncSessions() {
    const expireBefore = Date.now() - 15 * 60 * 1000;
    for (const [id, session] of this.vncSessions.entries()) {
      if (session.createdAt < expireBefore) this.vncSessions.delete(id);
    }
  }

  cleanupExpiredSshSessions() {
    const expireBefore = Date.now() - 15 * 60 * 1000;
    for (const [id, session] of this.sshSessions.entries()) {
      if (session.createdAt < expireBefore) this.sshSessions.delete(id);
    }
  }

  cleanupExpiredRdpSessions() {
    const expireBefore = Date.now() - 15 * 60 * 1000;
    for (const [id, session] of this.rdpSessions.entries()) {
      if (session.createdAt < expireBefore) this.rdpSessions.delete(id);
    }
  }

  sanitizeUser(row) {
    if (!row) return null;
    const { password, ...user } = row;
    return user;
  }

  login(username, password, ip) {
    const lock = this.db.get('SELECT * FROM login_locks WHERE username = ?', [username]);
    if (lock?.locked_until && Date.now() < new Date(lock.locked_until).getTime()) {
      return { ok: false, status: 429, message: '账户已锁定，请稍后再试' };
    }

    const user = this.db.get('SELECT * FROM users WHERE username = ? AND status = ?', [username, 'active']);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      this.bumpFail(username);
      return { ok: false, status: 401, message: '用户名或密码错误' };
    }

    this.clearFail(username);
    const payload = { userId: user.id, username: user.username, role: user.role };
    const token = jwt.sign(payload, this.config.jwtSecret, { expiresIn: '8h' });
    this.writeOperationLog('auth', '登录', username, `登录 IP: ${ip || ''}`);
    return { ok: true, data: { token, user: this.sanitizeUser(user) } };
  }

  verifyToken(authHeader) {
    if (!authHeader?.startsWith('Bearer ')) return null;
    try {
      return jwt.verify(authHeader.slice(7), this.config.jwtSecret);
    } catch {
      return null;
    }
  }

  listShortcuts() {
    return this.db.all("SELECT id, title, url, icon, color, COALESCE(category, '默认') AS category, sort_order, created_at AS createdAt, updated_at AS updatedAt FROM shortcuts ORDER BY sort_order ASC, created_at ASC");
  }

  createShortcut(input) {
    const id = uuidv4();
    const timestamp = now();
    this.db.run(
      'INSERT INTO shortcuts (id, title, url, icon, color, category, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, input.title.trim(), input.url.trim(), input.icon?.trim() || '', input.color || '#2563eb', String(input.category || '默认').trim() || '默认', Number(input.sortOrder) || 0, timestamp, timestamp]
    );
    this.db.scheduleSave();
    this.writeOperationLog('shortcut', '新增快捷按钮', input.title, input.url);
    return this.db.get('SELECT * FROM shortcuts WHERE id = ?', [id]);
  }

  updateShortcut(id, input) {
    const existing = this.db.get('SELECT * FROM shortcuts WHERE id = ?', [id]);
    if (!existing) return null;
    this.db.run(
      'UPDATE shortcuts SET title = ?, url = ?, icon = ?, color = ?, category = ?, sort_order = ?, updated_at = ? WHERE id = ?',
      [input.title.trim(), input.url.trim(), input.icon?.trim() || '', input.color || '#2563eb', String(input.category || '默认').trim() || '默认', Number(input.sortOrder) || 0, now(), id]
    );
    this.db.scheduleSave();
    this.writeOperationLog('shortcut', '编辑快捷按钮', input.title, input.url);
    return this.db.get('SELECT * FROM shortcuts WHERE id = ?', [id]);
  }

  deleteShortcut(id) {
    const existing = this.db.get('SELECT * FROM shortcuts WHERE id = ?', [id]);
    if (!existing) return false;
    this.db.run('DELETE FROM shortcuts WHERE id = ?', [id]);
    this.db.scheduleSave();
    this.writeOperationLog('shortcut', '删除快捷按钮', existing.title || id, existing.url || '');
    return true;
  }

  listUsers() {
    return this.db.all('SELECT id, username, real_name AS realName, role, status, created_at AS createdAt, updated_at AS updatedAt FROM users ORDER BY created_at ASC');
  }

  createUser(input) {
    const username = String(input.username || '').trim();
    const password = String(input.password || '').trim();
    const realName = String(input.realName || '').trim();
    const role = input.role === 'user' ? 'user' : 'admin';
    const status = input.status === 'disabled' ? 'disabled' : 'active';
    if (!username || !password || !realName) throw new Error('用户名、姓名和密码不能为空');
    const existed = this.db.get('SELECT id FROM users WHERE username = ?', [username]);
    if (existed) throw new Error('用户名已存在');
    const id = uuidv4();
    const hashed = bcrypt.hashSync(password, 10);
    const timestamp = now();
    this.db.run('INSERT INTO users (id, username, password, real_name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, username, hashed, realName, role, status, timestamp, timestamp]);
    this.db.scheduleSave();
    this.writeOperationLog('user', '新增用户', username, `${realName} / ${role} / ${status}`);
    return this.getUserById(id);
  }

  updateUser(id, input) {
    const existing = this.getUserById(id);
    if (!existing) throw new Error('用户不存在');
    const realName = String(input.realName || existing.realName || '').trim();
    const role = input.role === 'user' ? 'user' : 'admin';
    const status = input.status === 'disabled' ? 'disabled' : 'active';
    if (!realName) throw new Error('姓名不能为空');
    const timestamp = now();
    this.db.run('UPDATE users SET real_name = ?, role = ?, status = ?, updated_at = ? WHERE id = ?', [realName, role, status, timestamp, id]);
    this.db.scheduleSave();
    this.writeOperationLog('user', '编辑用户', existing.username, `${realName} / ${role} / ${status}`);
    return this.getUserById(id);
  }

  setUserStatus(id, status) {
    const existing = this.getUserById(id);
    if (!existing) throw new Error('用户不存在');
    const nextStatus = status === 'disabled' ? 'disabled' : 'active';
    this.db.run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', [nextStatus, now(), id]);
    this.db.scheduleSave();
    this.writeOperationLog('user', nextStatus === 'disabled' ? '禁用用户' : '启用用户', existing.username, existing.realName);
    return this.getUserById(id);
  }

  resetUserPassword(id, newPassword) {
    const existing = this.getUserById(id);
    if (!existing) throw new Error('用户不存在');
    const password = String(newPassword || '').trim();
    if (!password) throw new Error('密码不能为空');
    this.db.run('UPDATE users SET password = ?, updated_at = ? WHERE id = ?', [bcrypt.hashSync(password, 10), now(), id]);
    this.db.scheduleSave();
    this.writeOperationLog('user', '修改密码', existing.username, existing.realName);
    return this.getUserById(id);
  }

  changeOwnPassword(userId, oldPassword, newPassword) {
    const user = this.db.get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) throw new Error('用户不存在');
    if (!bcrypt.compareSync(oldPassword, user.password)) throw new Error('原密码不正确');
    if (!String(newPassword || '').trim()) throw new Error('新密码不能为空');
    this.db.run('UPDATE users SET password = ?, updated_at = ? WHERE id = ?', [bcrypt.hashSync(newPassword, 10), now(), userId]);
    this.db.scheduleSave();
    this.writeOperationLog('user', '修改密码', user.username, user.real_name);
    return this.getUserById(userId);
  }

  getUserById(id) {
    return this.db.get('SELECT id, username, real_name AS realName, role, status, created_at AS createdAt, updated_at AS updatedAt FROM users WHERE id = ?', [id]);
  }

  async ping({ target, count = 4 }) {
    target = normalizeHost(target);
    const total = Number(count) > 0 ? Number(count) : 4;
    const startedAt = Date.now();
    try {
      if (process.platform === 'win32') {
        const script = buildPingScript(target, total, false);
        const { stdout, stderr } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 30000, windowsHide: true });
        const events = this.parsePingEvents(`${stdout || ''}${stderr || ''}`);
        return { ok: true, events, output: events.map((entry) => `[${entry.timestamp}] ${pingEntryToText(entry)}`).join('\n'), durationMs: Date.now() - startedAt };
      }
      const args = ['-c', String(total), target];
      const { stdout, stderr } = await execFileAsync('ping', args, { timeout: 20000, windowsHide: true });
      const output = `${stdout}${stderr}`.trim();
      return { ok: true, events: [], output, durationMs: Date.now() - startedAt };
    } catch (err) {
      const output = `${err.stdout || ''}${err.stderr || ''}`.trim() || 'ping 执行失败';
      return { ok: false, output, durationMs: Date.now() - startedAt };
    }
  }

  async streamPing({ target, count = 4 }, onLine, onClose) {
    target = normalizeHost(target);
    const child = process.platform === 'win32'
      ? execFile('powershell.exe', ['-NoProfile', '-Command', buildPingScript(target, count, true)], { windowsHide: true })
      : execFile('ping', buildUnixPingArgs(target, count), { windowsHide: true });
    let lineBuffer = '';
    let received = 0;

    const stop = () => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      onClose?.();
    };

    child.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString('utf8');
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        const parsed = this.parsePingLine(line);
        const timestamp = parsed.timestamp || now();
        onLine({ ...parsed, timestamp });
        if (parsed.ok !== undefined) {
          received += 1;
          if (count > 0 && received >= count) stop();
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const line = chunk.toString('utf8').trim();
      if (line) onLine({ timestamp: now(), line });
    });

    child.on('close', () => stop());
    child.on('error', (error) => {
      onLine({ timestamp: now(), line: error.message || 'ping 启动失败' });
      stop();
    });

    return child;
  }

  parsePingJsonLine(line) {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }

  parsePingLine(line) {
    const raw = String(line || '').trim();
    if (!raw) return { timestamp: now(), line: '' };
    const jsonParsed = this.parsePingJsonLine(raw);
    if (jsonParsed && typeof jsonParsed === 'object' && ('ok' in jsonParsed || 'address' in jsonParsed || 'time' in jsonParsed)) {
      return jsonParsed;
    }

    const replyMatch = raw.match(/Reply from\s+([^:]+):\s+bytes=\d+\s+time[=<]?(\d+)ms\s+TTL=(\d+)/i);
    if (replyMatch) {
      return { timestamp: now(), ok: true, address: replyMatch[1], time: Number(replyMatch[2]), ttl: Number(replyMatch[3]) };
    }

    if (/Request timed out|请求超时|Destination host unreachable|General failure|无法访问目标主机/i.test(raw)) {
      return { timestamp: now(), ok: false, address: '', time: null, ttl: null, line: raw };
    }

    return { timestamp: now(), line: raw };
  }

  parsePingEvents(text) {
    return `${text || ''}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => this.parsePingLine(line))
      .filter(Boolean);
  }

  checkPort({ host, port }) {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (ok, message) => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        resolve({ ok, message, durationMs: Date.now() - startedAt });
      };
      socket.setTimeout(5000);
      socket.once('connect', () => finish(true, '端口连通'));
      socket.once('timeout', () => finish(false, '连接超时'));
      socket.once('error', (error) => finish(false, error.message || '连接失败'));
      socket.connect(Number(port), host);
    });
  }

  async listFtp({ host, port, username, password, useSsl, remotePath = '/' }) {
    try {
      const list = await withFtpClient({ host: normalizeHost(host), port: Number(port), user: username, password }, useSsl, async (client) => client.list(remotePath || '/'));
      const items = list.map((item) => ({
        name: item.name,
        type: item.isDirectory ? 'directory' : 'file',
        size: item.size || 0,
        modifiedAt: item.modifiedAt ? item.modifiedAt.toISOString() : '',
      }));
      this.writeOperationLog('ftp', 'FTP 登录/浏览', host, remotePath || '/');
      return { ok: true, message: 'FTP 登录成功', items };
    } catch (error) {
      return { ok: false, message: error.message || 'FTP 登录失败', items: [] };
    }
  }

  async listSftp({ host, port, username, password, remotePath = '/' }) {
    const client = new SftpClient();
    try {
      await client.connect({ host: normalizeHost(host), port: Number(port), username, password, readyTimeout: 15000 });
      const list = await client.list(remotePath || '/');
      const items = list.map((item) => ({
        name: item.name,
        type: item.type === 'd' ? 'directory' : 'file',
        size: item.size || 0,
        modifiedAt: item.modifyTime ? new Date(item.modifyTime).toISOString() : '',
      }));
      this.writeOperationLog('sftp', 'SFTP 登录/浏览', host, remotePath || '/');
      return { ok: true, message: 'SFTP 登录成功', items };
    } catch (error) {
      return { ok: false, message: error.message || 'SFTP 登录失败', items: [] };
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async downloadFtp({ host, port, username, password, useSsl, remotePath }) {
    const localPath = path.join(os.tmpdir(), `${uuidv4()}-${path.basename(remotePath)}`);
    try {
      await withFtpClient({ host: normalizeHost(host), port: Number(port), user: username, password }, useSsl, async (client) => {
        await client.downloadTo(localPath, remotePath);
      });
      const content = fs.readFileSync(localPath);
      this.writeOperationLog('ftp', 'FTP 下载文件', host, remotePath);
      return { ok: true, fileName: path.basename(remotePath), contentBase64: content.toString('base64') };
    } finally {
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    }
  }

  async downloadFtpStream({ host, port, username, password, useSsl, remotePath }, output) {
    await withFtpClient({ host: normalizeHost(host), port: Number(port), user: username, password }, useSsl, async (client) => {
      await client.downloadTo(output, remotePath);
    });
    this.writeOperationLog('ftp', 'FTP 下载文件', host, remotePath);
  }

  async uploadFtp({ host, port, username, password, useSsl, remotePath, fileName, contentBase64 }) {
    const localPath = path.join(os.tmpdir(), `${uuidv4()}-${fileName}`);
    try {
      fs.writeFileSync(localPath, Buffer.from(contentBase64, 'base64'));
      const targetPath = path.posix.join(remotePath || '/', fileName);
      await withFtpClient({ host: normalizeHost(host), port: Number(port), user: username, password }, useSsl, async (client) => {
        await client.uploadFrom(localPath, targetPath);
      });
      this.writeOperationLog('ftp', 'FTP 上传文件', host, targetPath);
      return { ok: true };
    } finally {
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    }
  }

  async uploadFtpStream({ host, port, username, password, useSsl, remotePath, fileName }, input) {
    const targetPath = path.posix.join(remotePath || '/', fileName);
    await withFtpClient({ host: normalizeHost(host), port: Number(port), user: username, password }, useSsl, async (client) => {
      await client.uploadFrom(input, targetPath);
    });
    this.writeOperationLog('ftp', 'FTP 上传文件', host, targetPath);
    return { ok: true };
  }

  async deleteFtp({ host, port, username, password, useSsl, remotePath }) {
    try {
      await withFtpClient({ host: normalizeHost(host), port: Number(port), user: username, password }, useSsl, async (client) => {
        await client.remove(remotePath);
      });
      this.writeOperationLog('ftp', 'FTP 删除文件', host, remotePath);
      return { ok: true };
    } catch (error) {
      throw error;
    }
  }

  async downloadSftp({ host, port, username, password, remotePath }) {
    const client = new SftpClient();
    const localPath = path.join(os.tmpdir(), `${uuidv4()}-${path.basename(remotePath)}`);
    try {
      await client.connect({ host: normalizeHost(host), port: Number(port), username, password, readyTimeout: 15000 });
      await client.get(remotePath, localPath);
      const content = fs.readFileSync(localPath);
      this.writeOperationLog('sftp', 'SFTP 下载文件', host, remotePath);
      return { ok: true, fileName: path.basename(remotePath), contentBase64: content.toString('base64') };
    } finally {
      await client.end().catch(() => undefined);
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    }
  }

  async downloadSftpStream({ host, port, username, password, remotePath }, output) {
    const client = new SftpClient();
    try {
      await client.connect({ host: normalizeHost(host), port: Number(port), username, password, readyTimeout: 15000 });
      await client.get(remotePath, output);
      this.writeOperationLog('sftp', 'SFTP 下载文件', host, remotePath);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async uploadSftp({ host, port, username, password, remotePath, fileName, contentBase64 }) {
    const client = new SftpClient();
    const localPath = path.join(os.tmpdir(), `${uuidv4()}-${fileName}`);
    try {
      await client.connect({ host: normalizeHost(host), port: Number(port), username, password, readyTimeout: 15000 });
      fs.writeFileSync(localPath, Buffer.from(contentBase64, 'base64'));
      const targetPath = path.posix.join(remotePath || '/', fileName);
      await client.put(localPath, targetPath);
      this.writeOperationLog('sftp', 'SFTP 上传文件', host, targetPath);
      return { ok: true };
    } finally {
      await client.end().catch(() => undefined);
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    }
  }

  async uploadSftpStream({ host, port, username, password, remotePath, fileName }, input) {
    const client = new SftpClient();
    const targetPath = path.posix.join(remotePath || '/', fileName);
    try {
      await client.connect({ host: normalizeHost(host), port: Number(port), username, password, readyTimeout: 15000 });
      await client.put(input, targetPath);
      this.writeOperationLog('sftp', 'SFTP 上传文件', host, targetPath);
      return { ok: true };
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async deleteSftp({ host, port, username, password, remotePath }) {
    const client = new SftpClient();
    try {
      await client.connect({ host: normalizeHost(host), port: Number(port), username, password, readyTimeout: 15000 });
      await client.delete(remotePath);
      this.writeOperationLog('sftp', 'SFTP 删除文件', host, remotePath);
      return { ok: true };
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  openPingStream({ target, count }, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ target })}\n\n`);

    const child = process.platform === 'win32'
      ? execFile('powershell.exe', ['-NoProfile', '-Command', buildPingScript(target, count, true)], { windowsHide: true })
      : execFile('ping', buildUnixPingArgs(target, count), { windowsHide: true });
    const state = { sent: 0, stopped: false };
    let buffer = '';

    const writeLine = (line) => {
      if (!line || state.stopped) return;
      res.write(`event: line\ndata: ${JSON.stringify({ timestamp: now(), line })}\n\n`);
      if (count > 0) {
        state.sent += 1;
        if (state.sent >= count) stop('count reached');
      }
    };

    const stop = (reason) => {
      if (state.stopped) return;
      state.stopped = true;
      try { child.kill(); } catch {
        // ignore
      }
      res.write(`event: end\ndata: ${JSON.stringify({ reason: reason || 'closed' })}\n\n`);
      res.end();
      this.pingStreams.delete(target);
    };

    child.stdout.on('data', (chunk) => {
      buffer += process.platform === 'win32' ? decodePingBuffer(chunk) : chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.map((line) => line.trim()).filter(Boolean).forEach((line) => {
        const parsed = this.parsePingLine(line);
        if (parsed.ok !== undefined || parsed.line) {
          res.write(`event: line\ndata: ${JSON.stringify(parsed)}\n\n`);
          if (parsed.ok !== undefined) {
            state.sent += 1;
            if (count > 0 && state.sent >= count) stop('count reached');
          }
          return;
        }
        writeLine(line);
      });
    });
    child.stderr.on('data', (chunk) => {
      const line = (process.platform === 'win32' ? decodePingBuffer(chunk) : chunk.toString('utf8')).trim();
      if (line) writeLine(line);
    });
    child.on('close', () => stop('process closed'));
    child.on('error', (error) => {
      writeLine(error.message || 'ping 启动失败');
      stop('error');
    });

    this.pingStreams.set(target, { child, stop });
    res.on('close', () => stop('client closed'));
  }

  listNetworkLogs(limit = 50) {
    return this.db.all("SELECT * FROM network_logs WHERE tool NOT IN ('ping', 'port') ORDER BY created_at DESC LIMIT ?", [Number(limit) || 50]);
  }

  async createVncSession({ host, port }) {
    host = normalizeHost(host);
    await probeTcpConnection(host, port, 5000);
    this.cleanupExpiredVncSessions();
    const sessionId = uuidv4();
    this.vncSessions.set(sessionId, {
      host,
      port: Number(port),
      createdAt: Date.now(),
    });
    this.writeOperationLog('vnc', 'VNC 连接', host, String(port));
    return { sessionId };
  }

  async createSshSession({ host, port, username, password }) {
    host = normalizeHost(host);
    await probeSshConnection({ host, port, username, password });
    this.cleanupExpiredSshSessions();
    const sessionId = uuidv4();
    this.sshSessions.set(sessionId, {
      host,
      port: Number(port),
      username,
      password,
      createdAt: Date.now(),
    });
    this.writeOperationLog('ssh', 'SSH 连接', host, `${username}@${port}`);
    return { sessionId };
  }

  async createRdpSession({ host, port, username, password, domain, width, height }) {
    host = normalizeHost(host);
    this.cleanupExpiredRdpSessions();
    try {
      await probeTcpConnection(this.config.guacdHost, this.config.guacdPort);
    } catch (error) {
      throw new Error(`guacd 不可用 (${this.config.guacdHost}:${this.config.guacdPort})`);
    }
    const sessionId = uuidv4();
    const token = createGuacamoleToken(this.config.guacSecret, {
      sessionId,
      connection: {
        type: 'rdp',
        settings: {
          hostname: host,
          port: Number(port) || 3389,
          username,
          password,
          domain: domain || '',
          security: 'any',
          'ignore-cert': true,
          'enable-wallpaper': false,
          'enable-theming': false,
          'create-drive-path': true,
          'create-recording-path': false,
          'resize-method': 'display-update',
          audio: ['audio/L16'],
          video: null,
          image: ['image/png', 'image/jpeg'],
          timezone: null,
          width: Number(width) || 1366,
          height: Number(height) || 768,
        },
      },
    });
    this.rdpSessions.set(sessionId, {
      host,
      port: Number(port),
      username,
      password,
      domain: domain || '',
      width: Number(width) || 1366,
      height: Number(height) || 768,
      token,
      createdAt: Date.now(),
    });
    this.writeOperationLog('rdp', 'RDP 连接', host, `${username}@${port}`);
    return { sessionId, token, wsPath: '/api/remote/rdp/ws' };
  }

  getSshSession(sessionId) {
    this.cleanupExpiredSshSessions();
    return this.sshSessions.get(sessionId) || null;
  }

  clearSshSession(sessionId) {
    this.sshSessions.delete(sessionId);
  }

  getRdpSession(sessionId) {
    this.cleanupExpiredRdpSessions();
    return this.rdpSessions.get(sessionId) || null;
  }

  clearRdpSession(sessionId) {
    this.rdpSessions.delete(sessionId);
  }

  getVncSession(sessionId) {
    this.cleanupExpiredVncSessions();
    return this.vncSessions.get(sessionId) || null;
  }

  clearVncSession(sessionId) {
    this.vncSessions.delete(sessionId);
  }

  handleVncSocket(ws, sessionId) {
    const session = this.getVncSession(sessionId);
    if (!session) {
      ws.close(1008, 'Invalid session');
      return;
    }

    const socket = net.createConnection({ host: session.host, port: session.port });
    socket.setNoDelay(true);
    let connected = false;
    let stage = 'banner';
    let buffer = Buffer.alloc(0);

    const closeBoth = (code = 1000, reason = '') => {
      if (socket.destroyed === false) socket.destroy();
      if (ws.readyState === 1) ws.close(code, reason);
      this.clearVncSession(sessionId);
    };

    socket.on('connect', () => {
      connected = true;
    });

    ws.on('message', (data) => {
      if (socket.destroyed) return;
      socket.write(Buffer.from(data));
    });

    socket.on('data', (chunk) => {
      if (ws.readyState !== 1) return;
      if (stage === 'relay') {
        ws.send(chunk, { binary: true });
        return;
      }

      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);

      while (true) {
        if (stage === 'banner') {
          if (buffer.length < 12) return;
          ws.send(buffer.subarray(0, 12), { binary: true });
          buffer = buffer.subarray(12);
          stage = 'security';
          continue;
        }

        if (stage === 'relay') {
          if (buffer.length) {
            ws.send(buffer, { binary: true });
            buffer = Buffer.alloc(0);
          }
          return;
        }

        if (stage === 'security') {
          if (buffer.length < 1) return;
          const count = buffer[0];
          if (count === 0) {
            if (buffer.length < 5) return;
            const reasonLen = buffer.readUInt32BE(1);
            if (buffer.length < 5 + reasonLen) return;
            ws.send(buffer.subarray(0, 5 + reasonLen), { binary: true });
            buffer = buffer.subarray(5 + reasonLen);
            stage = 'relay';
            continue;
          }

          const packetLength = 1 + count;
          if (buffer.length < packetLength) return;
          const types = Array.from(buffer.subarray(1, packetLength));
          if (types.includes(2)) {
            ws.send(Buffer.from([1, 2]), { binary: true });
          } else {
            ws.send(buffer.subarray(0, packetLength), { binary: true });
          }
          buffer = buffer.subarray(packetLength);
          stage = 'relay';
          continue;
        }
      }
    });
    socket.on('error', (error) => closeBoth(1011, error.message || 'VNC 连接失败'));
    socket.on('close', () => closeBoth(1000, 'VNC 连接已关闭'));
    ws.on('close', () => closeBoth());
    ws.on('error', () => closeBoth(1011, 'WebSocket 错误'));
  }

  handleSshSocket(ws, sessionId) {
    const session = this.getSshSession(sessionId);
    if (!session) {
      ws.close(1008, 'Invalid session');
      return;
    }

    const client = new SshClient();
    let stream = null;
    let closed = false;

    const send = (type, data) => {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type, data }));
    };

    const attachStream = (shellStream, label = 'shell') => {
      stream = shellStream;
      send('status', `SSH 已连接${label ? ` (${label})` : ''}`);
      stream.on('data', (chunk) => send('output', chunk.toString('utf8')));
      stream.stderr?.on('data', (chunk) => send('output', chunk.toString('utf8')));
      stream.on('close', () => closeBoth(1000, 'SSH 连接已关闭'));
      ws.on('message', (raw) => {
        if (!stream || closed) return;
        let message = null;
        try {
          message = JSON.parse(raw.toString('utf8'));
        } catch {
          message = null;
        }

        if (message?.type === 'data' && typeof message.data === 'string') {
          stream.write(message.data);
          return;
        }

        if (message?.type === 'resize') {
          const cols = Number(message.cols) || 80;
          const rows = Number(message.rows) || 24;
          try {
            stream.setWindow(rows, cols, 0, 0);
          } catch {
            // ignore
          }
        }
      });
    };

    const tryFallbackExec = () => {
      const attempts = ['sh', '/bin/sh', 'bash -l', 'cmd.exe', 'powershell.exe -NoLogo -NoProfile'];
      const next = () => {
        const command = attempts.shift();
        if (!command) {
          closeBoth(1011, '无法打开交互式 shell');
          return;
        }
        client.exec(command, { pty: true }, (error, execStream) => {
          if (error) {
            next();
            return;
          }
          attachStream(execStream, `exec:${command}`);
        });
      };
      next();
    };

    const closeBoth = (code = 1000, reason = '') => {
      if (closed) return;
      closed = true;
      try {
        stream?.end();
      } catch {
        // ignore
      }
      try {
        client.end();
      } catch {
        // ignore
      }
      if (ws.readyState === 1) ws.close(code, reason);
      this.clearSshSession(sessionId);
    };

    client.on('ready', () => {
      client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (error, shellStream) => {
        if (error) {
          send('output', `\r\n[SSH] ${error.message || 'shell 打开失败'}\r\n`);
          tryFallbackExec();
          return;
        }
        attachStream(shellStream, 'shell');
      });
    });

    client.on('error', (error) => {
      send('output', `\r\n[SSH] ${error.message || 'SSH 连接失败'}\r\n`);
      closeBoth(1011, error.message || 'SSH 连接失败');
    });

    client.on('close', () => closeBoth(1000, 'SSH 连接已关闭'));

    client.connect({
      host: session.host,
      port: session.port,
      username: session.username,
      password: session.password,
      readyTimeout: 15000,
      keepaliveInterval: 10000,
      hostVerifier: () => true,
      tryKeyboard: true,
    });

    ws.on('close', () => closeBoth());
    ws.on('error', () => closeBoth());
  }

  handleRdpSocket(ws, sessionId) {
    const session = this.getRdpSession(sessionId);
    if (!session) {
      ws.close(1008, 'Invalid session');
      return;
    }

    const client = rdp.createClient({
      domain: session.domain,
      userName: session.username,
      password: session.password,
      enablePerf: true,
      autoLogin: true,
      decompress: true,
      screen: { width: session.width, height: session.height },
      locale: 'en',
      logLevel: 'ERROR',
    });

    try {
      client.mcs.clientCoreData.obj.colorDepth.value = 0x0018;
      client.mcs.clientCoreData.obj.postBeta2ColorDepth.value = 0x0018;
      client.mcs.clientCoreData.obj.highColorDepth.value = 0x0018;
      client.mcs.clientCoreData.obj.supportedColorDepths.value = 0x000f;
      client.global.clientCapabilities.obj.bitmapCapability.obj.preferredBitsPerPixel.value = 32;
      client.global.clientCapabilities.obj.bitmapCapability.obj.receive1BitPerPixel.value = 0;
      client.global.clientCapabilities.obj.bitmapCapability.obj.receive4BitsPerPixel.value = 0;
      client.global.clientCapabilities.obj.bitmapCapability.obj.receive8BitsPerPixel.value = 0;
      client.global.clientCapabilities.obj.bitmapCapability.obj.highColorFlags.value = 1;
    } catch {
      // ignore
    }

    let closed = false;
    const send = (type, data) => {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type, data }));
    };

    const closeBoth = () => {
      if (closed) return;
      closed = true;
      try {
        client.close();
      } catch {
        // ignore
      }
      if (ws.readyState === 1) ws.close();
      this.clearRdpSession(sessionId);
    };

    client.on('connect', () => {
      send('status', `RDP 已连接 (${session.width}x${session.height})`);
      send('ready', { width: session.width, height: session.height });
    });

    client.on('bitmap', (bitmap) => {
      if (closed) return;
      try {
        const rawData = bitmap.data;
        const bitmapBuffer = Buffer.isBuffer(rawData)
          ? rawData
          : rawData instanceof Uint8Array
            ? Buffer.from(rawData)
            : typeof rawData === 'string'
              ? Buffer.from(rawData, 'binary')
              : Buffer.from([]);
        send('bitmap', {
          left: bitmap.destLeft,
          top: bitmap.destTop,
          width: bitmap.width,
          height: bitmap.height,
          bitsPerPixel: bitmap.bitsPerPixel,
          isCompress: bitmap.isCompress,
          dataBase64: bitmapBuffer.toString('base64'),
        });
      } catch (error) {
        send('status', `RDP 位图传输失败: ${error.message || 'unknown error'}`);
      }
    });

    client.on('close', () => closeBoth());
    client.on('error', (error) => {
      send('status', `RDP 连接失败: ${error.message || 'unknown error'}`);
      closeBoth();
    });

    client.connect(session.host, session.port);

    ws.on('message', (raw) => {
      if (closed) return;
      let message = null;
      try {
        message = JSON.parse(raw.toString('utf8'));
      } catch {
        message = null;
      }
      if (!message) return;

      if (message.type === 'mouse') {
        const x = Number(message.x) || 0;
        const y = Number(message.y) || 0;
        const button = Number(message.button) || 0;
        const pressed = !!message.pressed;
        client.sendPointerEvent(x, y, button, pressed);
        return;
      }

      if (message.type === 'wheel') {
        const x = Number(message.x) || 0;
        const y = Number(message.y) || 0;
        const step = Number(message.step) || 0;
        client.sendWheelEvent(x, y, step, !!message.negative, !!message.horizontal);
        return;
      }

      if (message.type === 'key') {
        const key = String(message.key || '');
        const code = String(message.code || '');
        const pressed = !!message.pressed;
        const special = this.getRdpKeySpec(code, key);
        if (special) {
          client.sendKeyEventScancode(special.code, pressed, special.extended);
          return;
        }
        if (key.length === 1) {
          client.sendKeyEventUnicode(key.codePointAt(0), pressed);
        }
      }
    });

    ws.on('close', () => closeBoth());
    ws.on('error', () => closeBoth());
  }

  getRdpKeySpec(code, key) {
    const map = {
      KeyA: { code: 0x1e },
      KeyB: { code: 0x30 },
      KeyC: { code: 0x2e },
      KeyD: { code: 0x20 },
      KeyE: { code: 0x12 },
      KeyF: { code: 0x21 },
      KeyG: { code: 0x22 },
      KeyH: { code: 0x23 },
      KeyI: { code: 0x17 },
      KeyJ: { code: 0x24 },
      KeyK: { code: 0x25 },
      KeyL: { code: 0x26 },
      KeyM: { code: 0x32 },
      KeyN: { code: 0x31 },
      KeyO: { code: 0x18 },
      KeyP: { code: 0x19 },
      KeyQ: { code: 0x10 },
      KeyR: { code: 0x13 },
      KeyS: { code: 0x1f },
      KeyT: { code: 0x14 },
      KeyU: { code: 0x16 },
      KeyV: { code: 0x2f },
      KeyW: { code: 0x11 },
      KeyX: { code: 0x2d },
      KeyY: { code: 0x15 },
      KeyZ: { code: 0x2c },
      Digit1: { code: 0x02 },
      Digit2: { code: 0x03 },
      Digit3: { code: 0x04 },
      Digit4: { code: 0x05 },
      Digit5: { code: 0x06 },
      Digit6: { code: 0x07 },
      Digit7: { code: 0x08 },
      Digit8: { code: 0x09 },
      Digit9: { code: 0x0a },
      Digit0: { code: 0x0b },
      Minus: { code: 0x0c },
      Equal: { code: 0x0d },
      BracketLeft: { code: 0x1a },
      BracketRight: { code: 0x1b },
      Backslash: { code: 0x2b },
      Semicolon: { code: 0x27 },
      Quote: { code: 0x28 },
      Backquote: { code: 0x29 },
      Comma: { code: 0x33 },
      Period: { code: 0x34 },
      Slash: { code: 0x35 },
      Escape: { code: 0x01 },
      Backspace: { code: 0x0e },
      Tab: { code: 0x0f },
      Enter: { code: 0x1c },
      Space: { code: 0x39 },
      ShiftLeft: { code: 0x2a },
      ShiftRight: { code: 0x36 },
      ControlLeft: { code: 0x1d },
      ControlRight: { code: 0x1d, extended: true },
      AltLeft: { code: 0x38 },
      AltRight: { code: 0x38, extended: true },
      MetaLeft: { code: 0x5b, extended: true },
      MetaRight: { code: 0x5c, extended: true },
      Insert: { code: 0x52, extended: true },
      Delete: { code: 0x53, extended: true },
      Home: { code: 0x47, extended: true },
      End: { code: 0x4f, extended: true },
      PageUp: { code: 0x49, extended: true },
      PageDown: { code: 0x51, extended: true },
      ArrowUp: { code: 0x48, extended: true },
      ArrowDown: { code: 0x50, extended: true },
      ArrowLeft: { code: 0x4b, extended: true },
      ArrowRight: { code: 0x4d, extended: true },
      F1: { code: 0x3b },
      F2: { code: 0x3c },
      F3: { code: 0x3d },
      F4: { code: 0x3e },
      F5: { code: 0x3f },
      F6: { code: 0x40 },
      F7: { code: 0x41 },
      F8: { code: 0x42 },
      F9: { code: 0x43 },
      F10: { code: 0x44 },
      F11: { code: 0x57 },
      F12: { code: 0x58 },
    };
    return map[code] || map[key] || null;
  }

  writeNetworkLog(tool, target, port, status, message, detail, durationMs) {
    this.writeOperationLog(tool, message, target || '', detail || '', port);
  }

  writeOperationLog(category, action, target, detail = '', port = null) {
    this.db.run(
      'INSERT INTO network_logs (id, tool, target, port, operator, status, message, detail, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), category, target || '', port, currentOperator(), 'success', action, detail || '', null, now()]
    );
    this.db.scheduleSave();
  }

  bumpFail(username) {
    const current = this.db.get('SELECT * FROM login_locks WHERE username = ?', [username]);
    if (!current) {
      this.db.run(
        'INSERT INTO login_locks (id, username, fail_count, locked_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [uuidv4(), username, 1, null, now(), now()]
      );
      this.db.scheduleSave();
      return;
    }

    const failCount = Number(current.fail_count || 0) + 1;
    const lockedUntil = failCount >= 5 ? new Date(Date.now() + 5 * 60 * 1000).toISOString() : current.locked_until;
    this.db.run('UPDATE login_locks SET fail_count = ?, locked_until = ?, updated_at = ? WHERE username = ?', [failCount, lockedUntil, now(), username]);
    this.db.scheduleSave();
  }

  clearFail(username) {
    this.db.run('DELETE FROM login_locks WHERE username = ?', [username]);
    this.db.scheduleSave();
  }
}
