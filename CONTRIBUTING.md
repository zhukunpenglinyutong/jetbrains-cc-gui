### Language norms（语言规范）

In order to ensure the continuous development of this project, English will be the main development language for international communication
The original Chinese annotations, PR submission records, etc. will gradually be changed to English in the future

为了本项目持续发展，后续开发统一使用英文为主要开发语言，以进行国际交流
原有中文注释，PR提交记录等，后续逐渐变更为英文

---

### Version Number Specification（发版序号规范）

The current store version is v0.1.4. If developing v0.1.5, the intermediate transition version numbers should be:
v0.1.5-beta1, v0.1.5-beta2, v0.1.5-beta3, ..., until v0.1.5

当前商店版本号为v0.1.4 如果 要开发 v0.1.5版本，那么中间的过渡版本为：
v0.1.5-beta1，v0.1.5-beta2，v0.1.5-beta3，..... 直到 v0.1.5

---

### Branch Merge Guidelines（分支合并规范）

- `main` is the stable/release branch. Do **not** open PRs against `main` by default.
- Active development happens on the **current version branch**, named `feature/vX.Y.Z` (for example, the current target is `feature/v0.5.2`).
- All community PRs must target the **latest in-progress version branch** (not `main`, not `develop`, and not an older `feature/v*` branch unless fixing that release).
- After you open a PR, an AI review report is generated. Medium-risk and high-risk findings must be fixed in the PR before it can be merged.

- `main` 为稳定/发版分支，**默认不要**直接向 `main` 提 PR。
- 日常开发在**当前版本分支**上进行，命名为 `feature/vX.Y.Z`（例如当前目标分支为 `feature/v0.5.2`）。
- 社区 PR 必须合并到**当前正在迭代的最新版本分支**（不要合到 `main`、`develop`，也不要合到已结束的旧 `feature/v*` 分支，除非是专门修那个版本）。
- 提交 PR 后会生成 PR AI 审查报告；若存在中风险或高风险问题，必须在 PR 中修复后才可合并。

---

### Version Iteration Planning Specification（版本迭代规划规范）

A feature planning issue will be created for each minor version (at the level of v0.1.4, v0.1.5, etc.). Once all modifications are completed, a release will be published, followed by development work for the next minor version iteration. Community developers can also submit PRs based on the current minor version iteration todolist for merging.

后续每个小版本会创建一个功能规划issues（指的是v0.1.4，v0.1.5这种级别的版本功能规划）
全部修改完成之后进行发版，然后进行下个小版本的迭代开发工作
社区开发人员也可以根据当前小版本迭代todolist来进行PR合并

status（状态）
- 🟢 in-progress（进行中 ）
- 🟡 todo（待开始 ）
- 🔴 延期到下个版本
- ✅ 已完成

priority（优先级）
- P0（阻塞性问题）
- P1 （高优先级）
- P2（中优先级）
- P3（低优先级）

labels（类型）
- feat（新功能开发）
- enhancement（功能增强）
- bugfix（Bug修复）
- documentation（文档相关）
- tech-debt（技术债务）
- testing（测试相关）

