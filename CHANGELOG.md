##### **January 5, 2026 (v0.2.2) — Upstream Sync**

**Full Upstream Merge**
- Synced 23 commits from upstream v0.1.4-beta7
- Merged permission dialog fixes for proxy mode
- Integrated macOS subscription login support
- Added Ask User Question feature
- MCP server toggle with enable/disable support
- Auto-localization based on IDEA language settings

---

##### **January 4, 2026 (v0.2.1) — Feature Update**

**MCP Server Toggle Enhancements**
- Dedicated `toggle_mcp_server` action with project-level tracking
- Smart refresh scheduling for real-time status updates
- Visual indicators for disabled server state
- Comprehensive test coverage for MCP settings

**AskUserQuestion Tool Support**
- Full implementation of Claude's AskUserQuestion tool
- Interactive dialog for structured user input during tasks
- Multi-select support for checkbox-style questions
- "Other" option with free-form text input
- i18n support across all 6 locales

**Code Quality**
- Removed AWS Bedrock SDK dependency (simplified authentication)
- Added test infrastructure with Vitest
- Fixed Chinese placeholder bug in chat input
- Enhanced error handling and reliability

---

##### **January 3, 2026 (v0.2.0) — Fork Release**

🌍 **Complete English Localization**
- All user-facing UI translated: dialogs, buttons, toasts, tooltips, error messages
- Permission dialog: Allow/Deny/Always allow with keyboard shortcuts
- MCP dialogs: Help, Preset selection, Server configuration
- Tool blocks: Read file, Task execution, Generic tool actions
- Settings: Sidebar, confirm dialogs, date formatting (en-US locale)
- Developer logs and console messages translated

🔐 **Seamless CLI Authentication**
- Automatic detection of existing `claude login` session
- No API key re-entry required for Claude subscribers

📦 **New Plugin Identity**
- New icon for JetBrains Marketplace recognition
- Clear fork attribution to upstream project

🛠 **Build & Tooling**
- Compatible with IntelliJ IDEA 2023.3 – 2026.3
- Gradle 8.x with IntelliJ Platform Plugin 2.10.5

---

##### **January 2, 2026 (v0.1.4-beta3)**

- [x] P0 (feat) Implement initial Agent feature (prompt injection)
- [x] P1 (fix) Fix conversation anomaly when returning from history page #su'qiang
- [x] P2 (fix) Fix file reference tag showing non-existent folders #su'qiang
- [x] P2 (feat) Improve Node.js version check #gadfly3173

##### **January 1, 2026 (v0.1.4-beta2)**

