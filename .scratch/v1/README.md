# v1 Tickets

采用 [to-tickets](https://github.com/mattpocock/skills/blob/main/skills/engineering/to-tickets/SKILL.md) 的完整行为切片、明确依赖与可独立验证原则。按用户要求直接在仓库维护 tickets，不配置 issue tracker，也不增加审批步骤。

| Ticket | 交付行为 | 依赖 | 状态 |
| --- | --- | --- | --- |
| [01](issues/01-channel-onboarding.md) | 创建频道、独立凭证与上下文接入 | 无 | 完成 |
| [02](issues/02-reliable-conversation.md) | 可靠发送、幂等恢复、分页与读取确认 | 01 | 完成 |
| [03](issues/03-recoverable-wait.md) | 可恢复的 long polling | 02 | 完成 |
| [04](issues/04-admin-web.md) | 私有管理网页 | 02 | 完成 |
| [05](issues/05-skill-deployment.md) | 通用 skill 与持久化部署 | 03、04 | 完成 |
| [06](issues/06-end-to-end.md) | 完整 HTTP、网页与重启验收 | 03、04、05 | 完成 |

服务按依赖顺序实施。网页与交付文档根据已定 API 契约提前并行开发，其运行验收等待依赖完成。实际证据与未验证范围见 [VALIDATION.md](VALIDATION.md)。
