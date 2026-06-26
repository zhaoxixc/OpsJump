import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import initSqlJs from 'sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));

export class Database {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.saveTimer = null;
  }

  async init() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const SQL = await initSqlJs({ locateFile: (file) => path.join(wasmDir, file) });
    if (fs.existsSync(this.dbPath)) {
      this.db = new SQL.Database(fs.readFileSync(this.dbPath));
    } else {
      this.db = new SQL.Database();
    }
    this.db.run(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    this.migrateShortcuts();
    this.migrateNetworkLogs();
    this.seed();
    this.save();
  }

  migrateShortcuts() {
    const columns = new Set(this.all('PRAGMA table_info(shortcuts)').map((row) => row.name));
    if (!columns.has('category')) {
      this.run("ALTER TABLE shortcuts ADD COLUMN category TEXT NOT NULL DEFAULT '默认'");
      this.run("UPDATE shortcuts SET category = '默认' WHERE category IS NULL OR TRIM(category) = ''");
      this.save();
    }
  }

  migrateNetworkLogs() {
    const columns = new Set(this.all('PRAGMA table_info(network_logs)').map((row) => row.name));
    if (!columns.has('operator')) {
      this.run("ALTER TABLE network_logs ADD COLUMN operator TEXT NOT NULL DEFAULT 'system'");
      this.run("UPDATE network_logs SET operator = 'system' WHERE operator IS NULL OR TRIM(operator) = ''");
      this.save();
    }
  }

  seed() {
    const count = this.get('SELECT COUNT(*) AS count FROM users')?.count || 0;
    if (count > 0) return;
    const bcrypt = require('bcryptjs');
    const { v4: uuidv4 } = require('uuid');
    const now = new Date().toISOString();
    this.run(
      'INSERT INTO users (id, username, password, real_name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), 'admin', bcrypt.hashSync('admin123', 10), '系统管理员', 'admin', 'active', now, now]
    );
    const defaults = [
      ['百度', 'https://www.baidu.com', 'B', '#0ea5e9', '常用', 1],
      ['GitHub', 'https://github.com', 'GH', '#111827', '开发', 2],
      ['Cloudflare', 'https://cloudflare.com', 'CF', '#f97316', '网络', 3],
      ['Google', 'https://www.google.com', 'G', '#16a34a', '搜索', 4],
    ];
    for (const [title, url, icon, color, category, sortOrder] of defaults) {
      this.run(
        'INSERT INTO shortcuts (id, title, url, icon, color, category, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [uuidv4(), title, url, icon, color, category, sortOrder, now, now]
      );
    }
    this.save();
  }

  getDb() {
    if (!this.db) throw new Error('Database not initialized');
    return this.db;
  }

  run(sql, params = []) {
    this.getDb().run(sql, params);
  }

  get(sql, params = []) {
    const stmt = this.getDb().prepare(sql);
    stmt.bind(params);
    const row = stmt.step() ? stmt.getAsObject() : undefined;
    stmt.free();
    return row;
  }

  all(sql, params = []) {
    const stmt = this.getDb().prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  save() {
    if (!this.db) return;
    fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()));
  }

  scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.save();
      this.saveTimer = null;
    }, 300);
  }
}
