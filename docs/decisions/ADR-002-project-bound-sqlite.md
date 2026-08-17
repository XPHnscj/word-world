# ADR-002：使用项目目录 SQLite 保存本地学习数据

## Status

Accepted

## Date

2026-08-17

## Context

IndexedDB 适合零配置原型，但它按浏览器 origin 隔离。用户换浏览器、改变端口或清理网站数据后，会看到一套新的空数据；这不符合下载到本地长期使用的目标。

## Decision

将词卡、短文、复习记录、已掌握词、用户词书和学习会话写入项目目录 `data/learning.sqlite`。Next 本地 API `/api/storage` 负责读取和原子替换快照，前端启动时从 SQLite 恢复到 IndexedDB 缓存；已有 IndexedDB 数据在 SQLite 为空时自动迁移一次。

SQLite 采用 JSON 记录表而不是把每个学习对象拆成大量列，保留现有 TypeScript 数据结构的演进空间。浏览器 IndexedDB 只作为界面实时查询缓存，不再是长期数据的唯一来源。

## Alternatives Considered

### 继续只用 IndexedDB

无需后端，但数据绑定浏览器 origin，无法满足跨浏览器和项目级持久化。Rejected。

### PostgreSQL / MySQL

适合联网多用户服务，但需要独立数据库服务和部署配置，与本地下载即用的目标冲突。Rejected。

### Electron/Tauri 原生数据库

持久化能力强，但会把当前 Web 启动方式改成桌面壳，增加打包与跨平台维护成本。暂不采用。

## Consequences

- 启动器会创建 `data` 目录并继续固定打开 `http://127.0.0.1:3000`。
- 用户可以复制整个项目目录备份学习数据；`data/*.sqlite` 不提交到开源仓库。
- 旧浏览器数据可以自动迁移到 SQLite；SQLite 有数据时以 SQLite 为准，避免新浏览器覆盖已有学习记录。
- 需要安装 `better-sqlite3` 原生依赖，启动器日志会记录数据库初始化错误。
