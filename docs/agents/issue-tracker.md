# Issue tracker: GitHub

本仓库的 issue 与规格都在 GitHub Issues 里，统一用 `gh` CLI 操作。

## 约定

- **新建 issue**：`gh issue create --title "..." --body "..."`。多行正文用 heredoc。
- **读取 issue**：`gh issue view <number> --json number,title,body,labels,comments`。
- **列出 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，配合 `--label`、`--state` 过滤。
- **子 issue**：`gh issue create --parent <parent> ...`，或事后 `gh issue edit <parent> --add-sub-issue <child>`（gh 2.94+）。旧版用 `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`（数据库 id，见「阻塞关系」）。不支持子 issue 时，在子 issue 正文顶部写 `Part of #<parent>`。
- **阻塞关系**：GitHub 原生 issue 依赖。`gh issue create --blocked-by <n>,<n> ...` 或 `gh issue edit <child> --add-blocked-by <blocker>`（gh 2.94+）。旧版：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞者的数据库 id（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，不是 `#number`，也不是 node_id）。环境不支持依赖时，在子 issue 正文顶部写 `Blocked by: #<n>, #<n>`；所有阻塞者关闭后才算可开始。
- **统计未关闭的阻塞者**：`gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by`（只算未关闭的；0 = 可以开始）。`gh issue view <n> --json blockedBy` 会带上已关闭的，需要自己过滤：`--jq '[.blockedBy.nodes[] | select(.state == "OPEN")] | length'`。
- **评论**：`gh issue comment <number> --body "..."`。
- **加/去标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`。
- **关闭**：先用 `gh issue comment <number> --body "..."` 说明原因，再 `gh issue close <number>`。对已关闭的 issue 用 `gh issue close --comment` 会丢掉评论但仍返回 0。

仓库从 `git remote -v` 推断；在克隆目录里运行 `gh` 会自动识别。

只往用户自己的仓库提 issue，不要提到 `mattpocock/skills`（这些技能的来源仓库），除非用户就是它的 owner。fork 里 `gh` 可能默认指向上游，所以会话里第一次 `gh issue create` 前先用 `gh repo view --json nameWithOwner` 确认目标，若不是用户自己的仓库要跟用户确认。

## Pull request 是否参与 triage

**不参与。**（若本仓库把外部 PR 当作 feature request，把这一行改成 `yes`；`/triage` 会读它。）

## 技能说「publish to the issue tracker」时

创建 GitHub issue。

## 技能说「fetch the relevant ticket」时

按上面的「读取 issue」读。

## Wayfinding 操作

由 `/wayfinder` 使用。**map** 是一个 issue，**ticket** 是它的子 issue。

- **Map**：单个 issue，标签 `wayfinder:map`，正文放 Notes / Decisions so far / Fog 三块。
- **子 ticket**：建为 map 的 sub-issue（见「子 issue」）。不支持子 issue 时，把子 ticket 加进 map 正文的任务列表，并在子 issue 顶部写 `Part of #<map>`。标签 `wayfinder:research` / `wayfinder:prototype` / `wayfinder:grilling` / `wayfinder:task`。认领后 assign 给执行者。
- **阻塞**：见「阻塞关系」。
- **找可接的 ticket**：列出 map 的未关闭子 issue，去掉有未关闭阻塞者或有 assignee 的，按 map 里的顺序取第一个。
- **认领**：`gh issue edit <n> --add-assignee @me`。
- **完成**：`gh issue comment <n> --body "<answer>"`，再 `gh issue close <n>`，最后把结论要点（gist + 链接）追加到 map 的 Decisions so far。
