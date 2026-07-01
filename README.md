# OpsJump

OpsJump 是一个面向内网运维场景的 Web 门户，提供快捷入口、远程连接、文件传输、网络检测和操作审计等常用能力。系统采用 React + Express + SQLite，支持 Docker Compose 一键部署，并通过 Caddy 提供 HTTP/HTTPS 访问入口。

## 初衷

解决IT运维人外出随时需要使用电脑的问题，可以利用手机、平板电脑（ipad mini简直是神器）直接解决大多数场景。
只要能访问浏览器，就能解决ssh、vnc、windows远程桌面、ftp和sftp上传/下载文件、检测网络及端口连通性等日常使用需求。

## 功能概览

- 快捷访问：维护常用系统、平台和工具链接，支持分类、分页、编辑、删除。
- FTP/SFTP：浏览目录、进入目录、返回上级、上传、下载、删除文件。
- 文件传输：FTP/SFTP 上传下载已采用 HTTP 流式传输，不再使用 base64 JSON 传文件。
- VNC：通过 noVNC 连接远程桌面，支持全屏查看。
- SSH：通过浏览器打开交互式终端。
- Windows 桌面：通过 Guacamole/guacd 连接 RDP 桌面，支持全屏查看。
- 网络检测：实时 Ping 和端口检测。
- 操作日志：记录登录、远程连接、文件操作、用户管理等关键操作，并显示操作用户。
- 用户管理：管理员可维护用户、状态和密码。
- 会话安全：15 分钟无操作自动退出；连接断开后清空输入密码。
- HTTPS：内置自签名证书生成，默认用于内网访问。

<img width="1912" height="1034" alt="image" src="https://github.com/user-attachments/assets/0a093331-6500-40f1-bc20-fd68642a8a6a" />

首次部署后请尽快登录并修改默认密码。

## 目录说明

```text
.
├── Caddyfile              # Caddy 反向代理与 HTTPS 配置
├── Dockerfile             # OpsJump 应用镜像
├── docker-compose.yml     # Docker Compose 编排
├── server/                # Express 后端、API、远程连接服务
├── src/                   # React 前端
├── data/                  # SQLite 数据持久化目录
├── caddy_data/            # HTTPS 证书数据目录
└── caddy_config/          # Caddy 配置持久化目录
```

## 部署要求

- Linux 服务器或支持 Docker 的主机
- Docker Engine
- Docker Compose 或 `docker compose` 插件
- 浏览器可访问部署主机的 `9010` 和/或 `9443` 端口

## Docker 一键运行

从 GitHub 克隆源码：

```bash
git clone git@github.com:zhaoxixc/OpsJump.git
cd OpsJump
```

如果当前机器没有配置 GitHub SSH 公钥，也可以使用 HTTPS：

```bash
git clone https://github.com/zhaoxixc/OpsJump.git
cd OpsJump
```

如果已经下载好了源码包，直接进入项目根目录即可。

构建并启动（推荐）：

```bash
docker-compose up -d --build
```

如果环境使用新版 Docker Compose，也可以使用：

```bash
docker compose up -d --build
```

查看容器状态：

```bash
docker-compose ps
```

查看应用日志：

```bash
docker-compose logs -f quick-portal
```

停止服务：

```bash
docker-compose down
```

## Docker 说明

这是默认推荐方式，适合正式环境和日常使用。

- 首次运行会自动构建前端和后端镜像
- `data/`、`caddy_data/`、`caddy_config/` 会自动持久化
- 默认通过 `9010` 提供 HTTP，通过 `9443` 提供 HTTPS

## RockyLinux / Podman

如果宿主机使用的是 RockyLinux，通常会用 Podman 而不是 Docker，可以这样启动：

```bash
sudo dnf install -y podman podman-compose git
git clone https://github.com/zhaoxixc/OpsJump.git
cd OpsJump
podman-compose up -d --build
```

如果系统支持 Podman Compose 插件，也可以使用：

```bash
podman compose up -d --build
```

如果需要容器访问宿主机服务，Podman 环境下通常直接使用 `host.containers.internal` 更稳；Docker 环境下则保留 `host.docker.internal:host-gateway`。

Compose 已为服务显式创建 `opsjump` 网络，并给应用服务提供 `quickportal` 网络别名。Caddy 会通过 `quickportal:3001` 访问应用，避免 Podman 下服务名解析不稳定导致 `502`。

