/**
 * 码农模式 (Coder Mode) — 模型可见的文案：策略段、工具描述、运行时上下文与工具输出。
 *
 * 这里全部是纯函数（给定数据 → 字符串），不读文件、不依赖 Harness 包。
 */
import path from 'node:path';

/** 中文策略段：码农模式的 5 条约定。 */
export const POLICY_ZH = `# 码农模式（Coder Mode）

事实优先于猜测：读到过的文件、访问过的官方页面才算证据；没读到的东西一律标为未知。

## 1. 工作区形态：项目 / 杂项
- 先判断工作区是「完整项目」还是「杂项文件 / 单文件」。项目证据 = 项目清单文件（project.godot、package.json、*.uproject、Cargo.toml、pyproject.toml、go.mod、CMakeLists.txt…）或版本库根（.git）。
- 没有项目证据时，先问用户："工作区里没看到项目标记，是否允许我向上层目录查找项目根？" 得到同意后才上溯（调用 coder_project_probe 并传 includeParents:true, consent:true）；没同意就绝不上溯。
- 未获同意、或本来就缺少被引用的文件（模块、场景、配置、资源、脚本）时，不要凭空补内容：直接列出缺什么，并问用户要路径或内容。

## 2. 引擎 / 框架问题：先查官方来源
- 用户提到引擎或框架时，先确认项目真正使用的版本（project.godot、ProjectSettings/ProjectVersion.txt、pubspec.yaml、Cargo.lock、package.json…）；版本是答案的一部分，不要跨版本套用。
- 检索顺序：官方文档 → 官方仓库（源码 / issue / PR / changelog）→ 官方 API 参考。运行时上下文已列出该项目对应的官方地址，用 web_fetch 直接读官方页面。
- 不采信：博客、CSDN / 知乎 / 掘金 / 论坛转述、AI 摘要、二手教程。只有当它们明确指向官方来源时才引用，并引用官方那一处；第三方与官方冲突时以官方为准。

## 3. 找不到就直说"不知道"
- 官方来源里没找到时，回答"官方文档没有说明 / 我不知道"，不要用可信度低的推断冒充答案。
- 同时给出四件事：①已检索的具体来源（URL 或仓库内路径）；②已排除的可能；③关键线索与仍不确定的点；④建议去哪里找（官方 issue 区、官方论坛 / Discord、引擎源码、本机安装目录、官方支持），或用 ask_user_question 直接问用户要资料。
- 严禁编造 API 名、函数签名、参数、默认值、版本行为；写代码前若某 API 未被官方来源或项目源码证实，先声明"未证实"再写。

## 4. 缺失与断链必须直说
- 缺的资源（贴图 / 字体 / 模型 / 插件 / 依赖 / 凭证 / 密钥）、断掉的链路（引用指向不存在的路径、导入失败、版本不匹配、没有权限或服务器）、没找到的东西，都要单独列出来，不要绕过去继续。
- 报告格式：缺失项 / 期望位置 / 实际观察 / 影响 / 需要用户做什么。

## 5. 破坏性改动前先备份
- 在可能不可逆或难以还原的改动前（批量替换、大规模重写、生成或覆盖资源、删文件、改引擎配置文件、格式迁移），先用 coder_backup 备份涉及的文件或目录，再动手，并在回答里写明备份位置。
- coder_backup 只复制、不改原文件；备份失败就停下破坏性操作，把失败原因说出来。
- 备份不等于许可：破坏性操作本身仍需用户确认。

## 工具
- coder_project_probe：扫描目录识别项目类型、项目根、引擎/框架版本线索，并给出官方文档与仓库地址；向上查找必须先拿到用户同意（consent:true）。
- coder_backup：把文件/目录复制到会话备份目录（默认系统临时目录），返回备份路径。

## 汇报
- 分开写"已验证"（读过哪个文件、访问过哪个 URL）与"未验证 / 我的推测"。
- 不要用"应该 / 大概 / 通常"掩盖不确定的事实；把它标成不确定，并写清还差什么。`;

