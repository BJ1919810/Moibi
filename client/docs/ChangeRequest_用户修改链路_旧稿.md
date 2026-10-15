> 历史设计草案。运行实现与验证结论请以《用户修改闭环_修复验收.md》为准。

# ChangeRequest 用户修改链路

用户修改不直接覆盖正式作品状态。

流程：

用户修改 → Draft → ChangeRequest → 影响分析 → 用户确认 → Version Commit → Ledger/Projection 更新

修改等级：

- chapter：章节级意图，可直接作为生成上下文。
- character：角色修改，需要确认。
- plot：剧情修改，需要确认并重新规划。
