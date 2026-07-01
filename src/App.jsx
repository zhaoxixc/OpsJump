import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest } from './api';
import { clearAuth, getStoredAuth, saveAuth } from './auth';

const VncViewer = lazy(() => import('./VncViewer'));
const SshTerminal = lazy(() => import('./SshTerminal'));
const RdpViewer = lazy(() => import('./RdpViewer'));

const emptyShortcut = { title: '', url: '', icon: '', color: '#2563eb', sortOrder: 0 };
const emptyLogin = { host: '', port: 21, username: '', password: '', useSsl: false };
const emptyPing = { target: '', count: 0 };
const emptyPort = { host: '', port: 80 };
const emptyVnc = { host: '', port: 5900, password: '' };
const emptySsh = { host: '', port: 22, username: '', password: '' };
const emptyRdp = { host: '', port: 3389, domain: '', username: '', password: '' };
const HOST_PRESET_KEY = 'quick-portal-host-presets';
const SHORTCUT_CATEGORY_KEY = 'quick-portal-shortcut-category';

function loadHostPresets() {
  try {
    const raw = localStorage.getItem(HOST_PRESET_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHostPresets(presets) {
  localStorage.setItem(HOST_PRESET_KEY, JSON.stringify(presets));
}

function groupPresets(presets, protocol) {
  return presets.filter((preset) => preset.protocol === protocol);
}

function loadShortcutCategory() {
  return localStorage.getItem(SHORTCUT_CATEGORY_KEY) || '全部';
}

function makePresetId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `preset-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString() : '-';
}

function normalizePath(value) {
  if (!value || value === '/') return '/';
  const trimmed = value.replace(/\/+$/, '');
  return trimmed || '/';
}

function joinPath(base, name) {
  const cleanBase = normalizePath(base);
  return cleanBase === '/' ? `/${name}` : `${cleanBase}/${name}`;
}

function parentPath(value) {
  const clean = normalizePath(value);
  if (clean === '/') return '/';
  const parts = clean.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join('/')}` : '/';
}

function splitPath(value) {
  return normalizePath(value).split('/').filter(Boolean);
}

function streamApiPath(path) {
  return String(path || '').replace(/\/(upload|download)$/, '/$1-stream');
}

function encodeHeaderValue(value) {
  return encodeURIComponent(String(value ?? ''));
}

function streamTransferHeaders(login, remotePath, fileName) {
  const headers = {
    'Content-Type': 'application/octet-stream',
    'X-Remote-Host': encodeHeaderValue(login.host),
    'X-Remote-Port': encodeHeaderValue(login.port),
    'X-Remote-Username': encodeHeaderValue(login.username),
    'X-Remote-Password': encodeHeaderValue(login.password || ''),
    'X-Remote-Path': encodeHeaderValue(remotePath || '/'),
    'X-File-Name': encodeHeaderValue(fileName),
  };
  if ('useSsl' in login) headers['X-Remote-Use-Ssl'] = login.useSsl ? 'true' : 'false';
  return headers;
}

function formatPingEvent(entry) {
  if (!entry) return '';
  if (entry.ok) {
    return `Reply from ${entry.address || ''}: bytes=32 time=${entry.time ?? 0}ms ttl=${entry.ttl ?? 0}`.trim();
  }
  if (entry.line) {
    const raw = String(entry.line);
    const replyMatch = raw.match(/Reply from\s+([^:]+):\s+bytes=\d+\s+time[=<]?(\d+)ms\s+TTL=(\d+)/i);
    if (replyMatch) {
      return `Reply from ${replyMatch[1]}: bytes=32 time=${replyMatch[2]}ms ttl=${replyMatch[3]}`;
    }
    if (/Request timed out|请求超时/i.test(raw)) {
      return `Request timed out ${entry.address || ''}`.trim();
    }
    return `Ping output: ${raw}`;
  }
  return `Request timed out ${entry.address || ''}`.trim();
}

function Card({ title, subtitle, action, children }) {
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function FullscreenToolbar({ label, status, onExit, onDisconnect }) {
  return (
    <div className="fullscreen-toolbar">
      <div>
        <strong>{label}</strong>
        <small>{status}</small>
      </div>
      <button className="ghost" type="button" onClick={onExit}>退出全屏</button>
      {onDisconnect ? <button className="ghost danger" type="button" onClick={onDisconnect}>断开</button> : null}
    </div>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function PresetBar({ protocol, presets, selectedId, onApply, onSave, onDelete }) {
  return (
    <div className="preset-bar">
      <select value={selectedId || ''} onChange={(e) => onApply(e.target.value)}>
        <option value="">常用主机</option>
        {presets.map((preset) => (
          <option key={preset.id} value={preset.id}>{preset.name}</option>
        ))}
      </select>
      <button type="button" className="ghost" onClick={onSave}>保存/更新</button>
      <button type="button" className="ghost danger" onClick={onDelete} disabled={!selectedId}>删除</button>
      <small>{protocol.toUpperCase()}</small>
    </div>
  );
}

function TabBar({ tab, setTab, user, onAbout }) {
  return (
    <div className="mobile-nav">
      {[
        ['shortcuts', '快捷'],
        ['remote', '远程'],
        ['vnc', 'VNC'],
        ['ssh', 'SSH'],
        ['rdp', '桌面'],
        ['network', '网络'],
        ['logs', '日志'],
      ].map(([key, label]) => (
        <button key={key} type="button" className={tab === key ? 'nav active' : 'nav'} onClick={() => setTab(key)}>
          {label}
        </button>
      ))}
      {user?.role === 'admin' ? (
        <button type="button" className={tab === 'users' ? 'nav active' : 'nav'} onClick={() => setTab('users')}>用户</button>
      ) : null}
      <button type="button" className="nav" onClick={onAbout}>关于</button>
    </div>
  );
}

function RemotePanel({
  label,
  presetProtocol,
  presets,
  loginApi,
  listApi,
  downloadApi,
  uploadApi,
  deleteApi,
  login,
  setLogin,
  connected,
  setConnected,
  currentPath,
  setCurrentPath,
  items,
  setItems,
  status,
  setStatus,
  token,
  refreshLogs,
  onDisconnect,
  onSavePreset,
  onApplyPreset,
  onDeletePreset,
  selectedId,
}) {
  const fileInputRef = useRef(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [isCompact, setIsCompact] = useState(false);
  const [transferStatus, setTransferStatus] = useState('');
  const pageSize = 20;

  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const update = () => setIsCompact(media.matches);
    update();
    media.addEventListener?.('change', update);
    media.addListener?.(update);
    return () => {
      media.removeEventListener?.('change', update);
      media.removeListener?.(update);
    };
  }, []);

  const authedRequest = async (path, options = {}) => apiRequest(path, { ...options, token });

  const loadPath = async (nextPath = currentPath || '/', allowDisconnected = false) => {
    if (!allowDisconnected && !connected) return;
    setLoading(true);
    try {
      const data = await authedRequest(listApi, { method: 'POST', body: { ...login, remotePath: nextPath } });
      setItems(data.items || []);
      setCurrentPath(nextPath);
      setStatus(data.message || `${label} 已连接`);
      setConnected(true);
      setPage(1);
    } catch (error) {
      if (allowDisconnected) throw error;
      pushNotice(error instanceof Error ? error.message : `${label} 浏览失败`);
      setStatus(`${label} 浏览失败`);
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async (e) => {
    e.preventDefault();
    try {
      setStatus('正在登录...');
      await loadPath('/', true);
      await refreshLogs();
    } catch (error) {
      setConnected(false);
      setStatus('登录失败');
      pushNotice(error instanceof Error ? error.message : `${label} 登录失败`);
    }
  };

  const goParent = async () => {
    if (!connected || loading) return;
    await loadPath(parentPath(currentPath));
  };

  const openDir = async (name) => {
    if (!connected || loading) return;
    await loadPath(joinPath(currentPath, name));
  };

  const openBreadcrumb = async (index) => {
    if (!connected || loading) return;
    const parts = splitPath(currentPath).slice(0, index + 1);
    await loadPath(parts.length ? `/${parts.join('/')}` : '/');
  };

  const refresh = async () => {
    if (!connected || loading) return;
    await loadPath(currentPath || '/');
  };

  const totalPages = Math.max(1, Math.ceil((items?.length || 0) / pageSize));
  const safePage = Math.min(page, totalPages);
  const paginatedItems = items.slice((safePage - 1) * pageSize, safePage * pageSize);

  const doDownload = async (item) => {
    if (!connected || loading) return;
    try {
      setTransferStatus(`正在下载 ${item.name}...`);
      const response = await fetch(streamApiPath(downloadApi), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...login, remotePath: joinPath(currentPath, item.name) }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message || `${label} 下载失败`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = item.name;
      a.click();
      URL.revokeObjectURL(url);
      setTransferStatus(`已下载 ${item.name}`);
    } catch (error) {
      pushNotice(error instanceof Error ? error.message : `${label} 下载失败`);
      setTransferStatus('下载失败');
    }
  };

  const doDelete = async (item) => {
    if (!connected || loading) return;
    if (!window.confirm(`删除 ${item.name} ?`)) return;
    try {
      await authedRequest(deleteApi, { method: 'POST', body: { ...login, remotePath: joinPath(currentPath, item.name) } });
      await refresh();
      await refreshLogs();
      setTransferStatus(`已删除 ${item.name}`);
    } catch (error) {
      pushNotice(error instanceof Error ? error.message : `${label} 删除失败`);
    }
  };

  const disconnect = () => {
    setConnected(false);
    setItems([]);
    setCurrentPath('/');
    setStatus('已断开连接');
    setPage(1);
    setLogin((current) => ({ ...current, password: '' }));
    onDisconnect?.();
  };

  const triggerUpload = () => {
    if (!connected || loading) return;
    fileInputRef.current?.click();
  };

  const uploadFile = async (event) => {
    if (!connected || loading) {
      event.target.value = '';
      return;
    }
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setTransferStatus(`正在上传 ${file.name}...`);
      const response = await fetch(streamApiPath(uploadApi), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          ...streamTransferHeaders(login, currentPath || '/', file.name),
        },
        body: file,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.code !== 0) throw new Error(payload?.message || `${label} 上传失败`);
      fileInputRef.current.value = '';
      await refresh();
      await refreshLogs();
      setTransferStatus(`已上传 ${file.name}`);
    } catch (error) {
      pushNotice(error instanceof Error ? error.message : `${label} 上传失败`);
      setTransferStatus('上传失败');
    }
  };

  return (
    <Card
      title={`${label} 登录和文件操作`}
      subtitle="输入连接信息后直接进入目录浏览、上传、下载和删除"
      action={(
      <div className="remote-actions sticky">
          <button className="ghost" type="button" onClick={goParent} disabled={!connected || loading}>上一级</button>
          <button className="ghost" type="button" onClick={refresh} disabled={!connected || loading}>刷新</button>
          <button className="ghost" type="button" onClick={triggerUpload} disabled={!connected || loading}>上传</button>
          <button className="ghost danger" type="button" onClick={disconnect} disabled={!connected || loading}>断开连接</button>
        </div>
      )}
    >
      <PresetBar
        protocol={presetProtocol}
        presets={presets}
        selectedId={selectedId}
        onApply={(id) => onApplyPreset?.(presetProtocol, id)}
        onSave={() => onSavePreset?.(presetProtocol, login)}
        onDelete={() => onDeletePreset?.(presetProtocol)}
      />

      <form className="grid-form remote-login-form" onSubmit={handleConnect}>
        <input placeholder="主机 IP" value={login.host} onChange={(e) => setLogin({ ...login, host: e.target.value })} />
        <input type="number" placeholder="端口" value={login.port} onChange={(e) => setLogin({ ...login, port: e.target.value })} />
        <input placeholder="用户名" value={login.username} onChange={(e) => setLogin({ ...login, username: e.target.value })} />
        <input type="password" placeholder="密码" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} />
        <label className="check"><input type="checkbox" checked={login.useSsl} onChange={(e) => setLogin({ ...login, useSsl: e.target.checked })} /> 使用 SSL</label>
        <button type="submit">登录</button>
      </form>

      <input ref={fileInputRef} type="file" hidden onChange={uploadFile} />
      <div className="status-strip">
        <span className={connected ? 'status-pill ok' : 'status-pill'}>{connected ? (loading ? '浏览中' : '已连接') : '未连接'}</span>
        <span>状态: {connected ? (loading ? '加载中...' : (status || `${label} 已连接`)) : '未连接'}</span>
        <span>路径: {currentPath || '/'}</span>
        {transferStatus ? <span>{transferStatus}</span> : null}
      </div>

      <div className="breadcrumbs">
        <button className="ghost" type="button" onClick={() => loadPath('/', true)} disabled={!connected}>/</button>
        {splitPath(currentPath).map((part, index) => (
          <button key={`${part}-${index}`} className="ghost" type="button" onClick={() => openBreadcrumb(index)} disabled={!connected}>
            {part}
          </button>
        ))}
      </div>

      <div className={isCompact ? 'explorer-shell compact' : 'explorer-shell'}>
        {!isCompact ? (
          <aside className="explorer-tree">
            <div className="explorer-title">目录树</div>
            <button className="tree-node active" type="button" onClick={() => loadPath('/', true)} disabled={!connected || loading}>/</button>
            {splitPath(currentPath).map((part, index) => (
              <button key={`${part}-${index}`} className="tree-node" type="button" onClick={() => openBreadcrumb(index)} disabled={!connected || loading}>
                {part}
              </button>
            ))}
            {items.filter((item) => item.type === 'directory').map((item) => (
              <button key={item.name} className="tree-node child" type="button" onClick={() => openDir(item.name)} disabled={!connected || loading}>
                {item.name}
              </button>
            ))}
          </aside>
        ) : null}

        <div className="table-wrap remote-table">
          {isCompact ? (
            <div className="remote-list">
              {paginatedItems.map((item) => (
                <article key={`${item.name}-${item.type}`} className="remote-item">
                  <div className="remote-item-main">
                    <strong>{item.name}</strong>
                    <small>{item.type === 'directory' ? '目录' : '文件'} · {item.size || '-'} · {formatTime(item.modifiedAt)}</small>
                  </div>
                  <div className="remote-item-actions">
                    {item.type === 'directory' ? (
                      <button className="ghost" type="button" onClick={() => openDir(item.name)} disabled={!connected || loading}>打开</button>
                    ) : (
                      <>
                        <button className="ghost" type="button" onClick={() => doDownload(item)} disabled={!connected || loading}>下载</button>
                        <button className="ghost danger" type="button" onClick={() => doDelete(item)} disabled={!connected || loading}>删除</button>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>大小</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {paginatedItems.map((item) => (
                <tr key={`${item.name}-${item.type}`}>
                  <td>{item.name}</td>
                  <td>{item.type === 'directory' ? '目录' : '文件'}</td>
                  <td>{item.size || '-'}</td>
                  <td>{formatTime(item.modifiedAt)}</td>
                  <td>
                    {item.type === 'directory' ? (
                      <button className="ghost" type="button" onClick={() => openDir(item.name)} disabled={!connected}>打开</button>
                    ) : (
                      <div className="row-actions">
                        <button className="ghost" type="button" onClick={() => doDownload(item)} disabled={!connected}>下载</button>
                        <button className="ghost danger" type="button" onClick={() => doDelete(item)} disabled={!connected}>删除</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
        </div>
      </div>
      {items.length > pageSize ? (
        <div className="pagination">
          <button className="ghost" type="button" onClick={() => setPage((v) => Math.max(1, v - 1))} disabled={safePage <= 1}>上一页</button>
          <span>第 {safePage} / {totalPages} 页</span>
          <button className="ghost" type="button" onClick={() => setPage((v) => Math.min(totalPages, v + 1))} disabled={safePage >= totalPages}>下一页</button>
        </div>
      ) : null}
    </Card>
  );
}

export default function App() {
  const stored = useMemo(() => getStoredAuth(), []);
  const [token, setToken] = useState(stored.token);
  const [user, setUser] = useState(stored.user);
  const [loading, setLoading] = useState(false);
  const [notices, setNotices] = useState([]);
  const [tab, setTab] = useState('shortcuts');
  const noticeTimersRef = useRef(new Map());

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const [shortcuts, setShortcuts] = useState([]);
  const [shortcutModal, setShortcutModal] = useState(false);
  const [editingShortcut, setEditingShortcut] = useState(null);
  const [shortcutForm, setShortcutForm] = useState({ ...emptyShortcut, category: '默认' });

  const [ftpLogin, setFtpLogin] = useState(emptyLogin);
  const [ftpItems, setFtpItems] = useState([]);
  const [ftpPath, setFtpPath] = useState('/');
  const [ftpConnected, setFtpConnected] = useState(false);
  const [ftpStatus, setFtpStatus] = useState('未连接');

  const [sftpLogin, setSftpLogin] = useState({ host: '', port: 22, username: '', password: '' });
  const [sftpItems, setSftpItems] = useState([]);
  const [sftpPath, setSftpPath] = useState('/');
  const [sftpConnected, setSftpConnected] = useState(false);
  const [sftpStatus, setSftpStatus] = useState('未连接');

  const [vncForm, setVncForm] = useState(emptyVnc);
  const [vncSessionId, setVncSessionId] = useState('');
  const [vncStatus, setVncStatus] = useState('未连接');
  const [vncExpanded, setVncExpanded] = useState(false);

  const [sshForm, setSshForm] = useState(emptySsh);
  const [sshSessionId, setSshSessionId] = useState('');
  const [sshStatus, setSshStatus] = useState('未连接');
  const [sshExpanded, setSshExpanded] = useState(false);

  const [rdpForm, setRdpForm] = useState(emptyRdp);
  const [rdpSessionId, setRdpSessionId] = useState('');
  const [rdpConnectionToken, setRdpConnectionToken] = useState('');
  const [rdpStatus, setRdpStatus] = useState('未连接');
  const [rdpExpanded, setRdpExpanded] = useState(false);

  const [pingForm, setPingForm] = useState(emptyPing);
  const [pingLines, setPingLines] = useState([]);
  const [pingStatus, setPingStatus] = useState('未开始');
  const pingAbortRef = useRef(null);

  const [portForm, setPortForm] = useState(emptyPort);
  const [portResult, setPortResult] = useState(null);

  const [logs, setLogs] = useState([]);
  const [logQuery, setLogQuery] = useState('');
  const [logTool, setLogTool] = useState('all');
  const [users, setUsers] = useState([]);
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [userForm, setUserForm] = useState({ username: '', realName: '', password: '', role: 'user', status: 'active' });
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [passwordTarget, setPasswordTarget] = useState(null);
  const [passwordForm, setPasswordForm] = useState({ oldPassword: '', newPassword: '' });
  const [aboutOpen, setAboutOpen] = useState(false);
  const [hostPresets, setHostPresets] = useState(() => loadHostPresets());
  const [presetSelections, setPresetSelections] = useState({ ftp: '', sftp: '', vnc: '', ssh: '', rdp: '', network: '' });
  const [shortcutCategory, setShortcutCategory] = useState(() => loadShortcutCategory());
  const [shortcutPage, setShortcutPage] = useState(1);
  const shortcutPageSize = 12;

  const authedRequest = async (path, options = {}) => apiRequest(path, { ...options, token });

  const dismissNotice = (id) => {
    const timer = noticeTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      noticeTimersRef.current.delete(id);
    }
    setNotices((prev) => prev.filter((item) => item.id !== id));
  };

  const pushNotice = (message, kind = 'error') => {
    if (!message) return;
    const id = `notice-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setNotices((prev) => [...prev, { id, message, kind }]);
    const timer = window.setTimeout(() => dismissNotice(id), 4000);
    noticeTimersRef.current.set(id, timer);
  };

  const refreshShortcuts = async () => {
    setShortcuts(await authedRequest('/api/shortcuts'));
  };

  const shortcutCategories = ['全部', ...new Set(shortcuts.map((item) => item.category || '默认'))];
  const filteredShortcuts = shortcuts.filter((item) => shortcutCategory === '全部' || (item.category || '默认') === shortcutCategory);
  const totalShortcutPages = Math.max(1, Math.ceil(filteredShortcuts.length / shortcutPageSize));
  const safeShortcutPage = Math.min(shortcutPage, totalShortcutPages);
  const pagedShortcuts = filteredShortcuts.slice((safeShortcutPage - 1) * shortcutPageSize, safeShortcutPage * shortcutPageSize);

  const refreshLogs = async () => {
    setLogs(await authedRequest('/api/network/logs?limit=50'));
  };

  const filteredLogs = logs.filter((row) => {
    const toolMatched = logTool === 'all' || row.tool === logTool;
    const keyword = logQuery.trim().toLowerCase();
    if (!keyword) return toolMatched;
    return toolMatched && [row.operator, row.tool, row.message, row.target, row.detail]
      .some((value) => String(value || '').toLowerCase().includes(keyword));
  });
  const logTools = ['all', ...new Set(logs.map((row) => row.tool).filter(Boolean))];

  const refreshUsers = async () => {
    if (user?.role !== 'admin') return;
    setUsers(await authedRequest('/api/users'));
  };

  const upsertPreset = (protocol, values) => {
    const selectedId = presetSelections[protocol] || '';
    const selected = hostPresets.find((item) => item.id === selectedId && item.protocol === protocol);
    const defaultName = selected?.name || '';
    const name = window.prompt('常用主机名称', defaultName);
    if (!name?.trim()) return;
    setHostPresets((prev) => {
      const next = prev.filter((item) => item.id !== selectedId);
      return [
        ...next,
        {
          id: selectedId || makePresetId(),
          protocol,
          name: name.trim(),
          values: { ...(values || {}) },
          createdAt: selected?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];
    });
    setPresetSelections((prev) => ({ ...prev, [protocol]: selectedId || '' }));
  };

  const removePreset = (protocol) => {
    const selectedId = presetSelections[protocol] || '';
    if (!selectedId) return;
    const preset = hostPresets.find((item) => item.id === selectedId && item.protocol === protocol);
    if (!preset) return;
    if (!window.confirm(`删除常用主机 ${preset.name} ?`)) return;
    setHostPresets((prev) => prev.filter((item) => item.id !== selectedId));
    setPresetSelections((prev) => ({ ...prev, [protocol]: '' }));
  };

  const applyPreset = (protocol, id) => {
    if (!id) {
      setPresetSelections((prev) => ({ ...prev, [protocol]: '' }));
      return;
    }
    setPresetSelections((prev) => ({ ...prev, [protocol]: id }));
    const preset = hostPresets.find((item) => item.id === id && item.protocol === protocol);
    if (!preset) return;
    const values = preset.values || {};
    if (protocol === 'ftp') setFtpLogin((current) => ({ ...current, ...values }));
    if (protocol === 'sftp') setSftpLogin((current) => ({ ...current, ...values }));
    if (protocol === 'vnc') setVncForm((current) => ({ ...current, ...values }));
    if (protocol === 'ssh') setSshForm((current) => ({ ...current, ...values }));
    if (protocol === 'rdp') setRdpForm((current) => ({ ...current, ...values }));
    if (protocol === 'network') {
      if (values.target !== undefined) setPingForm((current) => ({ ...current, target: values.target }));
      if (values.port !== undefined) setPortForm((current) => ({ ...current, host: values.target || values.host || current.host, port: values.port }));
    }
  };

  useEffect(() => {
    saveHostPresets(hostPresets);
  }, [hostPresets]);

  useEffect(() => {
    localStorage.setItem(SHORTCUT_CATEGORY_KEY, shortcutCategory);
  }, [shortcutCategory]);

  useEffect(() => {
    if (!token || !user) return undefined;

    const timeoutMs = 15 * 60 * 1000;
    let timer = null;

    const schedule = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        pushNotice('由于 15 分钟未操作，已自动退出');
        handleLogout();
      }, timeoutMs);
    };

    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'pointerdown'];
    const onActivity = () => schedule();

    events.forEach((eventName) => window.addEventListener(eventName, onActivity, { passive: true }));
    schedule();

    return () => {
      if (timer) window.clearTimeout(timer);
      events.forEach((eventName) => window.removeEventListener(eventName, onActivity));
    };
  }, [token, user]);

  useEffect(() => () => {
    for (const timer of noticeTimersRef.current.values()) {
      clearTimeout(timer);
    }
    noticeTimersRef.current.clear();
  }, []);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const me = await authedRequest('/api/auth/me');
        setUser(me);
        await Promise.all([refreshShortcuts(), refreshLogs(), ...(me.role === 'admin' ? [refreshUsers()] : [])]);
      } catch (e) {
        clearAuth();
        setToken('');
        setUser(null);
        pushNotice(e instanceof Error ? e.message : '会话失效，请重新登录');
      }
    })();
  }, [token]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setVncExpanded(false);
        setSshExpanded(false);
        setRdpExpanded(false);
        setAboutOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const onOpenAbout = () => setAboutOpen(true);
    window.addEventListener('opsjump:open-about', onOpenAbout);
    return () => window.removeEventListener('opsjump:open-about', onOpenAbout);
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setNotices([]);
    try {
      const data = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      saveAuth(data.token, data.user);
      setToken(data.token);
      setUser(data.user);
      const [shortcutData, logData] = await Promise.all([
        apiRequest('/api/shortcuts', { token: data.token }),
        apiRequest('/api/network/logs?limit=50', { token: data.token }),
      ]);
      setShortcuts(shortcutData);
      setLogs(logData);
      setShortcutPage(1);
      if (data.user?.role === 'admin') {
        setUsers(await apiRequest('/api/users', { token: data.token }));
      }
    } catch (e) {
      pushNotice(e instanceof Error ? e.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    clearAuth();
    setToken('');
    setUser(null);
    setUsername('');
    setPassword('');
    setShortcuts([]);
    setLogs([]);
    setShortcutPage(1);
    setVncSessionId('');
    setVncStatus('未连接');
    setVncExpanded(false);
    setVncForm(emptyVnc);
    setSshSessionId('');
    setSshStatus('未连接');
    setSshExpanded(false);
    setSshForm(emptySsh);
    setRdpSessionId('');
    setRdpStatus('未连接');
    setRdpExpanded(false);
    setRdpForm(emptyRdp);
    setFtpLogin(emptyLogin);
    setSftpLogin({ host: '', port: 22, username: '', password: '' });
    setPingLines([]);
    setPingStatus('未开始');
    setTab('shortcuts');
  };

  const openCreateUser = () => {
    setEditingUser(null);
    setUserForm({ username: '', realName: '', password: '', role: 'user', status: 'active' });
    setUserModalOpen(true);
  };

  const openEditUser = (item) => {
    setEditingUser(item);
    setUserForm({
      username: item.username,
      realName: item.realName,
      password: '',
      role: item.role,
      status: item.status,
    });
    setUserModalOpen(true);
  };

  const saveUser = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        username: userForm.username,
        realName: userForm.realName,
        password: userForm.password,
        role: userForm.role,
        status: userForm.status,
      };
      if (editingUser) {
        await authedRequest(`/api/users/${editingUser.id}`, { method: 'PUT', body: payload });
      } else {
        await authedRequest('/api/users', { method: 'POST', body: payload });
      }
      setUserModalOpen(false);
      await refreshUsers();
      await refreshLogs();
    } catch (error) {
      pushNotice(error instanceof Error ? error.message : '用户保存失败');
    }
  };

  const toggleUserStatus = async (item) => {
    try {
      await authedRequest(`/api/users/${item.id}/status`, { method: 'PUT', body: { status: item.status === 'active' ? 'disabled' : 'active' } });
      await refreshUsers();
      await refreshLogs();
    } catch (error) {
      pushNotice(error instanceof Error ? error.message : '状态更新失败');
    }
  };

  const openResetPassword = (item) => {
    setPasswordTarget(item);
    setPasswordForm({ oldPassword: '', newPassword: '' });
    setPasswordModalOpen(true);
  };

  const savePassword = async (e) => {
    e.preventDefault();
    try {
      if (passwordTarget?.id === user.id) {
        await authedRequest('/api/auth/password', { method: 'PUT', body: passwordForm });
      } else {
        await authedRequest(`/api/users/${passwordTarget.id}/password`, { method: 'PUT', body: { password: passwordForm.newPassword } });
      }
      setPasswordModalOpen(false);
      await refreshUsers();
      await refreshLogs();
    } catch (error) {
      pushNotice(error instanceof Error ? error.message : '密码修改失败');
    }
  };

  const openCreateShortcut = () => {
    setEditingShortcut(null);
    setShortcutForm({ ...emptyShortcut, category: '默认' });
    setShortcutModal(true);
  };

  const openEditShortcut = (item) => {
    setEditingShortcut(item);
    setShortcutForm({
      title: item.title,
      url: item.url,
      icon: item.icon || '',
      color: item.color || '#2563eb',
      category: item.category || '默认',
      sortOrder: item.sort_order ?? 0,
    });
    setShortcutModal(true);
  };

  const saveShortcut = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        title: shortcutForm.title,
        url: shortcutForm.url,
        icon: shortcutForm.icon,
        color: shortcutForm.color,
        category: shortcutForm.category || '默认',
        sortOrder: Number(shortcutForm.sortOrder) || 0,
      };
      if (editingShortcut) {
        await authedRequest(`/api/shortcuts/${editingShortcut.id}`, { method: 'PUT', body: payload });
      } else {
        await authedRequest('/api/shortcuts', { method: 'POST', body: payload });
      }
      setShortcutModal(false);
      await refreshShortcuts();
    } catch (e) {
      pushNotice(e instanceof Error ? e.message : '保存失败');
    }
  };

  const deleteShortcut = async (id) => {
    try {
      if (!window.confirm('确定删除这个快捷按钮吗？')) return;
      await authedRequest(`/api/shortcuts/${id}`, { method: 'DELETE' });
      await refreshShortcuts();
    } catch (e) {
      pushNotice(e instanceof Error ? e.message : '删除失败');
    }
  };

  const connectFtp = async (nextLogin = ftpLogin, nextPath = '/') => {
    const data = await authedRequest('/api/remote/ftp/list', {
      method: 'POST',
      body: { ...nextLogin, remotePath: nextPath },
    });
    setFtpItems(data.items || []);
    setFtpPath(nextPath || '/');
    setFtpConnected(true);
    setFtpStatus(data.message || 'FTP 登录成功');
  };

  const disconnectFtp = () => {
    setFtpConnected(false);
    setFtpItems([]);
    setFtpPath('/');
    setFtpStatus('已断开连接');
    setFtpLogin((current) => ({ ...current, password: '' }));
  };

  const connectSftp = async (nextLogin = sftpLogin, nextPath = '/') => {
    const data = await authedRequest('/api/remote/sftp/list', {
      method: 'POST',
      body: { ...nextLogin, remotePath: nextPath },
    });
    setSftpItems(data.items || []);
    setSftpPath(nextPath || '/');
    setSftpConnected(true);
    setSftpStatus(data.message || 'SFTP 登录成功');
  };

  const disconnectSftp = () => {
    setSftpConnected(false);
    setSftpItems([]);
    setSftpPath('/');
    setSftpStatus('已断开连接');
    setSftpLogin((current) => ({ ...current, password: '' }));
  };

  const runFtp = async (e) => {
    e.preventDefault();
    try {
      await connectFtp(ftpLogin, '/');
      await refreshLogs();
    } catch (e2) {
      setFtpConnected(false);
      setFtpStatus('登录失败');
      pushNotice(e2 instanceof Error ? e2.message : 'FTP 登录失败');
    }
  };

  const runSftp = async (e) => {
    e.preventDefault();
    try {
      await connectSftp(sftpLogin, '/');
      await refreshLogs();
    } catch (e2) {
      setSftpConnected(false);
      setSftpStatus('登录失败');
      pushNotice(e2 instanceof Error ? e2.message : 'SFTP 登录失败');
    }
  };

  const ftpNavigate = async (item) => connectFtp(ftpLogin, ftpPath === '/' ? `/${item.name}` : `${ftpPath}/${item.name}`);
  const sftpNavigate = async (item) => connectSftp(sftpLogin, sftpPath === '/' ? `/${item.name}` : `${sftpPath}/${item.name}`);

  const ftpDownload = async (item) => {
    const data = await authedRequest('/api/remote/ftp/download', {
      method: 'POST',
      body: { ...ftpLogin, remotePath: joinPath(ftpPath, item.name) },
    });
    const bytes = Uint8Array.from(atob(data.contentBase64), (ch) => ch.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes]));
    const a = document.createElement('a');
    a.href = url;
    a.download = data.fileName || item.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const sftpDownload = async (item) => {
    const data = await authedRequest('/api/remote/sftp/download', {
      method: 'POST',
      body: { ...sftpLogin, remotePath: joinPath(sftpPath, item.name) },
    });
    const bytes = Uint8Array.from(atob(data.contentBase64), (ch) => ch.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes]));
    const a = document.createElement('a');
    a.href = url;
    a.download = data.fileName || item.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const ftpDelete = async (item) => {
    if (!window.confirm(`删除 ${item.name} ?`)) return;
    await authedRequest('/api/remote/ftp/delete', {
      method: 'POST',
      body: { ...ftpLogin, remotePath: joinPath(ftpPath, item.name) },
    });
    await connectFtp(ftpLogin, ftpPath);
    await refreshLogs();
  };

  const sftpDelete = async (item) => {
    if (!window.confirm(`删除 ${item.name} ?`)) return;
    await authedRequest('/api/remote/sftp/delete', {
      method: 'POST',
      body: { ...sftpLogin, remotePath: joinPath(sftpPath, item.name) },
    });
    await connectSftp(sftpLogin, sftpPath);
    await refreshLogs();
  };

  const uploadToRemote = async (type, file) => {
    const contentBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });
    if (type === 'ftp') {
      await authedRequest('/api/remote/ftp/upload', {
        method: 'POST',
        body: { ...ftpLogin, remotePath: ftpPath || '/', fileName: file.name, contentBase64 },
      });
      await connectFtp(ftpLogin, ftpPath);
    } else {
      await authedRequest('/api/remote/sftp/upload', {
        method: 'POST',
        body: { ...sftpLogin, remotePath: sftpPath || '/', fileName: file.name, contentBase64 },
      });
      await connectSftp(sftpLogin, sftpPath);
    }
    await refreshLogs();
  };

  const pingStream = async () => {
    if (!pingForm.target.trim()) return;
    if (pingAbortRef.current) pingAbortRef.current.abort();
    const controller = new AbortController();
    pingAbortRef.current = controller;
    setPingLines([]);
    setPingStatus('连接中...');
    try {
      const response = await fetch(`/api/network/ping/stream?target=${encodeURIComponent(pingForm.target.trim())}&count=${Number(pingForm.count) || 0}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error('ping 流启动失败');
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      setPingStatus('运行中');
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';
        for (const chunk of chunks) {
          const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          const payload = JSON.parse(dataLine.slice(6));
          if (payload.address || payload.line || payload.ok !== undefined) {
            setPingLines((prev) => [...prev, payload]);
          }
        }
      }
      setPingStatus('已结束');
    } catch (e) {
      if (e.name !== 'AbortError') setPingStatus(e instanceof Error ? e.message : 'ping 失败');
    } finally {
      pingAbortRef.current = null;
    }
  };

  const stopPing = () => {
    pingAbortRef.current?.abort();
    pingAbortRef.current = null;
    setPingStatus('已停止');
  };

  const runPortCheck = async (e) => {
    e.preventDefault();
    try {
      const data = await authedRequest('/api/network/port-check', { method: 'POST', body: portForm });
      setPortResult({ ...data, checkedAt: new Date().toISOString() });
    } catch (e2) {
      pushNotice(e2 instanceof Error ? e2.message : '端口检测失败');
    }
  };

  const connectVnc = async (e) => {
    e.preventDefault();
    try {
      setVncStatus('正在创建连接...');
      const data = await authedRequest('/api/remote/vnc/session', { method: 'POST', body: { host: vncForm.host, port: vncForm.port } });
      setVncSessionId(data.sessionId);
      setVncStatus('等待连接');
      await refreshLogs();
    } catch (e2) {
      setVncStatus('连接失败');
      pushNotice(e2 instanceof Error ? e2.message : 'VNC 连接失败');
    }
  };

  const disconnectVnc = () => {
    setVncSessionId('');
    setVncStatus('已断开连接');
    setVncExpanded(false);
    setVncForm((current) => ({ ...current, password: '' }));
  };

  const connectRdp = async (e) => {
    e.preventDefault();
    try {
      setRdpStatus('正在创建连接...');
      const data = await authedRequest('/api/remote/rdp/session', {
        method: 'POST',
        body: {
          host: rdpForm.host,
          port: rdpForm.port,
          domain: rdpForm.domain,
          username: rdpForm.username,
          password: rdpForm.password,
        },
      });
      setRdpSessionId(data.sessionId);
      setRdpConnectionToken(data.token || '');
      setRdpStatus('等待连接');
      await refreshLogs();
    } catch (e2) {
      setRdpStatus('连接失败');
      pushNotice(e2 instanceof Error ? e2.message : 'RDP 连接失败');
    }
  };

  const disconnectRdp = () => {
    setRdpSessionId('');
    setRdpConnectionToken('');
    setRdpStatus('已断开连接');
    setRdpExpanded(false);
    setRdpForm((current) => ({ ...current, password: '' }));
  };

  const ftpPresets = groupPresets(hostPresets, 'ftp');
  const sftpPresets = groupPresets(hostPresets, 'sftp');
  const vncPresets = groupPresets(hostPresets, 'vnc');
  const sshPresets = groupPresets(hostPresets, 'ssh');
  const rdpPresets = groupPresets(hostPresets, 'rdp');
  const networkPresets = groupPresets(hostPresets, 'network');

  const connectSsh = async (e) => {
    e.preventDefault();
    try {
      setSshStatus('正在创建连接...');
      let data;
      try {
        data = await authedRequest('/api/remote/ssh/session', {
          method: 'POST',
          body: {
            host: sshForm.host,
            port: sshForm.port,
            username: sshForm.username,
            password: sshForm.password,
          },
        });
      } catch (firstError) {
        const message = firstError instanceof Error ? firstError.message : '';
        if (!/404/.test(message)) throw firstError;
        data = await authedRequest('/api/ssh/session', {
          method: 'POST',
          body: {
            host: sshForm.host,
            port: sshForm.port,
            username: sshForm.username,
            password: sshForm.password,
          },
        });
      }
      setSshSessionId(data.sessionId);
      setSshStatus('等待连接');
      await refreshLogs();
    } catch (e2) {
      setSshStatus('连接失败');
      pushNotice(e2 instanceof Error ? e2.message : 'SSH 连接失败');
    }
  };

  const disconnectSsh = () => {
    setSshSessionId('');
    setSshStatus('已断开连接');
    setSshExpanded(false);
    setSshForm((current) => ({ ...current, password: '' }));
  };

  if (!token || !user) {
    return (
      <div className="login-shell">
        <form className="login-card" onSubmit={handleLogin}>
          <div className="brand">OpsJump</div>
          <h1>快捷访问与运维入口</h1>
          <p>请输入用户名和密码登录</p>
          <label>
            用户名
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label>
            密码
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button type="submit" disabled={loading}>{loading ? '登录中...' : '登录'}</button>
        </form>
      </div>
    );
  }

  return (
    <div className={vncExpanded || sshExpanded || rdpExpanded ? 'app-shell remote-expanded' : 'app-shell'}>
      <aside className="sidebar">
        <div>
          <div className="brand large">OpsJump</div>
          <button className={tab === 'shortcuts' ? 'nav active' : 'nav'} onClick={() => setTab('shortcuts')}>快捷访问</button>
          <button className={tab === 'remote' ? 'nav active' : 'nav'} onClick={() => setTab('remote')}>FTP / SFTP</button>
          <button className={tab === 'vnc' ? 'nav active' : 'nav'} onClick={() => setTab('vnc')}>VNC</button>
          <button className={tab === 'ssh' ? 'nav active' : 'nav'} onClick={() => setTab('ssh')}>SSH</button>
          <button className={tab === 'rdp' ? 'nav active' : 'nav'} onClick={() => setTab('rdp')}>Windows 桌面</button>
          <button className={tab === 'network' ? 'nav active' : 'nav'} onClick={() => setTab('network')}>网络检测</button>
          <button className={tab === 'logs' ? 'nav active' : 'nav'} onClick={() => setTab('logs')}>操作日志</button>
          {user?.role === 'admin' ? <button className={tab === 'users' ? 'nav active' : 'nav'} onClick={() => setTab('users')}>用户管理</button> : null}
        </div>
        <div className="user-box">
          <div>{user.realName || user.username}</div>
          <small>{user.role}</small>
          <button className="ghost full" type="button" onClick={() => setAboutOpen(true)}>关于</button>
          <button className="ghost full" onClick={() => openResetPassword(user)}>修改密码</button>
          <button className="ghost full" onClick={handleLogout}>退出登录</button>
        </div>
      </aside>

      <main className="content">
        <TabBar tab={tab} setTab={setTab} user={user} onAbout={() => setAboutOpen(true)} />
        <header className="topbar">
          <div>
            <h1>{tab === 'shortcuts' ? '快捷访问' : tab === 'remote' ? 'FTP / SFTP' : tab === 'vnc' ? 'VNC' : tab === 'ssh' ? 'SSH' : tab === 'rdp' ? 'Windows 桌面' : tab === 'network' ? '网络检测' : tab === 'users' ? '用户管理' : '操作日志'}</h1>
            <p>登录、操作、远程连接和实时检测都在这里。</p>
          </div>
        </header>

        {notices.length ? (
          <div className="notice-stack" role="status" aria-live="polite">
            {notices.map((notice) => (
              <div key={notice.id} className={`notice ${notice.kind}`}>
                <span>{notice.message}</span>
                <button type="button" className="ghost notice-close" onClick={() => dismissNotice(notice.id)}>关闭</button>
              </div>
            ))}
          </div>
        ) : null}

        {tab === 'shortcuts' ? (
          <Card title="快捷按钮" subtitle="点击即可打开目标；支持分类和翻页。" action={<button onClick={openCreateShortcut}>新增按钮</button>}>
            <div className="shortcut-toolbar">
              <div className="shortcut-categories">
                {shortcutCategories.map((category) => (
                  <button key={category} type="button" className={shortcutCategory === category ? 'ghost active' : 'ghost'} onClick={() => { setShortcutCategory(category); setShortcutPage(1); }}>
                    {category}
                  </button>
                ))}
              </div>
            </div>
            <div className="shortcut-grid compact">
              {pagedShortcuts.map((item) => (
                <div key={item.id} className="shortcut-card compact">
                  <button className="shortcut-open compact" type="button" style={{ background: item.color || '#2563eb' }} onClick={() => window.open(item.url, '_blank', 'noopener,noreferrer')}>
                    <span>{item.icon || item.title.slice(0, 1)}</span>
                  </button>
                  <div className="shortcut-info compact">
                    <strong>{item.title}</strong>
                    <small>{item.url}</small>
                    <small className="shortcut-category-text">{item.category || '默认'}</small>
                  </div>
                  <div className="shortcut-actions compact">
                    <button className="ghost" onClick={() => openEditShortcut(item)}>编辑</button>
                    <button className="ghost danger" onClick={() => deleteShortcut(item.id)}>删除</button>
                  </div>
                </div>
              ))}
            </div>
            {totalShortcutPages > 1 ? (
              <div className="pagination">
                <button className="ghost" type="button" onClick={() => setShortcutPage((v) => Math.max(1, v - 1))} disabled={safeShortcutPage <= 1}>上一页</button>
                <span>第 {safeShortcutPage} / {totalShortcutPages} 页</span>
                <button className="ghost" type="button" onClick={() => setShortcutPage((v) => Math.min(totalShortcutPages, v + 1))} disabled={safeShortcutPage >= totalShortcutPages}>下一页</button>
              </div>
            ) : null}
          </Card>
        ) : null}

        {tab === 'remote' ? (
          <div className="stack">
            <RemotePanel
              label="FTP"
              presetProtocol="ftp"
              presets={ftpPresets}
              loginApi="/api/remote/ftp/list"
              listApi="/api/remote/ftp/list"
              downloadApi="/api/remote/ftp/download"
              uploadApi="/api/remote/ftp/upload"
              deleteApi="/api/remote/ftp/delete"
              login={ftpLogin}
              setLogin={setFtpLogin}
              connected={ftpConnected}
              setConnected={setFtpConnected}
              currentPath={ftpPath}
              setCurrentPath={setFtpPath}
              items={ftpItems}
              setItems={setFtpItems}
              status={ftpStatus}
              setStatus={setFtpStatus}
              token={token}
              refreshLogs={refreshLogs}
              onDisconnect={disconnectFtp}
              onSavePreset={upsertPreset}
              onApplyPreset={applyPreset}
              onDeletePreset={removePreset}
              selectedId={presetSelections.ftp}
            />

            <div className="card quick-hint">
              <div className="card-header"><div><h2>SFTP</h2><p>与 FTP 一样，登录后可直接浏览、上传和下载。</p></div></div>
              <RemotePanel
                label="SFTP"
                presetProtocol="sftp"
                presets={sftpPresets}
                loginApi="/api/remote/sftp/list"
                listApi="/api/remote/sftp/list"
                downloadApi="/api/remote/sftp/download"
                uploadApi="/api/remote/sftp/upload"
                deleteApi="/api/remote/sftp/delete"
                login={sftpLogin}
                setLogin={setSftpLogin}
                connected={sftpConnected}
                setConnected={setSftpConnected}
                currentPath={sftpPath}
                setCurrentPath={setSftpPath}
                items={sftpItems}
                setItems={setSftpItems}
                status={sftpStatus}
                setStatus={setSftpStatus}
                token={token}
                refreshLogs={refreshLogs}
                onDisconnect={disconnectSftp}
                onSavePreset={upsertPreset}
                onApplyPreset={applyPreset}
                onDeletePreset={removePreset}
                selectedId={presetSelections.sftp}
              />
            </div>
          </div>
        ) : null}

        {tab === 'vnc' ? (
          <Card
            title="VNC"
            subtitle="输入地址、端口和密码后连接。支持全屏/放大查看。"
            action={(
              <div className="remote-actions sticky">
                <button className="ghost" type="button" onClick={() => setVncExpanded((v) => !v)}>{vncExpanded ? '退出全屏' : '全屏'}</button>
                <button className="ghost danger" type="button" onClick={disconnectVnc} disabled={!vncSessionId}>断开连接</button>
              </div>
            )}
          >
            <PresetBar
              protocol="vnc"
              presets={vncPresets}
              selectedId={presetSelections.vnc}
              onApply={(id) => applyPreset('vnc', id)}
              onSave={() => upsertPreset('vnc', vncForm)}
              onDelete={() => removePreset('vnc')}
            />
            <form className="grid-form" onSubmit={connectVnc}>
              <input placeholder="VNC 地址" value={vncForm.host} onChange={(e) => setVncForm({ ...vncForm, host: e.target.value })} />
              <input type="number" placeholder="端口" value={vncForm.port} onChange={(e) => setVncForm({ ...vncForm, port: e.target.value })} />
              <input type="password" placeholder="VNC 密码" value={vncForm.password} onChange={(e) => setVncForm({ ...vncForm, password: e.target.value })} />
              <span />
              <span />
              <button type="submit">连接 VNC</button>
            </form>
            <div className="status-line">状态: {vncStatus}</div>
            <div className="gesture-hint">移动端提示：进入全屏后使用右上角工具条退出；远程桌面内可单指点击、拖动，必要时横屏使用。</div>
            {vncSessionId ? (
              <div className={vncExpanded ? 'vnc-host fullscreen' : 'vnc-host'}>
                {vncExpanded ? (
                  <FullscreenToolbar label="VNC" status={vncStatus} onExit={() => setVncExpanded(false)} onDisconnect={disconnectVnc} />
                ) : null}
                <Suspense fallback={<div className="empty-hint">正在加载 VNC 组件...</div>}>
                  <VncViewer
                    key={vncSessionId}
                    sessionId={vncSessionId}
                    password={vncForm.password}
                    onStatus={setVncStatus}
                    expanded={vncExpanded}
                  />
                </Suspense>
              </div>
            ) : (
              <div className="empty-hint">连接后这里会显示远程桌面。</div>
            )}
          </Card>
        ) : null}

        {tab === 'ssh' ? (
          <Card
            title="SSH"
            subtitle="输入主机、端口和账号后进入交互式终端。"
            action={(
              <div className="remote-actions sticky">
                <button className="ghost" type="button" onClick={() => setSshExpanded((v) => !v)}>{sshExpanded ? '退出全屏' : '全屏'}</button>
                <button className="ghost danger" type="button" onClick={disconnectSsh} disabled={!sshSessionId}>断开连接</button>
              </div>
            )}
          >
            <PresetBar
              protocol="ssh"
              presets={sshPresets}
              selectedId={presetSelections.ssh}
              onApply={(id) => applyPreset('ssh', id)}
              onSave={() => upsertPreset('ssh', sshForm)}
              onDelete={() => removePreset('ssh')}
            />
            <form className="grid-form" onSubmit={connectSsh}>
              <input placeholder="SSH 地址" value={sshForm.host} onChange={(e) => setSshForm({ ...sshForm, host: e.target.value })} />
              <input type="number" placeholder="端口" value={sshForm.port} onChange={(e) => setSshForm({ ...sshForm, port: e.target.value })} />
              <input placeholder="用户名" value={sshForm.username} onChange={(e) => setSshForm({ ...sshForm, username: e.target.value })} />
              <input type="password" placeholder="密码" value={sshForm.password} onChange={(e) => setSshForm({ ...sshForm, password: e.target.value })} />
              <span />
              <button type="submit">连接 SSH</button>
            </form>
            <div className="status-line">状态: {sshStatus}</div>
            <div className="gesture-hint">移动端提示：进入全屏后右上角可退出；键盘由系统输入法控制，建议横屏操作。</div>
            {sshSessionId ? (
              <div className={sshExpanded ? 'ssh-host fullscreen' : 'ssh-host'}>
                {sshExpanded ? (
                  <FullscreenToolbar label="SSH" status={sshStatus} onExit={() => setSshExpanded(false)} onDisconnect={disconnectSsh} />
                ) : null}
                <Suspense fallback={<div className="empty-hint">正在加载 SSH 终端...</div>}>
                  <SshTerminal
                    key={sshSessionId}
                    sessionId={sshSessionId}
                    onStatus={setSshStatus}
                    expanded={sshExpanded}
                  />
                </Suspense>
              </div>
            ) : (
              <div className="empty-hint">连接后这里会显示 SSH 终端。</div>
            )}
          </Card>
        ) : null}

        {tab === 'rdp' ? (
          <Card
            title="Windows 桌面"
            subtitle="输入主机、端口和账号后连接远程 Windows 桌面。"
            action={(
              <div className="remote-actions sticky">
                <button className="ghost" type="button" onClick={() => setRdpExpanded((v) => !v)}>{rdpExpanded ? '退出全屏' : '全屏'}</button>
                <button className="ghost danger" type="button" onClick={disconnectRdp} disabled={!rdpSessionId}>断开连接</button>
              </div>
            )}
          >
            <PresetBar
              protocol="rdp"
              presets={rdpPresets}
              selectedId={presetSelections.rdp}
              onApply={(id) => applyPreset('rdp', id)}
              onSave={() => upsertPreset('rdp', rdpForm)}
              onDelete={() => removePreset('rdp')}
            />
            <form className="grid-form" onSubmit={connectRdp}>
              <input placeholder="RDP 地址" value={rdpForm.host} onChange={(e) => setRdpForm({ ...rdpForm, host: e.target.value })} />
              <input type="number" placeholder="端口" value={rdpForm.port} onChange={(e) => setRdpForm({ ...rdpForm, port: e.target.value })} />
              <input placeholder="域（可选）" value={rdpForm.domain} onChange={(e) => setRdpForm({ ...rdpForm, domain: e.target.value })} />
              <input placeholder="用户名" value={rdpForm.username} onChange={(e) => setRdpForm({ ...rdpForm, username: e.target.value })} />
              <input type="password" placeholder="密码" value={rdpForm.password} onChange={(e) => setRdpForm({ ...rdpForm, password: e.target.value })} />
              <span />
              <button type="submit">连接 Windows 桌面</button>
            </form>
            <div className="status-line">状态: {rdpStatus}</div>
            <div className="gesture-hint">移动端提示：进入全屏后右上角可退出；单指点击/拖动，横屏视野更好。</div>
            {rdpSessionId ? (
              <div className={rdpExpanded ? 'rdp-host fullscreen' : 'rdp-host'}>
                {rdpExpanded ? (
                  <FullscreenToolbar label="Windows 桌面" status={rdpStatus} onExit={() => setRdpExpanded(false)} onDisconnect={disconnectRdp} />
                ) : null}
                <Suspense fallback={<div className="empty-hint">正在加载 Windows 桌面组件...</div>}>
                  <RdpViewer
                    key={rdpSessionId}
                    sessionId={rdpSessionId}
                    connectionToken={rdpConnectionToken}
                    onStatus={setRdpStatus}
                    expanded={rdpExpanded}
                  />
                </Suspense>
              </div>
            ) : (
              <div className="empty-hint">连接后这里会显示 Windows 桌面。</div>
            )}
          </Card>
        ) : null}

        {tab === 'network' ? (
          <div className="stack">
            <Card title="实时 Ping" subtitle="次数为 0 时持续运行；设置次数时按指定次数实时输出。" action={(
              <div className="remote-actions sticky">
                <button className="ghost" type="button" onClick={pingStream}>开始 Ping</button>
                <button className="ghost danger" type="button" onClick={stopPing}>停止</button>
              </div>
            )}>
              <PresetBar
                protocol="network"
                presets={networkPresets}
                selectedId={presetSelections.network}
                onApply={(id) => applyPreset('network', id)}
                onSave={() => upsertPreset('network', { target: pingForm.target, host: portForm.host, port: portForm.port })}
                onDelete={() => removePreset('network')}
              />
              <form className="grid-form" onSubmit={(e) => { e.preventDefault(); pingStream(); }}>
                <input placeholder="目标地址" value={pingForm.target} onChange={(e) => setPingForm({ ...pingForm, target: e.target.value })} />
                <input type="number" placeholder="次数，0=持续" value={pingForm.count} onChange={(e) => setPingForm({ ...pingForm, count: e.target.value })} />
                <span />
                <button type="submit">开始 Ping</button>
              </form>
              <div className="status-line">状态: {pingStatus}</div>
              <div className="ping-stream">
                {pingLines.map((line, index) => (
                  <div key={`${line.timestamp}-${index}`} className="ping-line">
                    <span className="ping-time">[{line.timestamp}]</span>
                    <span>{formatPingEvent(line)}</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card title="端口检测" subtitle="结果会在检测界面下方提示。">
              <form className="grid-form" onSubmit={runPortCheck}>
                <input placeholder="主机" value={portForm.host} onChange={(e) => setPortForm({ ...portForm, host: e.target.value })} />
                <input type="number" placeholder="端口" value={portForm.port} onChange={(e) => setPortForm({ ...portForm, port: e.target.value })} />
                <span />
                <button type="submit">检测端口</button>
              </form>
              {portResult ? <div className="result-inline">[{portResult.checkedAt}] {portResult.ok ? '成功' : '失败'}: {portResult.message}</div> : null}
            </Card>
          </div>
        ) : null}

        {tab === 'logs' ? (
          <Card title="操作日志" subtitle="只记录登录和用户操作，不记录 ping/端口检测。">
            <div className="log-toolbar">
              <input placeholder="搜索用户、动作、目标或详情" value={logQuery} onChange={(e) => setLogQuery(e.target.value)} />
              <select value={logTool} onChange={(e) => setLogTool(e.target.value)}>
                {logTools.map((tool) => <option key={tool} value={tool}>{tool === 'all' ? '全部类型' : tool}</option>)}
              </select>
              <button className="ghost" type="button" onClick={refreshLogs}>刷新</button>
            </div>
            <div className="log-list">
              {filteredLogs.map((row) => (
                <article key={row.id} className="log-item">
                  <strong>{row.message}</strong>
                  <small>{formatTime(row.created_at)} · {row.operator || 'system'} · {row.tool}</small>
                  <span>{row.target}</span>
                  <small>{row.detail}</small>
                </article>
              ))}
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>操作用户</th>
                    <th>类型</th>
                    <th>动作</th>
                    <th>目标</th>
                    <th>详情</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLogs.map((row) => (
                    <tr key={row.id}>
                      <td>{formatTime(row.created_at)}</td>
                      <td>{row.operator || 'system'}</td>
                      <td>{row.tool}</td>
                      <td>{row.message}</td>
                      <td>{row.target}</td>
                      <td>{row.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}

        {tab === 'users' && user?.role === 'admin' ? (
          <Card title="用户管理" subtitle="管理员可新增、编辑、启用/禁用用户和重置密码" action={<button onClick={openCreateUser}>新增用户</button>}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>用户名</th>
                    <th>姓名</th>
                    <th>角色</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((item) => (
                    <tr key={item.id}>
                      <td>{item.username}</td>
                      <td>{item.realName}</td>
                      <td>{item.role}</td>
                      <td>{item.status}</td>
                      <td>
                        <div className="row-actions">
                          <button className="ghost" onClick={() => openEditUser(item)}>编辑</button>
                          <button className="ghost" onClick={() => toggleUserStatus(item)}>{item.status === 'active' ? '禁用' : '启用'}</button>
                          <button className="ghost" onClick={() => openResetPassword(item)}>重置密码</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}
      </main>

      {shortcutModal ? (
        <Modal title={editingShortcut ? '编辑快捷按钮' : '新增快捷按钮'} onClose={() => setShortcutModal(false)}>
          <form className="modal-form" onSubmit={saveShortcut}>
            <label>名称<input value={shortcutForm.title} onChange={(e) => setShortcutForm({ ...shortcutForm, title: e.target.value })} /></label>
            <label>地址<input value={shortcutForm.url} onChange={(e) => setShortcutForm({ ...shortcutForm, url: e.target.value })} /></label>
            <label>图标文本<input value={shortcutForm.icon} onChange={(e) => setShortcutForm({ ...shortcutForm, icon: e.target.value })} /></label>
            <label>分类<input value={shortcutForm.category || '默认'} onChange={(e) => setShortcutForm({ ...shortcutForm, category: e.target.value })} /></label>
            <label>按钮颜色<input type="color" value={shortcutForm.color} onChange={(e) => setShortcutForm({ ...shortcutForm, color: e.target.value })} /></label>
            <label>排序<input type="number" value={shortcutForm.sortOrder} onChange={(e) => setShortcutForm({ ...shortcutForm, sortOrder: e.target.value })} /></label>
            <button type="submit">保存</button>
          </form>
        </Modal>
      ) : null}

      {userModalOpen ? (
        <Modal title={editingUser ? '编辑用户' : '新增用户'} onClose={() => setUserModalOpen(false)}>
          <form className="modal-form" onSubmit={saveUser}>
            <label>用户名<input value={userForm.username} onChange={(e) => setUserForm({ ...userForm, username: e.target.value })} disabled={!!editingUser} /></label>
            <label>姓名<input value={userForm.realName} onChange={(e) => setUserForm({ ...userForm, realName: e.target.value })} /></label>
            <label>密码<input type="password" value={userForm.password} onChange={(e) => setUserForm({ ...userForm, password: e.target.value })} placeholder={editingUser ? '不填则不修改' : ''} /></label>
            <label>角色
              <select value={userForm.role} onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}>
                <option value="admin">管理员</option>
                <option value="user">普通用户</option>
              </select>
            </label>
            <label>状态
              <select value={userForm.status} onChange={(e) => setUserForm({ ...userForm, status: e.target.value })}>
                <option value="active">启用</option>
                <option value="disabled">禁用</option>
              </select>
            </label>
            <button type="submit">保存</button>
          </form>
        </Modal>
      ) : null}

      {aboutOpen ? (
        <Modal title="关于 OpsJump" onClose={() => setAboutOpen(false)}>
          <div className="about-card">
            <p><strong>开发者：</strong>qianj</p>
            <p><strong>邮箱：</strong><a href="mailto:fudanwuxi@126.com">fudanwuxi@126.com</a></p>
            <p>
              OpsJump 是一个面向内网运维场景的 Web 门户，提供快捷入口、远程连接、文件传输、网络检测和操作审计等能力。
            </p>
            <p>
              <a href="https://github.com/zhaoxixc/OpsJump" target="_blank" rel="noreferrer">https://github.com/zhaoxixc/OpsJump</a>
            </p>
          </div>
        </Modal>
      ) : null}

      {passwordModalOpen ? (
        <Modal title="修改密码" onClose={() => setPasswordModalOpen(false)}>
          <form className="modal-form" onSubmit={savePassword}>
            {passwordTarget?.id === user.id ? <label>原密码<input type="password" value={passwordForm.oldPassword} onChange={(e) => setPasswordForm({ ...passwordForm, oldPassword: e.target.value })} /></label> : null}
            <label>新密码<input type="password" value={passwordForm.newPassword} onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })} /></label>
            <button type="submit">保存</button>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