/** English policy section: the same five rules. */
export const POLICY_EN = `# Coder Mode

Facts before guesses: only files you actually read and official pages you actually fetched count as evidence. Anything else is unknown.

## 1. Workspace shape: project or loose files
- Decide first whether the workspace is a complete project or miscellaneous / single files. Project evidence = a project manifest (project.godot, package.json, *.uproject, Cargo.toml, pyproject.toml, go.mod, CMakeLists.txt, ...) or a VCS root (.git).
- With no project evidence, ask the user first: "No project marker is visible here - may I search parent directories for the project root?" Only after consent may you walk upward (coder_project_probe with includeParents:true, consent:true). Never walk upward without it.
- Without consent, or whenever a referenced file (module, scene, config, asset, script) is missing, do not invent its content: state exactly what is missing and ask the user for the path or content.

## 2. Engine / framework questions: official sources first
- Identify the version the project actually uses (project.godot, ProjectSettings/ProjectVersion.txt, pubspec.yaml, Cargo.lock, package.json, ...). The version is part of the answer; never apply another version's behavior.
- Search order: official documentation, then the official repository (source / issues / PRs / changelog), then the official API reference. The runtime context lists this project's official locations; fetch those pages directly with web_fetch.
- Do not trust blogs, forum or Q&A reposts, AI summaries, or second-hand tutorials. Cite them only when they point at an official source, and cite that official source instead. Official wins on any conflict.

## 3. When you cannot find it, say "I do not know"
- If the official sources do not answer it, reply that the official documentation does not cover it or that you do not know. Never dress up a low-confidence guess as an answer.
- Also report: (1) the exact sources searched (URL or in-repo path); (2) what you ruled out; (3) the clues you have and what remains uncertain; (4) where to look next (official issue tracker, official forum/Discord, engine source, local installation, vendor support), or ask the user with ask_user_question.
- Never fabricate API names, signatures, parameters, defaults, or version behavior. If an API is not confirmed by an official source or the project's own source, label it unverified before using it.

## 4. Missing pieces and broken links must be stated
- Missing resources (textures, fonts, models, plugins, dependencies, credentials), broken links (references to nonexistent paths, failed imports, version mismatches, missing permissions or servers), and anything you could not find must be listed explicitly instead of being worked around.
- Format: missing item / expected location / actual observation / impact / what the user must do.

## 5. Back up before destructive changes
- Before a possibly irreversible change (mass replace, large rewrite, generated or overwritten assets, file deletion, engine config edits, format migration), back up the affected files or directories with coder_backup, then proceed, and state the backup location in your answer.
- coder_backup only copies; it never modifies the originals. If a backup fails, stop the destructive work and report why.
- A backup is not permission: the destructive change itself still needs user confirmation.

## Tools
- coder_project_probe: scan a directory for project type, project root, and engine/framework version clues, and report official documentation and repository URLs; searching upward requires user consent (consent:true).
- coder_backup: copy files or directories into the session backup directory (system temp by default) and return the backup paths.

## Reporting
- Separate "verified" (which file was read, which URL was fetched) from "unverified / my inference".
- Never hide uncertainty behind "should", "probably", or "usually"; mark it and say what is still missing.`;

/** 工具描述（中文）。 */
const PROBE_DESC_ZH = '扫描一个目录，识别它属于哪种项目、项目根在哪、引擎/框架的版本线索，并给出该技术栈的官方文档与仓库地址；当作"码农模式"的项目形态判定与官方来源入口用。默认只扫描会话工作目录及其子目录。向上层目录查找必须先获得用户同意，否则不会执行（返回 needsConsent）。路径不存在或不可读时直接报错，不猜。';
const BACKUP_DESC_ZH = '在可能不可逆的改动前，把文件或目录复制到会话备份目录，返回备份路径；只复制，不改动原文件。相对路径按会话工作目录解析；失败的条目会逐条报告原因。';

/** 工具描述（英文）。 */
const PROBE_DESC_EN = 'Scan a directory to identify the project type, the project root, engine/framework version clues, and that stack\'s official documentation and repository URLs. Use it as the workspace-shape check and the official-source entry point of Coder Mode. It scans the session working directory and its subdirectories by default. Searching parent directories requires user consent first; without it nothing is scanned and needsConsent is returned. A missing or unreadable path fails loudly instead of guessing.';
const BACKUP_DESC_EN = 'Before a possibly irreversible change, copy files or directories into the session backup directory and return the backup paths. It only copies and never modifies the originals. Relative paths resolve against the session working directory; failures are reported one by one with their reason.';

/**
 * 取策略段文本。
 * @param language `'zh'` 或 `'en'`。
 * @returns 策略段文本。
 */
