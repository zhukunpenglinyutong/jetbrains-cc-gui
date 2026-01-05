# Cherry-Pick Session Guide

**Purpose**: Reduce fork's "commit behind" debt through incremental upstream synchronization  
**Created**: January 5, 2026  
**For**: Dedicated sync session agent

---

## 🎯 Session Goal

Incrementally cherry-pick upstream commits to:
1. Reduce "commits behind" count shown on GitHub
2. Minimize future merge conflicts
3. Maintain fork's quality standards (English comments, tests)
4. Establish ongoing sync cadence

---

## 📋 Pre-Session Checklist

### 1. Verify Current State

```bash
cd /home/runner/work/idea-claude-gui/idea-claude-gui

# Check current branch
git branch

# Ensure clean working tree
git status

# Fetch latest upstream
git fetch upstream

# Check how far behind
git log --oneline HEAD..upstream/main | wc -l
```

**Expected**: ~30 commits behind as of January 2026

### 2. Review Already Implemented Features

**✅ Already in Fork** (via manual implementation in v0.3.0):
- IDE Language Detection (commit 86df546)
- ACCEPT_EDITS Permission Mode (commit cc0e909)
- macOS Keychain Support (commit 5c5fefe)

**Do NOT cherry-pick** these upstream commits:
- `d692a81` - Language detection (already implemented)
- `ca73535` - ACCEPT_EDITS mode (already implemented)
- `a7735fd` - Keychain support (already implemented)

---

## 🔍 Upstream Commits to Consider

### Priority 1: Low-Conflict Bug Fixes

#### 1. Concurrency Fixes (`fac0bff`)
```bash
git show fac0bff --stat
```

**Description**: Thread-safe execution and file checks  
**Files Changed**: ~3 files
- `SlashCommandCache.java` - Replace SwingUtilities with Alarm
- `PermissionService.java` - Add file existence checks
- Related service files

**Conflict Estimate**: Low (2-3 files)  
**Strategy**: Accept upstream logic, translate comments to English  
**Testing**: Run permission tests after cherry-pick

**Command**:
```bash
git cherry-pick fac0bff
# Resolve conflicts if any
# Translate Chinese comments to English
git add .
git commit --amend  # Update commit message if needed
```

---

#### 2. Windows Black Screen Fix (`e397cad`)
```bash
git show e397cad --stat
```

**Description**: Permission dialog crash fix  
**Files Changed**: 1-2 files  
**Conflict Estimate**: Very Low  
**Strategy**: Accept upstream fix as-is

---

### Priority 2: Node.js Detection Enhancement (`d1a7903`)

**Check First**: Does fork already have this?
```bash
grep -r "auto-detect" src/main/java/com/github/claudecodegui/bridge/NodeDetector.java
```

**If NOT present**:
```bash
git cherry-pick d1a7903
```

**Description**: Automatic Node.js path detection on first install  
**Files Changed**: 2-3 files
- `NodeDetector.java`
- Related configuration

**Conflict Estimate**: Low  
**Testing**: Verify Node.js detection works

---

### Priority 3: i18n Enhancements (`d35df2d`, `32a7ae4`)

**⚠️ Higher Conflict Risk** - Handle carefully

**Description**: UI text improvements and i18n completeness  
**Files Changed**: 10+ i18n locale files  
**Conflict Estimate**: Medium-High

**Strategy**:
1. Cherry-pick commit
2. For each conflict:
   - Keep fork's English translations as base
   - Review upstream changes for new strings
   - Add missing translations if valuable
   - Maintain fork's translation quality

**Command**:
```bash
git cherry-pick d35df2d
# Expect conflicts in:
# - webview/src/i18n/locales/*.json
# - src/main/resources/messages/*.properties

# Resolution approach:
# 1. Accept fork's version for existing strings
# 2. Add new strings from upstream
# 3. Translate Chinese additions to English
```

---

### Priority 4: MCP/Skills Dialog Completion (`32a7ae4`)

**Description**: Complete i18n for MCP and Skills dialogs  
**Files Changed**: 5-8 i18n files  
**Conflict Estimate**: Medium

**Dependencies**: Should be done after Priority 3

---

### Lower Priority Commits

These can be deferred to future sessions:

- `/init` and `/review` slash commands (`94b6686`) - Already have MCP integration
- Agent functionality (`43b7631`) - Depends on upstream architecture
- Code refactoring (`e7dedb8`) - Internal restructuring

---

## 🛠️ Cherry-Pick Process

### Step-by-Step Workflow

#### 1. Prepare Branch
```bash
# Create dedicated sync branch
git checkout -b sync-cherry-pick-2026-01
```

