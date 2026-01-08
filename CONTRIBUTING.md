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

###  Branch Merge Guidelines（分支合并规范）

Currently, main is the primary branch and develop is the development branch. All PR merges must first be merged into the develop branch.

After submitting a PR, a PR AI review report will be generated. If there are medium-risk or high-risk issues identified, they must be fixed in the PR before merging can proceed.

目前main为主分支，develop为开发分支，任何PR合并需要先往develop上进行合并
提交PR之后，会生成一个PR AI审查报告，如果有中风险，和高风险问题，需要在PR中修复后才可进行合并

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

