##### **12月26日（v0.1.0-beta7）**

- [x] P0（feat）默认增加CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC为"1"，降低遥测等问题
- [x] P1（fix）减少无法操作思考模式的问题
- [x] P1（fix）减少某些情况下一直重复编辑的问题
- [x] P3（UI）优化输入框更多功能弹窗UI触发区域

##### **12月25日（v0.1.0-beta6）**

- [x] P1（ui）将模式切换入口放到最外层
- [x] P1（feat）修复输入法组合输入渲染残留问题 #gadfly3173e
- [x] P2（BUG）修复主动思考按钮无法点击问题
- [x] P3（UX）优化三级菜单弹窗交互效果

##### **12月25日（v0.1.0-beta5）**

- [x] P0（fix）优化性能，解决输入框输入卡顿的问题（6000+对话也不卡）
- [x] P1（feat）增加主动思考配置入口
- [x] P1（fix）解决某些情况下cc-switch.db文件解析有问题
- [x] P2（fix）再次优化代码，降低window下出现无法编辑写入的BUG
- [x] P2（fix）再次优化代码，降低权限弹窗弹到其他窗口的概率
- [x] P2（fix）完善工具过程展示（之前默认全展示为成功，现在会有过程）#gadfly3173e

##### **12月25日（v0.1.0-beta4）**

- [x] P0（BUG）修复某些情况下，AI无法写入编辑的问题
- [x] P2（fix）优化提示词，解决#Lxxx-xxx 类型引入无法被AI准确理解的问题
- [x] P2（feat）实现模式切换持久化存储（不会随编辑器关闭而重置）
- [x] P3（feat）实现代码块区域复制功能

##### **12月24日（v0.1.0-beta3）**

- [x] P0（feat）实现Claude Code 模式切换功能（包括全自动权限模式）
- [x] P1（UI）优化了输入框底部按钮区域交互样式
- [x] P3（UI）优化了代码块展示样式

##### **12月23日（v0.1.0-beta2）**

- [x] P0（BUG）解决斜杠指令无法弹出的问题
- [x] P3（UI）增加90%字体的设置样式
- [x] P3（UI）优化历史对话记录样式间距过大问题（统一为对话过程中那种紧凑样式）
- [x] P3（UI）修复亮色模式下某些样式问题

##### **12月21日（v0.1.0）**

- [x] 增加字体缩放功能
- [x] 增加DIFF对比功能
- [x] 增加收藏功能
- [x] 增加修改标题功能
- [x] 增加根据标题搜索历史记录功能
- [x] 修复 alwaysThinkingEnabled 失效问题

##### **12月18日（v0.1.0-beta4）**

- [x] 解决 开启多个IDEA终端，权限弹窗 异常问题
- [x] 支持消息导出功能 #hpstream
- [x] 修复删除历史记录的某个小bug
- [x] 整体优化部分逻辑代码 #gadfly3173e

##### **12月11日（v0.1.0）**

- [x] P0（feat）实现当前打开的文件路径（将当前打开的文件信息默认发送给AI）
- [x] P0（feat）实现国际化功能
- [x] P0（feat）重构供应商管理列表，支持导入cc-switch配置
- [x] Pfeat）实现文件支持拖拽入输入框的功能（#gadfly3173 PR）
- [x] P1（feat）增加删除历史会话功能（由群友 PR）
- [x] P1（feat）增加Skills功能（由群友 PR）
- [x] P1（feat）增加右键选中代码，发送到插件的功能（#lxm1007 PR）
- [x] P1（fix）完善和重构 @文件功能，使@文件功能变得好用
- [x] P2（fix）解决输入框部分快捷操作失效的问题

##### **12月5日（v0.0.9）**