## 本地开发

如果只是调试前端或后端逻辑，可以直接本地启动：

```bash
npm install
npm run dev
```

本地开发时默认监听应用主进程，适合开发调试，不建议作为正式部署方式。

构建前端静态资源：

```bash
npm run build
```

生产模式启动：

```bash
npm run start
```

## 生产部署建议

生产环境建议使用 Docker Compose，并修改以下配置：

```yaml
JWT_SECRET: <随机长字符串>
GUAC_SECRET: <随机长字符串>
TLS_HOSTS: localhost,127.0.0.1,<服务器IP>,<域名>
```

部署后如需升级，重新构建即可：

```bash
docker-compose up -d --build
```

## 访问地址

- HTTP：`http://<服务器IP>:9010`
- HTTPS：`https://<服务器IP>:9443`

HTTPS 使用自签名证书，浏览器首次访问时可能提示不受信任。内网环境可手动信任证书，或通过页面/API 下载证书后导入信任区。

证书下载接口：

```text
/api/ca/root.crt
```

## 端口和容器

默认 Compose 包含三个服务：

- `quick-portal`：OpsJump 应用，容器内端口 `3001`
- `guacd`：Guacamole 远程桌面代理，用于 RDP
- `caddy`：HTTP/HTTPS 入口，宿主机端口 `9010`、`9443`

默认端口映射：

```yaml
9010:9010
9443:9443
```

## 环境变量

主要环境变量在 `docker-compose.yml` 中配置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | 应用容器内监听端口 |
| `JWT_SECRET` | `change-me` | 登录令牌签名密钥，生产请修改 |
| `GUAC_SECRET` | `change-me` | Guacamole token 加密密钥，生产请修改 |
| `GUACD_HOST` | `guacd` | guacd 服务地址 |
| `GUACD_PORT` | `4822` | guacd 服务端口 |
| `DB_PATH` | `/app/data/app.db` | SQLite 数据库路径 |
| `TLS_CERT_DIR` | `/caddy-data` | 自签名证书输出目录 |
| `TLS_HOSTS` | `localhost,127.0.0.1` | 证书 SAN 主机名/IP，逗号分隔 |
| `UPLOAD_JSON_LIMIT` | `1024mb` | 旧 base64 JSON 上传接口限制；新流式接口不依赖该限制 |

生产或长期使用建议至少修改：

```yaml
JWT_SECRET: <随机长字符串>
GUAC_SECRET: <随机长字符串>
TLS_HOSTS: localhost,127.0.0.1,<服务器IP>,<域名>
```

修改环境变量后重启：

```bash
docker-compose up -d --build
```

## 数据持久化

以下目录会持久化到宿主机：

- `./data:/app/data`：应用数据库、用户、快捷入口、日志等数据
- `./caddy_data:/data`：自签名证书
- `./caddy_config:/config`：Caddy 配置数据

备份时至少备份：

```bash
data/
caddy_data/
caddy_config/
```

## 使用说明

### 登录

1. 打开 `http://<服务器IP>:9010` 或 `https://<服务器IP>:9443`。
2. 使用默认账号登录。
3. 登录后进入左侧导航菜单。
4. 首次登录后建议在左下角用户区域修改密码。

### 快捷访问

1. 进入“快捷访问”。
2. 点击“新增按钮”。
3. 填写标题、URL、图标文本、颜色、排序等信息。
4. 点击快捷按钮即可在新窗口打开目标地址。
5. 支持按分类筛选和翻页。

### FTP / SFTP

1. 进入“FTP / SFTP”。
2. 填写主机、端口、用户名、密码。
3. FTP 可选择是否启用 SSL。
4. 点击登录后显示远端目录。
5. 点击目录名进入目录。
6. 点击“上传”选择本地文件上传。
7. 点击文件行的“下载”下载文件。
8. 点击“删除”删除远端文件。
9. 断开连接后密码输入框会自动清空。

文件上传下载采用流式方式：

- 上传接口：`/api/remote/ftp/upload-stream`、`/api/remote/sftp/upload-stream`
- 下载接口：`/api/remote/ftp/download-stream`、`/api/remote/sftp/download-stream`
- 不再把文件内容转换为 base64 JSON。
- 大文件主要受网络、远端服务器、浏览器和磁盘能力影响。