export function policyText(language) {
  return language === 'en' ? POLICY_EN : POLICY_ZH;
}

/**
 * 取 `coder_project_probe` 的模型可见描述。
 * @param language `'zh'` 或 `'en'`。
 * @returns 工具描述。
 */
export function probeDescription(language) {
  return language === 'en' ? PROBE_DESC_EN : PROBE_DESC_ZH;
}

/**
 * 取 `coder_backup` 的模型可见描述。
 * @param language `'zh'` 或 `'en'`。
 * @returns 工具描述。
 */
export function backupDescription(language) {
  return language === 'en' ? BACKUP_DESC_EN : BACKUP_DESC_ZH;
}

/** 显示用路径：在 cwd 内用相对路径，否则用绝对路径。 */
function displayPath(cwd, target) {
  if (cwd === undefined || cwd === null) return target;
  const relative = path.relative(cwd, target);
  if (relative === '') return '.';
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  return target;
}

/** 把扫描结果摊平成"命中 + 所在目录"的列表。 */
function flattenMatches(scan) {
  const flat = [];
  for (const hit of scan?.found ?? []) {
    for (const match of hit.matches ?? []) flat.push({ ...match, dir: hit.dir });
  }
  return flat;
}

/** 把一处命中整理成两行文本。 */
function matchLines(cwd, match, indent, language) {
  const where = displayPath(cwd, match.dir);
  const markers = match.markers.length > 0 ? match.markers.join('、') : '(无标记)';
  const kindText = match.kind === undefined ? '' : `，${match.kind}`;
  const versionText = match.version === undefined ? '' : (language === 'en' ? `，version clue ${match.version}` : `，版本线索 ${match.version}`);
  const lines = [`${indent}- ${match.label}（根目录 ${where}${kindText}）：${markers}${versionText}`];
  const docs = match.docs ?? [];
  const repo = match.repo;
  if (docs.length === 0 && repo === undefined) {
    lines.push(`${indent}  官方地址未确认：先向用户确认官方文档/仓库，或自行检索官方站点，不要引用未经确认的地址。`);
  } else {
    if (docs.length > 0) lines.push(`${indent}  官方文档：${docs.join(' , ')}`);
    if (repo !== undefined) lines.push(`${indent}  官方仓库：${repo}`);
  }
  for (const hint of match.hints ?? []) lines.push(`${indent}  提醒：${hint}`);
  return lines;
}

/**
 * 渲染每步注入的运行时上下文（工作区事实）。
 * @param snapshot `{ cwd, depth, scan, at }`，见 index.js。
 * @param language `'zh'` 或 `'en'`。
 * @returns 上下文文本；没有任何可用信息时返回空串。
 */
