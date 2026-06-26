import fs from 'fs';
import path from 'path';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import GuacamoleLite from 'guacamole-lite';
import { Database } from './db.js';
import { PortalService, createGuacamoleKey } from './services.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const tlsDir = process.env.TLS_CERT_DIR || '/caddy-data';
const tlsCertPath = path.join(tlsDir, 'selfsigned.crt');
const tlsKeyPath = path.join(tlsDir, 'selfsigned.key');
const tlsHostsPath = path.join(tlsDir, 'selfsigned.hosts');

function ensureSelfSignedCertificate() {
  const hosts = String(process.env.TLS_HOSTS || 'localhost,127.0.0.1')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!hosts.length) return;

  fs.mkdirSync(tlsDir, { recursive: true });
  const normalizedHosts = hosts.join(',');
  if (fs.existsSync(tlsCertPath) && fs.existsSync(tlsKeyPath) && fs.existsSync(tlsHostsPath)) {
    const existingHosts = fs.readFileSync(tlsHostsPath, 'utf8').trim();
    if (existingHosts === normalizedHosts) return;
  }

  const configPath = path.join(tlsDir, 'selfsigned-openssl.cnf');
  const sanEntries = hosts.map((host, index) => {
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':');
    return isIp ? `IP.${index + 1} = ${host}` : `DNS.${index + 1} = ${host}`;
  }).join('\n');

  fs.writeFileSync(configPath, `
[ req ]
default_bits = 4096
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[ dn ]
C = CN
ST = Internal
L = Internal
O = OpsJump
OU = Operations
CN = ${hosts[0]}

[ v3_req ]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[ alt_names ]
${sanEntries}
`.trimStart());

  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:4096', '-sha256', '-nodes',
    '-days', '182500',
    '-keyout', tlsKeyPath,
    '-out', tlsCertPath,
    '-config', configPath,
  ], { stdio: 'inherit' });
  fs.writeFileSync(tlsHostsPath, `${normalizedHosts}\n`);
}

const config = {
  port: Number(process.env.PORT || 3001),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-key',
  guacSecret: process.env.GUAC_SECRET || process.env.JWT_SECRET || 'dev-secret-key',
  guacdHost: process.env.GUACD_HOST || '127.0.0.1',
  guacdPort: Number(process.env.GUACD_PORT || 4822),
  dbPath: process.env.DB_PATH || path.join(rootDir, 'data', 'app.db'),
};

function sendOk(res, data, message = 'ok') {
  res.json({ code: 0, message, data });
}

function sendErr(res, status, message) {
  res.status(status).json({ code: status, message, data: null });
}

function decodeHeaderValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return '';
  try {
    return decodeURIComponent(String(raw));
  } catch {
    return String(raw);
  }
}

function streamTransferParams(req) {
  return {
    host: decodeHeaderValue(req.headers['x-remote-host']),
    port: Number(decodeHeaderValue(req.headers['x-remote-port'])),
    username: decodeHeaderValue(req.headers['x-remote-username']),
    password: decodeHeaderValue(req.headers['x-remote-password']),
    useSsl: decodeHeaderValue(req.headers['x-remote-use-ssl']) === 'true',
    remotePath: decodeHeaderValue(req.headers['x-remote-path']) || '/',
    fileName: decodeHeaderValue(req.headers['x-file-name']),
  };
}