### VNC

1. 进入“VNC”。
2. 填写 VNC 地址、端口、密码。
3. 点击连接。
4. 连接后可点击“全屏”放大查看。
5. 点击“断开连接”结束会话。

说明：远端 VNC 服务需允许当前安全类型和密码认证。若浏览器连接失败，请先确认远端 VNC 端口、防火墙和认证方式。

### SSH

1. 进入“SSH”。
2. 填写主机、端口、用户名、密码。
3. 点击连接后打开 Web 终端。
4. 支持全屏终端。
5. 断开连接后密码输入框会自动清空。

### Windows 桌面（RDP）

1. 进入“Windows 桌面”。
2. 填写 RDP 地址、端口、域、用户名、密码。
3. 点击连接。
4. 连接成功后显示远程 Windows 桌面。
5. 可点击“全屏”放大查看。
6. 点击“断开连接”结束会话。

RDP 通过 `guacd` 提供代理能力。若连接失败，请确认：

- 远端主机开放 RDP 端口，默认 `3389`
- 账号密码正确
- 远端系统允许远程桌面连接
- Docker 网络可访问远端地址
- `guacd` 容器运行正常

### 网络检测

#### 实时 Ping

1. 进入“网络检测”。
2. 填写目标地址。
3. 填写次数。
4. 点击“开始 Ping”。

次数规则：

- `0`：持续 Ping，直到点击“停止”
- 大于 `0`：按指定次数实时输出结果

#### 端口检测

1. 填写主机和端口。
2. 点击“检测端口”。
3. 下方显示检测结果。

### 操作日志

进入“操作日志”查看登录和关键操作记录。日志包含：

- 时间
- 操作用户
- 类型
- 动作
- 目标
- 详情

Ping 和端口检测不会写入操作日志，避免日志被高频检测刷屏。

### 用户管理

管理员可进入“用户管理”：

- 新增用户
- 修改用户信息
- 启用/禁用用户
- 重置用户密码

普通用户只能修改自己的密码。

## HTTPS 和证书

服务启动时会自动生成自签名证书，默认保存到：

```text
caddy_data/selfsigned.crt
caddy_data/selfsigned.key
```

证书默认有效期较长，适合内网固定服务使用。如果修改了 `TLS_HOSTS`，系统会重新生成匹配 SAN 的证书。

如果浏览器提示证书不受信任，可将证书导入本机信任区。

## 常见问题

### 访问不到页面

检查容器状态：

```bash
docker-compose ps
```

检查日志：

```bash
docker-compose logs -f quick-portal
docker-compose logs -f caddy
```

确认服务器防火墙已放行：

- `9010/tcp`
- `9443/tcp`

### 长 Ping 没有持续输出

确认次数为 `0`。如果仍无输出，检查容器内是否存在 `ping`：

```bash
docker-compose exec quick-portal ping -c 2 127.0.0.1
```

### FTP/SFTP 大文件上传失败

当前前端已使用流式上传下载，不再依赖 base64 JSON。若仍失败，请检查：

- 远端 FTP/SFTP 服务器是否限制单文件大小
- 网络是否中断
- 远端目录是否有写入权限
- 磁盘空间是否充足
- 浏览器或反向代理是否有请求体限制

### RDP 连接失败

检查 guacd：

```bash
docker-compose logs -f guacd
```

确认远端 Windows 已启用远程桌面，端口可达，账号密码正确。

### VNC 连接失败

确认 VNC 服务端口可达，认证方式兼容，密码正确。部分 VNC 服务的 TLS 安全类型可能与 Web 代理不兼容，建议使用标准 `VncAuth`。

## 本地开发

安装依赖：

```bash
npm install
```

启动开发服务：

```bash
npm run dev
```

构建前端：

```bash
npm run build
```

生产启动：

```bash
npm run start
```

## 升级

拉取或替换代码后执行：

```bash
docker-compose up -d --build
```

升级前建议备份：

```bash
data/
caddy_data/
caddy_config/
```

## 安全建议

- 修改默认管理员密码。
- 修改 `JWT_SECRET` 和 `GUAC_SECRET`。
- 仅在可信内网开放服务端口。
- 使用防火墙限制访问来源。
- 定期备份 `data/` 目录。
- 不要把生产密码提交到代码仓库。

## 许可证

内部工具项目，按实际组织要求管理和分发。