export function workspaceContextText(snapshot, language) {
  if (snapshot === undefined || snapshot === null) return '';
  const { cwd, depth, scan } = snapshot;
  if (cwd === undefined || scan === undefined) return '';
  const zh = language !== 'en';
  const lines = [];
  lines.push(zh ? '【码农模式 · 工作区事实】' : '[Coder Mode - workspace facts]');
  lines.push(zh ? `工作目录：${cwd}` : `Working directory: ${cwd}`);
  if (scan.found.length === 0) {
    lines.push(zh
      ? `形态：未在本目录及其 ${depth} 层子目录内发现项目标记 → 疑似「杂项文件 / 单文件工作区」。`
      : `Shape: no project marker found in this directory or ${depth} level(s) below it - likely a miscellaneous / single-file workspace.`);
    lines.push(zh
      ? '- 需要项目上下文时：先用 ask_user_question 问"是否允许向上层目录查找项目根"，得到同意后才调用 coder_project_probe({ includeParents: true, consent: true })；未获同意不得上溯。'
      : '- When project context is needed: ask the user first whether you may search parent directories for the project root; only after consent call coder_project_probe({ includeParents: true, consent: true }). Never walk upward without it.');
    lines.push(zh
      ? '- 缺少被引用文件的内容时：直接说明缺什么并询问用户，不要猜测。'
      : '- When a referenced file is missing: state exactly what is missing and ask the user; do not guess.');
  } else {
    lines.push(zh
      ? `形态：项目（在本目录及其 ${depth} 层子目录内命中 ${scan.found.length} 处项目标记）。`
      : `Shape: project (${scan.found.length} project marker(s) matched here and within ${depth} level(s) below).`);
    for (const match of flattenMatches(scan)) lines.push(...matchLines(cwd, match, '', language));
    lines.push(zh
      ? '规则：回答该项目涉及的引擎/框架问题前，先核对上面的官方来源（web_fetch 官方页面）；查不到就直说"不知道"，不要用低可信度内容填空。改动可能不可逆时先用 coder_backup 备份。'
      : 'Rule: before answering engine/framework questions about this project, check the official sources above (fetch them with web_fetch). If they do not answer it, say you do not know instead of filling the gap with low-confidence content. Back up with coder_backup before any possibly irreversible change.');
  }
  const ancestors = snapshot.ancestors;
  if (Array.isArray(ancestors)) {
    const hits = ancestors.filter((entry) => (entry.matches ?? []).length > 0);
    if (hits.length > 0) {
      lines.push(zh
        ? '已获用户同意的向上查找（项目根在上层）：'
        : 'Consented upward search (project root found above):');
      for (const entry of hits) {
        for (const match of entry.matches) {
          lines.push(...matchLines(cwd, { ...match, dir: entry.dir }, '  ', language));
        }
      }
    } else {
      lines.push(zh
        ? `已获用户同意的向上查找：上溯 ${ancestors.length} 层未发现项目标记。`
        : `Consented upward search: no project marker within ${ancestors.length} parent level(s).`);
    }
  }
  if (scan.truncated) {
    lines.push(zh
      ? `注意：扫描在 ${scan.scanned} 个目录处达到上限，结果可能不完整。`
      : `Note: scanning stopped at the ${scan.scanned}-directory limit; the result may be incomplete.`);
  }
  if (scan.errors.length > 0) {
    lines.push(zh ? '读取失败的目录（属于缺失/断链，必须如实告知用户）：' : 'Directories that could not be read (missing/broken - report them):');
    for (const failure of scan.errors) lines.push(`  - ${failure.dir}：${failure.message}`);
  }
  return lines.join('\n');
}

/**
 * 渲染 `coder_project_probe` 的结果文本。
 * @param result 探测结果对象。
 * @param language `'zh'` 或 `'en'`。
 * @returns 可直接展示的文本。
 */
