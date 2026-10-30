# Deploy Desk

A small Windows desktop panel for a single Linux server that runs one or two Node
backends plus static frontends. It wraps the repetitive parts of a bare-metal,
no-Docker setup: SSH health checks, per-project provisioning, `git push` deploys and
frontend uploads.

> 面向"一台 2G 小服务器 + 若干 Vue/Node 项目"的桌面运维面板。不用 Docker，不用在服务器上
> 额外跑面板服务，所有操作从本地通过 SSH 发起。

## 下载

到 [Releases](../../releases) 页面下载：

- `Deploy Desk-x.y.z-setup.exe` — 安装版（可选安装目录）
- `Deploy Desk-x.y.z-portable.exe` — 免安装，双击即用

未做代码签名，Windows SmartScreen 可能提示"未知发布者"，选"更多信息 → 仍要运行"。

## 功能

界面分三个菜单：**服务器** / **项目** / **发布**，日志固定在底部。

| 菜单 | 面板 | 作用 |
|---|---|---|
| 服务器 | 连接配置 | 保存多台服务器；密码/私钥口令用 Windows DPAPI 加密存储，不落明文 |
| 服务器 | 服务器状态 | 一次采集 Node/pnpm/Nginx/MySQL 版本、内存与 swap、运行中的服务、监听端口、`/opt/apps` 与 `/opt/git` 内容、钩子数量 |
| 项目 | 项目配置 | `projects.conf` 可从本地文件或服务器回显（默认读脚本目录里的模板），改完上传并执行 `apply.sh` |
| 项目 | 数据库 | 列出各项目的库名/是否存在/大小/表数；对选中项目执行 `prisma migrate deploy` 或备份到 `/var/backups` |
| 发布 | 发布后端 | 在本地仓库执行 `git push <remote> <branch>`，服务器 `post-receive` 钩子负责安装、构建、迁移、重启 |
| 发布 | 发布前端 | 把本地 `dist/` 通过 SFTP 上传到 `/var/www/<name>`，可选上传前清空 |

`projects.conf` 的 `db` 列决定是否建库：`mysql`（默认，库名 = 项目名把 `-` 换成 `_`）、`none`（不建库，纯接口项目）、或直接写库名。库名与密码写进 `/opt/apps/<name>/.env` 的 `DATABASE_URL`。


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
npm start          # 需要 Node 20+
npm run dist       # 本地构建 Windows 安装包（输出到 release/）
```

## 安全

- 渲染进程开启 `contextIsolation`、关闭 `nodeIntegration`，只通过 `preload.js` 暴露白名单 IPC
- 密码/口令经 `safeStorage`（Windows DPAPI）加密后写入用户目录的 `profiles.json`
- 私钥不复制、只保存路径，读取发生在主进程
- 本程序不会向公网暴露任何端口，不存在"面板被互联网访问"的问题

## License

MIT