function setDownloadHeaders(res, fileName) {
  const safeName = fileName || 'download';
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`);
}

function authRequired(service) {
  return (req, res, next) => {
    const payload = service.verifyToken(req.headers.authorization);
    if (!payload) return sendErr(res, 401, '未登录或登录已过期');
    req.user = payload;
    next();
  };
}

function adminRequired(req, res, next) {
  if (req.user?.role !== 'admin') return sendErr(res, 403, '仅管理员可执行此操作');
  next();
}

async function main() {
  ensureSelfSignedCertificate();
  const db = new Database(config.dbPath);
  await db.init();
  const service = new PortalService(db, config);
  const asOperator = (operator, fn) => service.withOperator(operator, fn);

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: process.env.UPLOAD_JSON_LIMIT || '1024mb' }));

  app.get('/api/health', (_req, res) => sendOk(res, { status: 'ok', timestamp: new Date().toISOString() }));

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return sendErr(res, 400, '用户名和密码不能为空');
    const operator = String(username).trim();
    const result = asOperator(operator, () => service.login(operator, String(password), String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')));
    if (!result.ok) return sendErr(res, result.status, result.message);
    sendOk(res, result.data, '登录成功');
  });

  app.get('/api/auth/me', authRequired(service), (req, res) => {
    const user = db.get('SELECT id, username, real_name AS realName, role, status, created_at AS createdAt, updated_at AS updatedAt FROM users WHERE id = ?', [req.user.userId]);
    if (!user) return sendErr(res, 404, '用户不存在');
    sendOk(res, user);
  });

  app.post('/api/auth/logout', authRequired(service), (_req, res) => sendOk(res, null, '已退出'));
  app.put('/api/auth/password', authRequired(service), async (req, res) => {
    try {
      const { oldPassword, newPassword } = req.body || {};
      if (!oldPassword || !newPassword) return sendErr(res, 400, '原密码和新密码不能为空');
      sendOk(res, await asOperator(req.user.username, () => service.changeOwnPassword(req.user.userId, String(oldPassword), String(newPassword))), '密码修改成功');
    } catch (error) {
      sendErr(res, 400, error.message || '密码修改失败');
    }
  });

  app.get('/api/shortcuts', authRequired(service), (_req, res) => sendOk(res, service.listShortcuts()));
  app.post('/api/shortcuts', authRequired(service), (req, res) => {
    const { title, url, icon, color, sortOrder } = req.body || {};
    if (!title || !url) return sendErr(res, 400, '标题和地址不能为空');
    sendOk(res, asOperator(req.user.username, () => service.createShortcut({ title, url, icon, color, sortOrder })), '创建成功');
  });
  app.put('/api/shortcuts/:id', authRequired(service), (req, res) => {
    const result = asOperator(req.user.username, () => service.updateShortcut(req.params.id, req.body || {}));
    if (!result) return sendErr(res, 404, '快捷按钮不存在');
    sendOk(res, result, '更新成功');
  });
  app.delete('/api/shortcuts/:id', authRequired(service), (req, res) => {
    if (!asOperator(req.user.username, () => service.deleteShortcut(req.params.id))) return sendErr(res, 404, '快捷按钮不存在');
    sendOk(res, null, '删除成功');
  });

  app.post('/api/network/ping', authRequired(service), async (req, res) => {
    try {
      const { target, count } = req.body || {};
      if (!target) return sendErr(res, 400, '目标不能为空');
      sendOk(res, await asOperator(req.user.username, () => service.ping({ target, count })));
    } catch (error) {
      sendErr(res, 500, error.message || 'ping 失败');
    }
  });
  app.post('/api/network/port-check', authRequired(service), async (req, res) => {
    try {
      const { host, port } = req.body || {};
      if (!host || !port) return sendErr(res, 400, '主机和端口不能为空');
      sendOk(res, await asOperator(req.user.username, () => service.checkPort({ host, port })));
    } catch (error) {
      sendErr(res, 500, error.message || '端口检测失败');
    }
  });
  app.get('/api/network/logs', authRequired(service), (req, res) => {
    sendOk(res, service.listNetworkLogs(req.query.limit || 50));
  });
  app.get('/api/network/ping/stream', authRequired(service), (req, res) => {
    const target = String(req.query.target || '').trim();
    const count = Number(req.query.count || 0);
    if (!target) return sendErr(res, 400, '目标不能为空');
    asOperator(req.user.username, () => service.openPingStream({ target, count }, res));
  });

  app.post('/api/remote/ftp/list', authRequired(service), async (req, res) => {
    try {
      const { host, port, username, password, useSsl, remotePath } = req.body || {};
      if (!host || !port || !username) return sendErr(res, 400, 'FTP 参数不完整');
      sendOk(res, await asOperator(req.user.username, () => service.listFtp({ host, port, username, password: password || '', useSsl: !!useSsl, remotePath: remotePath || '/' })));
    } catch (error) {
      sendErr(res, 500, error.message || 'FTP 登录失败');
    }
  });
  app.post('/api/remote/ftp/download', authRequired(service), async (req, res) => {
    try {
      const { host, port, username, password, useSsl, remotePath } = req.body || {};
      if (!host || !port || !username || !remotePath) return sendErr(res, 400, 'FTP 参数不完整');
      sendOk(res, await asOperator(req.user.username, () => service.downloadFtp({ host, port, username, password: password || '', useSsl: !!useSsl, remotePath })));
    } catch (error) {
      sendErr(res, 500, error.message || 'FTP 下载失败');
    }
  });
  app.post('/api/remote/ftp/download-stream', authRequired(service), async (req, res) => {
    try {
      const { host, port, username, password, useSsl, remotePath } = req.body || {};
      if (!host || !port || !username || !remotePath) return sendErr(res, 400, 'FTP 参数不完整');
      setDownloadHeaders(res, path.basename(remotePath));
      await asOperator(req.user.username, () => service.downloadFtpStream({ host, port, username, password: password || '', useSsl: !!useSsl, remotePath }, res));
      if (!res.writableEnded) res.end();
    } catch (error) {
      if (!res.headersSent) sendErr(res, 500, error.message || 'FTP 下载失败');
      else res.destroy(error);
    }
  });
  app.post('/api/remote/ftp/upload', authRequired(service), async (req, res) => {
    try {
      const { host, port, username, password, useSsl, remotePath, fileName, contentBase64 } = req.body || {};
      if (!host || !port || !username || !remotePath || !fileName || !contentBase64) return sendErr(res, 400, 'FTP 参数不完整');
      sendOk(res, await asOperator(req.user.username, () => service.uploadFtp({ host, port, username, password: password || '', useSsl: !!useSsl, remotePath, fileName, contentBase64 })));
    } catch (error) {
      sendErr(res, 500, error.message || 'FTP 上传失败');
    }
  });
  app.post('/api/remote/ftp/upload-stream', authRequired(service), async (req, res) => {
    try {
      const params = streamTransferParams(req);
      if (!params.host || !params.port || !params.username || !params.remotePath || !params.fileName) return sendErr(res, 400, 'FTP 参数不完整');
      sendOk(res, await asOperator(req.user.username, () => service.uploadFtpStream(params, req)));
    } catch (error) {
      sendErr(res, 500, error.message || 'FTP 上传失败');
    }
  });
  app.post('/api/remote/ftp/delete', authRequired(service), async (req, res) => {
    try {
      const { host, port, username, password, useSsl, remotePath } = req.body || {};
      if (!host || !port || !username || !remotePath) return sendErr(res, 400, 'FTP 参数不完整');
      sendOk(res, await asOperator(req.user.username, () => service.deleteFtp({ host, port, username, password: password || '', useSsl: !!useSsl, remotePath })));
    } catch (error) {
      sendErr(res, 500, error.message || 'FTP 删除失败');
    }
  });

  app.post('/api/remote/sftp/list', authRequired(service), async (req, res) => {
    try {
      const { host, port, username, password, remotePath } = req.body || {};
      if (!host || !port || !username) return sendErr(res, 400, 'SFTP 参数不完整');
      sendOk(res, await asOperator(req.user.username, () => service.listSftp({ host, port, username, password: password || '', remotePath: remotePath || '/' })));
    } catch (error) {
      sendErr(res, 500, error.message || 'SFTP 登录失败');
    }
  });
  app.post('/api/remote/sftp/download', authRequired(service), async (req, res) => {
    try {
      const { host, port, username, password, remotePath } = req.body || {};
      if (!host || !port || !username || !remotePath) return sendErr(res, 400, 'SFTP 参数不完整');
      sendOk(res, await asOperator(req.user.username, () => service.downloadSftp({ host, port, username, password: password || '', remotePath })));
    } catch (error) {
      sendErr(res, 500, error.message || 'SFTP 下载失败');
    }
  });
  app.post('/api/remote/sftp/download-stream', authRequired(service), async (req, res) => {
    try {
      const { host, port, username, password, remotePath } = req.body || {};
      if (!host || !port || !username || !remotePath) return sendErr(res, 400, 'SFTP 参数不完整');
      setDownloadHeaders(res, path.basename(remotePath));
      await asOperator(req.user.username, () => service.downloadSftpStream({ host, port, username, password: password || '', remotePath }, res));
      if (!res.writableEnded) res.end();
    } catch (error) {
      if (!res.headersSent) sendErr(res, 500, error.message || 'SFTP 下载失败');
      else res.destroy(error);
    }
  });
  app.post('/api/remote/sftp/upload', authRequired(service), async (req, res) => {
    try {
      const { host, port, username, password, remotePath, fileName, contentBase64 } = req.body || {};
      if (!host || !port || !username || !remotePath || !fileName || !contentBase64) return sendErr(res, 400, 'SFTP 参数不完整');
      sendOk(res, await asOperator(req.user.username, () => service.uploadSftp({ host, port, username, password: password || '', remotePath, fileName, contentBase64 })));
    } catch (error) {
      sendErr(res, 500, error.message || 'SFTP 上传失败');
    }
  });
  app.post('/api/remote/sftp/upload-stream', authRequired(service), async (req, res) => {
    try {
      const params = streamTransferParams(req);
      if (!params.host || !params.port || !params.username || !params.remotePath || !params.fileName) return sendErr(res, 400, 'SFTP 参数不完整');
      sendOk(res, await asOperator(req.user.username, () => service.uploadSftpStream(params, req)));
    } catch (error) {
      sendErr(res, 500, error.message || 'SFTP 上传失败');
    }
  });
  app.post('/api/remote/sftp/delete', authRequired(service), async (req, res) => {
    try {
      const { host, port, username, password, remotePath } = req.body || {};
      if (!host || !port || !username || !remotePath) return sendErr(res, 400, 'SFTP 参数不完整');
      sendOk(res, await asOperator(req.user.username, () => service.deleteSftp({ host, port, username, password: password || '', remotePath })));
    } catch (error) {
      sendErr(res, 500, error.message || 'SFTP 删除失败');
    }
  });
  app.post('/api/remote/vnc/session', authRequired(service), async (req, res) => {
    try {
      const { host, port } = req.body || {};
      if (!host || !port) return sendErr(res, 400, 'VNC 地址和端口不能为空');
      sendOk(res, await asOperator(req.user.username, () => service.createVncSession({ host, port })));
    } catch (error) {
      sendErr(res, 400, error.message || 'VNC 连接失败');
    }
  });
  app.post('/api/remote/ssh/session', authRequired(service), async (req, res) => {
    try {
      const { host, port, username, password } = req.body || {};
      if (!host || !port || !username) return sendErr(res, 400, 'SSH 参数不完整');
      sendOk(res, await asOperator(req.user.username, () => service.createSshSession({ host, port, username, password: password || '' })));
    } catch (error) {
      sendErr(res, 400, error.message || 'SSH 连接失败');
    }
  });
  app.post('/api/ssh/session', authRequired(service), async (req, res) => {
    try {
      const { host, port, username, password } = req.body || {};
      if (!host || !port || !username) return sendErr(res, 400, 'SSH 参数不完整');
      sendOk(res, await asOperator(req.user.username, () => service.createSshSession({ host, port, username, password: password || '' })));
    } catch (error) {
      sendErr(res, 400, error.message || 'SSH 连接失败');
    }
  });
  app.post('/api/remote/rdp/session', authRequired(service), (req, res) => {
    const { host, port, username, password, domain, width, height } = req.body || {};
    if (!host || !port || !username) return sendErr(res, 400, 'RDP 参数不完整');
    Promise.resolve(asOperator(req.user.username, () => service.createRdpSession({ host, port, username, password: password || '', domain: domain || '', width, height })))
      .then((data) => sendOk(res, data))
      .catch((error) => sendErr(res, 503, error.message || 'guacd 不可用'));
  });

  app.get('/api/users', authRequired(service), adminRequired, (_req, res) => {
    sendOk(res, service.listUsers());
  });
  app.post('/api/users', authRequired(service), adminRequired, (req, res) => {
    try {
      sendOk(res, asOperator(req.user.username, () => service.createUser(req.body || {})), '用户创建成功');
    } catch (error) {
      sendErr(res, 400, error.message || '用户创建失败');
    }
  });
  app.put('/api/users/:id', authRequired(service), adminRequired, (req, res) => {
    try {
      sendOk(res, asOperator(req.user.username, () => service.updateUser(req.params.id, req.body || {})), '用户更新成功');
    } catch (error) {
      sendErr(res, 400, error.message || '用户更新失败');
    }
  });
  app.put('/api/users/:id/status', authRequired(service), adminRequired, (req, res) => {
    try {
      sendOk(res, asOperator(req.user.username, () => service.setUserStatus(req.params.id, req.body?.status)), '用户状态已更新');
    } catch (error) {
      sendErr(res, 400, error.message || '用户状态更新失败');
    }
  });
  app.put('/api/users/:id/password', authRequired(service), adminRequired, (req, res) => {
    try {
      sendOk(res, asOperator(req.user.username, () => service.resetUserPassword(req.params.id, req.body?.password)), '密码已重置');
    } catch (error) {
      sendErr(res, 400, error.message || '密码重置失败');
    }
  });

  app.get('/api/ca/root.crt', (_req, res) => {
    const certPath = tlsCertPath;
    if (!fs.existsSync(certPath)) return sendErr(res, 404, '证书不存在');
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="caddy-root-ca.crt"');
    res.sendFile(certPath);
  });

  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
  }

  const server = http.createServer(app);
  const guacServer = new GuacamoleLite(
    { server: null, noServer: true },
    { host: config.guacdHost, port: config.guacdPort },
    {
      crypt: {
        cypher: 'AES-256-CBC',
        key: createGuacamoleKey(config.guacSecret),
      },
      log: {
        level: 'ERRORS',
        stdLog: () => {},
        errorLog: (...args) => console.error(...args),
      },
      connectionDefaultSettings: {
        rdp: {
          'create-drive-path': true,
          security: 'any',
          'ignore-cert': true,
          'enable-wallpaper': false,
          'enable-theming': false,
          'create-recording-path': false,
          audio: ['audio/L16'],
          video: null,
          image: ['image/png', 'image/jpeg'],
          timezone: null,
        },
      },
    },
    {
      processConnectionSettings: (settings, callback) => {
        if (!settings?.sessionId) {
          callback(new Error('Missing RDP session id'));
          return;
        }
        callback(null, settings);
      },
    }
  );

  guacServer.on('close', (clientConnection) => {
    const sessionId = clientConnection?.connectionSettings?.sessionId;
    if (sessionId) service.clearRdpSession(sessionId);
  });

  guacServer.on('error', (clientConnection) => {
    const sessionId = clientConnection?.connectionSettings?.sessionId;
    if (sessionId) service.clearRdpSession(sessionId);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const isRdp = url.pathname.startsWith('/api/remote/rdp/ws');
    const isSsh = url.pathname.startsWith('/api/remote/ssh/ws/') || url.pathname.startsWith('/api/ssh/ws/');
    const isVnc = url.pathname.startsWith('/api/remote/vnc/ws/');
    if (!isRdp && !isSsh && !isVnc) {
      socket.destroy();
      return;
    }
    const sessionId = url.pathname.split('/').pop();
    if (!sessionId) {
      socket.destroy();
      return;
    }
    if (isRdp) {
      guacServer.webSocketServer.handleUpgrade(req, socket, head, (ws) => {
        guacServer.webSocketServer.emit('connection', ws, req);
      });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, sessionId);
    });
  });

  wss.on('connection', (ws, _req, sessionId) => {
    if ((_req?.url || '').includes('/api/remote/ssh/ws/') || (_req?.url || '').includes('/api/ssh/ws/')) {
      service.handleSshSocket(ws, sessionId);
      return;
    }
    service.handleVncSocket(ws, sessionId);
  });

  server.listen(config.port, '0.0.0.0', () => {
    console.log(`OpsJump running at http://localhost:${config.port}`);
    console.log(`Default account: admin / admin123`);
    console.log(`Database: ${config.dbPath}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