- [x] P0 (feat) Add prompt enhancement feature #xiexiaofei
- [x] P1 (feat) Support mentioning multiple files
- [x] P1 (feat) Optimize selected text prompts, fix AI recognition instability
- [x] P2 (fix) Fix deleted sessions still appearing after deletion #su'qiang
- [x] P2 (feat) Disable MD rendering for user messages, keep newlines/spaces
- [x] P2 (feat) Add current font info display
- [x] P2 (feat) Add JSON format button in provider settings
- [x] P3 (fix) Fix dropdown list click issue (minor issue from PR#110)

##### **December 31 (v0.1.4-beta1)**

- [x] P1 (feat) Add IDE font settings reading
- [x] P2 (feat) Show MCP server connection status #gadfly3173
- [x] P3 (fix) Add collapsible user messages (triggers when > 7 lines)
- [x] P3 (UI) Optimize various UI display effects

##### **December 30 (v0.1.3)**

- [x] P1 (fix) Improve error messages for edge cases

##### **December 26 (v0.1.2-beta7)**

- [x] P0 (feat) Add CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1" by default to reduce telemetry
- [x] P1 (fix) Reduce issues with thinking mode toggle
- [x] P1 (fix) Reduce repeated editing issues in some cases
- [x] P3 (UI) Optimize input box feature popup trigger area

##### **December 25 (v0.1.2-beta6)**

- [x] P1 (UI) Move mode switch to top level
- [x] P1 (feat) Fix IME composition rendering residue #gadfly3173
- [x] P2 (BUG) Fix thinking toggle button not clickable
- [x] P3 (UX) Optimize tertiary menu popup interaction

##### **December 25 (v0.1.2-beta5)**

- [x] P0 (fix) Optimize performance, fix input lag (smooth even with 6000+ messages)
- [x] P1 (feat) Add thinking mode config entry
- [x] P1 (fix) Fix cc-switch.db file parsing issues
- [x] P2 (fix) Further optimize code, reduce Windows write/edit failures
- [x] P2 (fix) Further optimize code, reduce permission popup appearing in wrong window
- [x] P2 (fix) Improve tool process display (show actual status instead of always success) #gadfly3173

##### **December 25 (v0.1.2-beta4)**

- [x] P0 (BUG) Fix AI unable to write/edit in some cases
- [x] P2 (fix) Optimize prompts, fix #Lxxx-xxx type references not understood by AI
- [x] P2 (feat) Implement persistent mode switch storage (persists across editor restarts)
- [x] P3 (feat) Implement code block copy functionality

##### **December 24 (v0.1.2-beta3)**

- [x] P0 (feat) Implement Claude Code mode switching (including full auto-permission mode)
- [x] P1 (UI) Optimize input box bottom button area interaction
- [x] P3 (UI) Optimize code block display style

##### **December 23 (v0.1.2-beta2)**

- [x] P0 (BUG) Fix slash commands not appearing
- [x] P3 (UI) Add 90% font size setting
- [x] P3 (UI) Optimize history conversation spacing (unified compact style)
- [x] P3 (UI) Fix some light theme style issues

##### **December 21 (v0.1.2)**

- [x] Add font scaling feature
- [x] Add DIFF comparison feature
- [x] Add favorites feature
- [x] Add title editing feature
- [x] Add history search by title
- [x] Fix alwaysThinkingEnabled not working

##### **December 18 (v0.1.1-beta4)**

- [x] Fix permission popup issues when multiple IDEA terminals open
- [x] Support message export feature #hpstream
- [x] Fix minor history deletion bug
- [x] Overall code logic optimization #gadfly3173

##### **December 11 (v0.1.1)**

- [x] P0 (feat) Implement currently opened file paths (send open file info to AI by default)
- [x] P0 (feat) Implement internationalization (i18n)
- [x] P0 (feat) Refactor provider management, support cc-switch config import
- [x] P1 (feat) Implement drag-and-drop files into input (#gadfly3173 PR)
- [x] P1 (feat) Add delete history session feature (community PR)
- [x] P1 (feat) Add Skills feature (community PR)
- [x] P1 (feat) Add right-click send selected code to plugin (#lxm1007 PR)
- [x] P1 (fix) Improve and refactor @file functionality
- [x] P2 (fix) Fix input box shortcut issues

##### **December 5 (v0.0.9)**

- [x] P0 (feat) Support basic MCP version
- [x] P0 (fix) Fix Windows character input errors
- [x] P0 (fix) Fix Windows Node.js path detection when installed via npm
- [x] P0 (fix) Fix input cursor navigation shortcuts
- [x] P0 (fix) Update config page to display multiple fields (previously limited to 2)
- [x] P1 (feat) Add scroll to top/bottom buttons
- [x] P2 (feat) Support file info click-to-jump
- [x] P2 (UI) Optimize permission popup style
- [x] P2 (fix) Fix DIFF component statistics accuracy
- [x] P3 (fix) Auto-scroll to bottom when opening history session
- [x] P3 (fix) Optimize folder clickable effect
- [x] P3 (fix) Optimize input box tool switch icon
- [x] P3 (fix) Disable clickable files in MD areas
- [x] P3 (UI) Fix provider delete button background color
- [x] P3 (fix) Change provider link click to copy (prevent navigation issues)

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.8/4.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.8/5.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.8/6.png" />

##### **December 2 (v0.0.8)**

- [x] P0 (feat) Add manual Node.js path adjustment for various Node installations
- [x] P1 (feat) Add light theme
- [x] P1 (feat) Decouple provider config from cc-switch to prevent config loss
- [x] P1 (feat) Add error prompts for various edge cases
- [x] P1 (feat) Optimize @file functionality (Enter-to-send issue pending)
- [x] P2 (fix) Fix command run indicator always showing gray
- [x] P2 (fix) Fix conversation continuing after timeout, stop button unresponsive
- [x] P2 (UX) Optimize various UI and interaction details
- [x] P3 (chore) Plugin compatible with IDEA 23.2

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.8/1.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.8/2.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.8/3.png" />

---

##### **December 1 (v0.0.7-beta2)**

- [x] P0: Refactor channel-manager.js and ClaudeSDKBridge.java core code
- [x] P1: Fix some third-party API compatibility issues

##### **November 30 (v0.0.7)**

- [x] P0: Support Opus 4.5 model selection
- [x] P0: Change permission popup from system dialog to in-page modal, add "allow and don't ask again"
- [x] P1: Refactor display area UI
- [x] P3: Optimize top button display
- [x] P3: Optimize loading style
- [x] P5: Polish style details

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.7/2.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.7/1.png" />


##### **November 27 (v0.0.6)**

- [x] Refactor input box UI interaction
- [x] Input box supports sending images
- [x] Input box supports model capacity statistics
- [x] Optimize statistics page UI style
- [x] Optimize settings page sidebar display
- [x] Refactor multi-platform compatibility
- [x] Fix response not interruptible in some edge cases

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.6/1.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.6/3.png" />


##### **November 26 (v0.0.5)**

- [x] Add usage statistics
- [x] Fix Windows new question button not working
- [x] Optimize some detail styles

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.6/2.png" />


##### **November 24 (v0.0.4)**

- [x] Implement simple cc-switch functionality
- [x] Fix some minor interaction issues

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.4/1.png" />

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.4/2.png" />


##### **November 23 (v0.0.3)**

- [x] Fix some core interaction blocking flows
- [x] Refactor interaction page UI display

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.3/1.png" />


##### **November 22**

- [x] Improve temporary directory and permission logic
- [x] Split from pure HTML, adopt Vite + React + TS development
- [x] Bundle frontend resources locally (previously CDN) for faster initial load


##### **November 21 (v0.0.2)**

Completed basic GUI conversation with permission control

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/5.png" />

File write functionality demo

<img width="500" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/6.png" />


##### November 20

Completed basic GUI conversation page

<img width="300" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/2.png" />

Completed GUI conversation page with history message rendering

<img width="300" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/3.png" />

Completed GUI page with conversation + reply functionality (**claude-bridge core complete**)

<img width="300" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/4.png" />

##### November 19 (v0.0.1) - Implemented history reading functionality

<img width="400" alt="Image" src="https://claudecodecn-1253302184.cos.ap-beijing.myqcloud.com/idea/v0.0.2/1.png" />
