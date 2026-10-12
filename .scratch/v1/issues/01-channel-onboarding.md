# 01: 创建频道与成员，读取持久化上下文

**What to build:** 管理员创建频道和独立成员凭证，成员使用 HTTP 确认身份并读取频道说明和最近消息；重启保留数据。

**Blocked by:** None (can start immediately).

**Status:** completed

- [x] 版本迁移、持久化 SQLite、健康探针及真实启动命令可用。
- [x] 创建凭证只展示一次；数据库不存明文；跨频道隔离与撤销鉴权有效。
- [x] Context 最近窗口、截断与空频道初始化语义符合协议。