- [x] P0（feat）支持基础版本的MCP
- [x] P0（fix）解决window下，输入某些字符导致错误的问题
- [x] P0（fix）解决window下，使用node安装claude路径无法识别的问题
- [x] P0（fix）解决输入框光标无法快捷移动的问题
- [x] P0（fix）修改配置页面，之前只能展示两个字段，现在可以配置和展示多个字段
- [x] P1（feat）增加回到顶部，或者回到底部 按钮功能
- [x] P2（feat）支持文件信息点击跳转功能
- [x] P2（UI）优化权限弹窗样式
- [x] P2（fix）解决DIFF组件统计不精准的问题
- [x] P3（fix）打开历史会话自动定位到最底部
- [x] P3（fix）优化文件夹可点击效果
- [x] P3（fix）优化输入框工具切换icon
- [x] P3（fix）取消MD区域文件可点击功能
- [x] P3（UI）解决渠道删除按钮背景颜色问题
- [x] P3（fix）将点击供应商链接调跳转改为复制链接，以防止出现问题

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.8/4.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.8/5.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.8/6.png" />

##### **12月2日（v0.0.8）**

- [x] P0（feat）增加主动调整Node路径的功能，用以适配五花八门的Node路径
- [x] P1（feat）增加白色主题
- [x] P1（feat）将渠道配置功能与cc-switch解耦，防止规则改变导致渠道丢失
- [x] P1（feat）增加各种错误情况下的提示功能，减少空白展示情况
- [x] P1（feat）优化@文件功能（回车发送问题还未解决）
- [x] P2（fix）解决 运行命令 右侧小圆点总是展示置灰的问题
- [x] P2（fix）解决对话超时后，新建对话，原来的对话还在执行，点停止按钮也没反应
- [x] P2（UX）优化多处其他UI以及交互细节
- [x] P3（chore）插件兼容23.2版本IDEA版本

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.8/1.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.8/2.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.8/3.png" />

---

##### **12月1日（v0.0.7-beta2）**

- [x] P0: 重构代码 channel-manager.js 和 ClaudeSDKBridge.java 主代码
- [x] P1: 解决某些三方API兼容性问题

##### **11月30日（v0.0.7）**

- [x] P0: 支持选择 Opus4.5 进行提问
- [x] P0: 将权限弹窗由系统弹窗改为页面内弹窗，并且增加了允许且不再询问的功能
- [x] P1: 重构展示区域UI效果
- [x] P3: 优化顶部按钮展示问题
- [x] P3: 优化Loding样式
- [x] P5: 优化样式细节

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.7/2.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.7/1.png" />


##### **11月27日（v0.0.6）**

- [x] 重构 输入框UI交互
- [x] 输入框 支持发送图片
- [x] 输入框 支持模型容量统计
- [x] 优化 数据统计页面 UI样式
- [x] 优化 设置页面侧边栏展示样式
- [x] 重构 多平台兼容性问题
- [x] 解决某些特殊情况下响应无法中断的BUG

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.6/1.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.6/3.png" />


##### **11月26日（v0.0.5）**

- [x] 增加使用统计
- [x] 解决Window下新建问题按钮失效问题
- [x] 优化一些细节样式

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.6/2.png" />


##### **11月24日（v0.0.4）**

- [x] 实现简易版本cc-switch功能
- [x] 解决一些小的交互问题

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.4/1.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.4/2.png" />


##### **11月23日（v0.0.3）**

- [x] 解决一些核心交互阻塞流程
- [x] 重构交互页面UI展示

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.3/1.png" />


##### **11月22日**

- [x] 改进临时目录与权限逻辑
- [x] 拆分纯html，采用 Vite + React + TS 开发
- [x] 将前端资源CDN下载本地打包，加快首屏速度


##### **11月21日（v0.0.2）**

完成简易的，GUI对话 权限控制功能

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/5.png" />

文件写入功能展示

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/6.png" />


##### 11月20日

完成简易的，GUI对话基础页面

<img width="300" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/2.png" />

完成简易的，GUI对话页面，历史消息渲染功能

<img width="300" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/3.png" />

完成简易的，GUI页面，对话 + 回复 功能（**完成 claude-bridge 核心**）

<img width="300" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/4.png" />

##### 11月19日（v0.0.1） - 实现历史记录读取功能

<img width="400" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/1.png" />