#### 2. Cherry-Pick Single Commit
```bash
# Pick one commit
git cherry-pick <commit-hash>

# If conflicts occur:
git status  # See conflicting files
```

#### 3. Resolve Conflicts

**For Java Files**:
```bash
# Open conflicting file
# Look for conflict markers: <<<<<<<, =======, >>>>>>>

# Resolution priority:
# 1. Keep upstream's logic/code
# 2. Translate Chinese comments to English
# 3. Maintain fork's code style
```

**For i18n Files**:
```bash
# Resolution priority:
# 1. Keep fork's English translations
# 2. Add new keys from upstream
# 3. Translate Chinese values to English
# 4. Maintain consistency across locales
```

**For Config Files** (package.json, build.gradle):
```bash
# Resolution priority:
# 1. Keep fork's dependencies if newer
# 2. Add new dependencies from upstream
# 3. Resolve version conflicts (use higher version)
```

#### 4. Complete Cherry-Pick
```bash
# After resolving conflicts
git add .

# Continue cherry-pick
git cherry-pick --continue

# Or abort if needed
git cherry-pick --abort
```

#### 5. Verify Changes
```bash
# Check what changed
git show HEAD

# Run tests
cd webview && npm test
./gradlew test  # If Java tests available

# Build to verify
cd webview && npm run build
```

#### 6. Document
```bash
# Update changelog or sync log
echo "Cherry-picked <commit-hash>: <description>" >> docs/SYNC_LOG.md
```

---

## 📊 Conflict Resolution Patterns

### Pattern 1: Comment Translation

**Upstream** (Chinese):
```java
// 设置权限管理器回调
permissionManager.setOnPermissionRequestedCallback(request -> {
```

**Fork** (English):
```java
// Set permission manager callback
permissionManager.setOnPermissionRequestedCallback(request -> {
```

**Resolution**: Keep fork's English comment, upstream's code logic

---

### Pattern 2: i18n File Merge

**Upstream** adds new key in `zh.json`:
```json
{
  "newFeature": "新功能"
}
```

**Fork** doesn't have this key.

**Resolution**: Add to all locale files:
```json
// en.json
{
  "newFeature": "New Feature"
}

// es.json
{
  "newFeature": "Nueva Función"
}
// ... etc
```

---

### Pattern 3: Dependency Version Conflict

**Upstream**: `"vite": "^7.2.4"`  
**Fork**: `"vite": "^7.3.0"`

