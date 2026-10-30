# Deploy Desk

A small desktop panel for a single Linux server that runs one or two Node
backends plus static frontends. It wraps the repetitive parts of a bare-metal,
no-Docker setup: SSH health checks, per-project provisioning, `git push` deploys and
frontend uploads.

> 面向"一台 2G 小服务器 + 若干 Vue/Node 项目"的桌面运维面板。不用 Docker，不用在服务器上
> 额外跑面板服务，所有操作从本地通过 SSH 发起。支持 Windows / macOS / Linux。

## 下载

到 [Releases](../../releases) 页面下载对应平台的包：

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows | `Deploy Desk-x.y.z-setup.exe` | 安装版（可选安装目录） |
| Windows | `Deploy Desk-x.y.z-portable.exe` | 免安装，双击即用 |
| macOS | `Deploy Desk-x.y.z-arm64.dmg` | Apple Silicon（M 系列） |
| macOS | `Deploy Desk-x.y.z-x64.dmg` | Intel 芯片 |
| Linux | `Deploy Desk-x.y.z-x86_64.AppImage` | 免安装，`chmod +x` 后直接运行 |
| Linux | `Deploy Desk-x.y.z-amd64.deb` | Debian / Ubuntu 安装包 |

没有代码签名：

- 安装包没有代码签名，Windows SmartScreen 会先拦一次（"Windows 已保护你的电脑"）：
  点「更多信息 → 仍要运行」即可；想以后不再弹，右键 exe → 属性 → 勾选「解除锁定」再安装。
  这是"没见过这个发布者"的信誉提示，不是杀毒报毒。
- macOS 首次打开会拦下（应用是 ad-hoc 签名）。执行一次
  `xattr -dr com.apple.quarantine "/Applications/Deploy Desk.app"`，
  或右键 → 打开。Apple Silicon 版不要用 Intel 版运行。
- Linux AppImage 需要 `chmod +x`，部分发行版还要装 `libfuse2`。


## 功能

左侧菜单是 **项目** / **配置** / **发布**，右侧常驻「执行过程」日志，连接切换和「设置」（主题、版本与更新）固定在左下角。

| 菜单 | 面板 | 作用 |
|---|---|---|
| 配置 | 连接配置 | 保存多台服务器；密码/私钥口令用 Windows DPAPI 加密存储，不落明文 |
| 配置 | 服务器状态 | 一次采集 Node/pnpm/Nginx/MySQL 版本、内存与 swap、运行中的服务、监听端口、`/opt/apps` 与 `/opt/git` 内容、钩子数量 |
| 项目 | 项目表 | 一行一个项目：类型、入口、数据库、状态、操作都在同一行；配置写错的行直接标红并说明原因；配了域名的项目可直接「打开」浏览器 |
| 项目 | 数据库 / 状态 | 刷新服务器后显示每个项目是否已部署、库是否存在、表数与大小；后端行可执行迁移、备份，或把本地 `.sql` / `.sql.gz` 导入服务器库；纯前端行显示「已发布 / 未发布」，点「发前端」直接用发布页的 dist 目录覆盖到 `/var/www/<name>` |
| 项目 | 原始配置 | `projects.conf` 折叠在高级区，可从本地文件或服务器回显，改完点「应用更改」执行 `apply.sh` |
| 项目 | nginx 配置 | 项目页底部显示 `nginx -t` 状态，点「查看」在弹窗里只读展示服务器上由 `apply.sh` 生成的 `/etc/nginx/conf.d/projects.conf` |
| 发布 | 发布后端 | 在本地仓库执行 `git push <remote> <branch>`，服务器 `post-receive` 钩子负责安装、构建、迁移、重启 |
| 发布 | 发布前端 | 把本地 `dist/` 通过 SFTP 上传到 `/var/www/<name>`，可选上传前清空 |
| 设置（左下角齿轮） | 浮层 | 点齿轮在窗口左下角弹出：主题（深色 / 浅色 / 跟随系统，选择会记住）、当前版本、检查更新与「重启安装」；点外部或 Esc 收起 |
| 使用说明（左下角 ?） | 独立窗口 | 图文教程 `docs/guide.html`：界面总览、第一次配置、项目清单、发布、数据库、设置与常见问题；也可以直接用浏览器打开这个文件 |

关于自动更新：只有 **Windows 安装版** 和 **Linux AppImage** 支持应用内更新（需要
Releases 里上传的 `latest.yml` / `latest-linux.yml`）。Windows 免安装版、macOS
（ad-hoc 签名）不支持，会提示去 Releases 手动下载。

`projects.conf` 的 `db` 列决定是否建库：`mysql`（默认，库名 = 项目名把 `-` 换成 `_`）、`none`（不建库，纯接口项目）、或直接写库名。库名与密码写进 `/opt/apps/<name>/.env` 的 `DATABASE_URL`。

数据库操作的连接信息全部来自该 `.env` 的 `DATABASE_URL`，所以库在别的机器上也行：

- **迁移** 在服务器上跑 `prisma migrate deploy`，生表结构；
- **备份** 用 `.env` 里的账号连过去 `mysqldump` 到 `/var/backups/`；
- **导入** 把本地 `.sql` / `.sql.gz` 传到 `/tmp` 再 `mysql` 导入同一个库，适合把本机开发库搬到服务器（会覆盖同名表，先备份）。


## 服务器侧约定

面板假设服务器按下面的约定布置（纯目录约定，与本程序解耦）：

```
/opt/apps/<name>          后端应用目录
/opt/git/<name>.git       bare 仓库，hooks/post-receive 触发构建
/opt/deploy/apply.sh      项目清单的收敛脚本
/opt/deploy/add-project.sh 单个项目初始化
/opt/deploy/db.sh         数据库清单 / 迁移 / 备份
/opt/deploy/projects.conf 项目清单（面板里编辑）
/var/www/<name>           前端静态文件
```

钩子、systemd unit、Nginx 配置都不由本程序管理——它只是这些命令的图形入口。

## 本地开发

```bash
npm install
npm start            # 需要 Node 20+
npm run dist:win     # Windows 安装包 / 免安装版
npm run dist:mac     # dmg（x64 + arm64，只能在 macOS 上跑）
npm run dist:linux   # AppImage + deb（只能在 Linux 上跑）
```

产物都在 `release/`。CI 用 GitHub Actions 在三个系统上矩阵构建，推 `main` 即发版。

## 安全

- 渲染进程开启 `contextIsolation`、关闭 `nodeIntegration`，只通过 `preload.js` 暴露白名单 IPC
- 密码/口令经 `safeStorage`（Windows DPAPI）加密后写入用户目录的 `profiles.json`
- 私钥不复制、只保存路径，读取发生在主进程
- 本程序不会向公网暴露任何端口，不存在"面板被互联网访问"的问题

## License

MIT