export function probeResultText(result, language) {
  const zh = language !== 'en';
  const lines = [];
  if (result.needsConsent === true) {
    lines.push(zh ? '⛔ 未执行向上查找：需要先征得用户同意。' : 'Not executed: searching parent directories needs user consent first.');
    lines.push(zh
      ? `请先用 ask_user_question 询问："是否允许我向上层目录（${result.parentOf} 及更上层）查找项目根？"`
      : `Ask the user first: "May I search parent directories (${result.parentOf} and above) for the project root?"`);
    lines.push(zh
      ? '用户同意后重试：coder_project_probe({ includeParents: true, consent: true })。未获同意不得上溯。'
      : 'After consent, retry with coder_project_probe({ includeParents: true, consent: true }). Never walk upward without it.');
    if (result.scan !== undefined) {
      lines.push(zh
        ? `（本目录及其 ${result.depth} 层子目录内命中 ${result.scan.found.length} 处项目标记）`
        : `(${result.scan.found.length} project marker(s) matched here and within ${result.depth} level(s) below)`);
      for (const match of flattenMatches(result.scan)) lines.push(...matchLines(result.cwd, match, '', language));
    }
    return lines.join('\n');
  }
  lines.push(zh ? `项目形态探测：${result.target}` : `Project probe: ${result.target}`);
  lines.push(zh
    ? `形态：${result.scan.found.length === 0 ? '疑似「杂项文件 / 单文件工作区」（未发现已知项目标记）' : '项目'}`
    : `Shape: ${result.scan.found.length === 0 ? 'likely miscellaneous / single-file (no known project marker)' : 'project'}`);
  lines.push(zh
    ? `扫描：${result.scan.scanned} 个目录（向下 ${result.depth} 层${result.scan.truncated ? '，已达上限，结果可能不完整' : ''}）`
    : `Scanned: ${result.scan.scanned} directories (${result.depth} level(s) down${result.scan.truncated ? ', limit reached, may be incomplete' : ''})`);
  if (result.escapesWorkingDirectory === true) {
    lines.push(zh
      ? `注意：目标目录不在会话工作目录内（${result.cwd}），这是工作目录之外的内容。`
      : `Note: the target is outside the session working directory (${result.cwd}).`);
  }
  if (result.scan.found.length > 0) {
    lines.push(zh ? '命中的项目标记：' : 'Matched project markers:');
    for (const match of flattenMatches(result.scan)) lines.push(...matchLines(result.cwd, match, '', language));
  }
  if (result.scan.errors.length > 0) {
    lines.push(zh ? '读取失败（缺失/断链，必须如实告知用户）：' : 'Read failures (missing/broken - report them):');
    for (const failure of result.scan.errors) lines.push(`  - ${failure.dir}：${failure.message}`);
  }
  const ancestors = result.ancestors;
  if (Array.isArray(ancestors)) {
    if (ancestors.length === 0) {
      lines.push(zh ? '向上查找：已到文件系统根，未发现更多父目录。' : 'Upward search: reached the filesystem root; no further parent directories.');
    } else {
      lines.push(zh ? `向上查找（${ancestors.length} 层）：` : `Upward search (${ancestors.length} level(s)):`);
      for (const entry of ancestors) {
        const where = entry.dir;
        const marks = entry.matches.length > 0
          ? entry.matches.map((match) => `${match.label}（${match.markers.join('、')}${match.version === undefined ? '' : (zh ? `，版本线索 ${match.version}` : `, version ${match.version}`)}）`).join('；')
          : (zh ? '无已知项目标记' : 'no known project marker');
        lines.push(`  - ${where}：${marks}${entry.vcs ? (zh ? '；存在版本库根 .git' : '; VCS root .git present') : ''}`);
        if (entry.error !== undefined) lines.push(`      ${zh ? '读取失败' : 'read failure'}：${entry.error}`);
        for (const match of entry.matches) {
          if ((match.docs ?? []).length > 0) lines.push(`      官方文档：${match.docs.join(' , ')}`);
          if (match.repo !== undefined) lines.push(`      官方仓库：${match.repo}`);
        }
      }
    }
  }
  if (result.scan.found.length === 0 && !Array.isArray(ancestors)) {
    lines.push(zh
      ? '下一步：若需要项目上下文，先问用户是否允许向上查找项目根，再用 includeParents:true, consent:true 重试；否则按缺少文件如实提问。'
      : 'Next: if project context is needed, ask the user before searching parent directories, then retry with includeParents:true, consent:true; otherwise state the missing files and ask.');
  }
  return lines.join('\n');
}

/**
 * 渲染 `coder_backup` 的结果文本。
 * @param result 备份结果对象。
 * @param language `'zh'` 或 `'en'`。
 * @returns 可直接展示的文本。
 */
export function backupResultText(result, language) {
  const zh = language !== 'en';
  const lines = [];
  if (result.backups.length === 0) {
    lines.push(zh ? '⚠️ 没有备份成功任何条目。' : 'No entry was backed up successfully.');
  } else {
    lines.push(zh
      ? `备份完成：${result.backups.length} 项（失败 ${result.failures.length} 项），位置：${result.root}`
      : `Backup complete: ${result.backups.length} item(s) (${result.failures.length} failed), at ${result.root}`);
    for (const item of result.backups) {
      lines.push(`  - ${item.source} → ${item.backup}（${item.kind}）`);
    }
  }
  if (result.failures.length > 0) {
    lines.push(zh ? '失败条目（必须如实告知用户）：' : 'Failed entries (report them):');
    for (const item of result.failures) lines.push(`  - ${item.path}：${item.error}`);
  }
  const covered = result.covered ?? [];
  if (covered.length > 0) {
    lines.push(zh
      ? '以下条目已被同一批备份里的父目录覆盖，未重复复制：'
      : 'These entries were already covered by a parent directory in the same backup:');
    for (const item of covered) lines.push(`  - ${item.path}（${zh ? '已包含在' : 'covered by'} ${item.by}）`);
  }
  if (result.reason !== undefined && result.reason !== '') {
    lines.push(zh ? `说明：${result.reason}` : `Reason: ${result.reason}`);
  }
  lines.push(zh
    ? '备份只复制原文件，原文件未被改动；恢复时把备份路径复制回原路径即可。'
    : 'The backup only copied the originals; restore by copying the backup paths back.');
  return lines.join('\n');
}