**Resolution**: Keep higher version (fork's 7.3.0)

---

## 🧪 Testing Requirements

### After Each Cherry-Pick

1. **Build Check**:
```bash
cd webview && npm run build
```

2. **Test Suite**:
```bash
cd webview && npm test
```

3. **Syntax Validation**:
```bash
# JavaScript
node -c ai-bridge/config/api-config.js

# TypeScript
cd webview && npx tsc --noEmit
```

4. **Manual Verification**:
- Check affected features work
- No console errors
- UI renders correctly

---

## 📈 Progress Tracking

### Session Template

Create a session log file:

```markdown
# Cherry-Pick Session - [Date]

## Commits Attempted
- [ ] fac0bff - Concurrency fixes
- [ ] e397cad - Windows fix
- [ ] d1a7903 - Node.js detection

## Results
### Successfully Cherry-Picked
1. fac0bff - 3 conflicts resolved
   - Files: SlashCommandCache.java, PermissionService.java
   - Tests: ✅ Passing

### Deferred
- d35df2d - Too many i18n conflicts, needs dedicated session

## Commits Behind Count
- Before: 30 commits
- After: 27 commits
- Reduction: 3 commits

## Next Session Priorities
1. Continue with i18n enhancements
2. Review new upstream commits (if any)
```

---

## 🚨 When to Stop

### Stop Criteria

1. **Time Limit**: 45 minutes per commit type
2. **Conflict Threshold**: >10 files conflicting in single commit
3. **Test Failures**: Any failing tests after cherry-pick
4. **Complexity**: Logic conflicts (not just comments/i18n)

### Document Blockers

```markdown
## Blocked Cherry-Picks

### Commit: <hash>
**Reason**: Too many conflicts / Logic incompatibility  
**Conflicts**: [List files]  
**Recommendation**: Manual review needed / Defer to later
```

---

## 📝 Post-Session Checklist

### 1. Update Documentation

**Update `UPSTREAM_EVALUATION_<date>.md`**:
```markdown
## Cherry-Pick Session Results

**Date**: [Date]  
**Commits Picked**: X  
**Commits Behind Before**: Y  
**Commits Behind After**: Z  

### Successfully Integrated
- commit-hash: description

### Deferred
- commit-hash: description (reason)
```

### 2. Create Pull Request

```bash
# Push sync branch
git push origin sync-cherry-pick-2026-01

# Create PR with summary of cherry-picks
```

**PR Template**:
```markdown
## Upstream Sync - Cherry-Pick Session

Incrementally sync with upstream to reduce commit debt.

### Cherry-Picked Commits
- fac0bff: Concurrency fixes
- e397cad: Windows crash fix

### Changes
- X commits behind → Y commits behind
- All tests passing
- No regressions

### Deferred
- i18n enhancements (needs dedicated session)

### Testing
- ✅ Webview tests: 12/12 passing
- ✅ Build successful
- ✅ No regressions
```

### 3. Merge Strategy

**If cherry-picks successful**:
- Merge sync branch to main
- Tag as "sync-point-2026-01-XX"
- Schedule next sync session (1 month)

**If blockers encountered**:
- Document in SYNC_LOG.md
- Create issues for complex conflicts
- Proceed with what's done

---

## 🎯 Success Metrics

### Target Per Session
- **Minimum**: 3 commits cherry-picked
- **Optimal**: 5-7 commits cherry-picked
- **Stretch**: 10+ commits if low-conflict

### Quality Metrics
- ✅ All tests passing
- ✅ Build successful
- ✅ No console errors
- ✅ English comments maintained
- ✅ Fork code style preserved

---

## 🔄 Recurring Sync Schedule

### Monthly Cadence

**Week 1**: Evaluate new upstream commits  
**Week 2**: Cherry-pick session (low-conflict commits)  
**Week 3**: Testing and validation  
**Week 4**: Merge and document

### Quarterly Review

- Assess sync strategy effectiveness
- Update this guide based on learnings
- Consider alternative approaches if needed

---

## 🆘 Troubleshooting

### Issue: Cherry-pick fails immediately

**Solution**:
```bash
# Check if commit was already applied
git log --grep="<commit-message>"

# If found, skip it
git cherry-pick --skip
```

---

### Issue: Too many conflicts

**Solution**:
```bash
# Abort and break into smaller pieces
git cherry-pick --abort

# Try cherry-picking specific files
git show <commit>:path/to/file > temp_file
# Manually integrate changes
```

---

### Issue: Test failures after cherry-pick

**Solution**:
```bash
# Revert the cherry-pick
git revert HEAD

# Analyze the failure
npm test -- --verbose

# Fix issues
# Re-attempt cherry-pick with fixes
```

---

## 📚 Reference Commands

### Quick Reference

```bash
# View commit details
git show <commit-hash>

# View files in commit
git show <commit-hash> --name-only

# Compare with upstream
git diff HEAD upstream/main -- <file>

# View conflict in detail
git diff --check

# List all conflicts
git diff --name-only --diff-filter=U

# Accept ours/theirs for entire file
git checkout --ours <file>
git checkout --theirs <file>

# Continue after resolving
git add <file>
git cherry-pick --continue
```

---

## 🎓 Learning from Previous Attempts

### What We Learned

1. ~~**Full merge**: 102 conflicts → Not feasible~~ **UPDATE**: Merge-base exists! Full merge now viable
2. ~~**Grafted history**: No common ancestor~~ **UPDATE**: Common ancestor at `940bdc0` (v0.1.3)
3. **Cherry-pick**: 2-5 files per commit → Manageable (fallback option)
4. **i18n files**: Highest conflict rate → Handle separately
5. **Code logic**: Usually identical → Focus on comments

### Best Practices

1. ✅ Start with bug fixes (lowest conflict)
2. ✅ One commit at a time
3. ✅ Test after each cherry-pick
4. ✅ Document conflicts and resolutions
5. ✅ Defer large i18n batches to dedicated sessions
6. ❌ Don't batch multiple commits
7. ❌ Don't skip testing
8. ❌ Don't cherry-pick already implemented features

---

## 📞 Questions for Session Agent

If you encounter uncertainty, consider:

1. **Is this feature already in fork?** → Check implementation before cherry-picking
2. **Does logic conflict?** → Manual review needed, don't auto-resolve
3. **Are tests failing?** → Investigate, don't force through
4. **Too many conflicts?** → Defer, document why
5. **Chinese comments?** → Translate to English, maintain fork style

---

## ✅ Final Checklist

Before ending session:

- [ ] All cherry-picked commits have passing tests
- [ ] Build succeeds
- [ ] Documentation updated (SYNC_LOG.md)
- [ ] Progress tracked (commits behind count)
- [ ] Conflicts documented
- [ ] Next session priorities identified
- [ ] PR created (if ready to merge)

---

*Guide created: January 5, 2026*  
*Last updated: January 5, 2026*  
*Next review: February 2026*
