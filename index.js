/**
 * 码农模式 (Coder Mode) — 一个 Host-only 的 DSH 插件。
 *
 * 它做三件事：
 *   1. 注册一段策略系统提示：项目/杂项判定与"向上查找要许可"、引擎/框架问题先查官方来源、
 *      找不到就说不知道、缺失与断链直说、破坏性改动前先备份。
 *   2. 每步注入一条运行时上下文：会话工作目录 + 探测到的项目类型/项目根/版本线索 + 官方地址。
 *   3. 注册两个工具：`coder_project_probe`（形态探测，向上查找需 consent）与
 *      `coder_backup`（改动前备份，只复制不改原文件）。
 *
 * 这里不 import 任何 `@deepseek-ai/*` 包：profile 安装的 bundle 由 Loader 直接加载，
 * 无法保证能解析到 Harness 自己的依赖树，所以只用 node: 内置模块与 ctx 提供的服务。
 *
 * @module dsh-coder-mode
 */
import { constants } from 'node:fs';
import { copyFile, cp, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { backupDescription, backupResultText, policyText, probeDescription, probeResultText, workspaceContextText } from './policy.js';
import { COMMAND_HINT, PROJECTION_KEY, alreadyText, commandDescription, createModeProjection, effectiveActive, invalidText, parseToggle, statusText, switchText } from './mode.js';
import { messageOf, scanAncestors, scanForProjects } from './rules.js';

/** Cordis 插件名。 */
export const name = 'coder-mode';

/** 依赖的 Host 服务：工具注册表与系统提示注册表。 */
export const inject = ['tools', 'systemPrompt'];

/** 策略段在系统提示里的位置：紧跟 PLAN_POLICY(500)/TEAM_POLICY(600) 之后，早于所有工具段。 */
const POLICY_SECTION_ORDER = 700;

/** 运行时上下文的位置：与沙箱(110)/审批(115)策略相邻。 */
const WORKSPACE_CONTEXT_ORDER = 125;

/** 插件默认配置。 */
const DEFAULTS = {
  /** 文案语言：`zh` 或 `en`。 */
  language: 'zh',
  /** 新会话是否默认处于码农模式；默认关，用 `/coder on` 打开。 */
  enabledByDefault: false,
  /** 开关命令名（不带斜杠）。 */
  command: 'coder',
  /** 是否注册码农模式策略段（仅在模式生效的会话里出现）。 */
  policySection: true,
  /** 是否每步注入工作区事实上下文（仅在模式生效的会话里出现）。 */
  workspaceContext: true,
  /** 是否注册 coder_project_probe / coder_backup 工具（始终可用，不受模式开关影响）。 */
  tools: true,
  /** 工作目录向下扫描层数。 */
  scanDepth: 2,
  /** 单次扫描读取目录数上限。 */
  maxScanDirs: 80,
  /** 向上查找时最多上溯层数。 */
  parentLevels: 8,
  /** 同一会话缓存的扫描结果多久后重新计算（毫秒）。 */
  refreshMs: 60000,
  /** 备份根目录；空串表示 `<系统临时目录>/dsh-coder-mode/<会话>`。 */
  backupDir: ''
};

/**
 * 校验并补全插件配置（Standard Schema，Cordis 直接调用 `~standard.validate`）。
 * @param raw 行配置里的原始值。
 * @returns `{ value }` 或 `{ issues }`。
 */
function validate(raw) {
  const value = { ...DEFAULTS };
  if (raw === undefined || raw === null) return { value };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ message: 'coder-mode config must be an object' }] };
  }
  const issues = [];
  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
      issues.push({ message: `unknown config key \`${key}\``, path: [key] });
    }
  }
  if (raw.language !== undefined) {
    if (raw.language === 'zh' || raw.language === 'en') value.language = raw.language;
    else issues.push({ message: 'language must be "zh" or "en"', path: ['language'] });
  }
  for (const key of ['enabledByDefault', 'policySection', 'workspaceContext', 'tools']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] === 'boolean') value[key] = raw[key];
    else issues.push({ message: `${key} must be a boolean`, path: [key] });
  }
  if (raw.command !== undefined) {
    if (typeof raw.command === 'string' && /^[a-z][a-z0-9_-]*$/.test(raw.command)) value.command = raw.command;
    else issues.push({ message: 'command must be a lowercase command name like "coder"', path: ['command'] });
  }
  const integers = {
    scanDepth: [0, 6],
    maxScanDirs: [1, 2000],
    parentLevels: [1, 64],
    refreshMs: [0, 3600000]
  };
  for (const [key, range] of Object.entries(integers)) {
    if (raw[key] === undefined) continue;
    if (Number.isInteger(raw[key]) && raw[key] >= range[0] && raw[key] <= range[1]) value[key] = raw[key];
    else issues.push({ message: `${key} must be an integer in [${range[0]}, ${range[1]}]`, path: [key] });
  }
  if (raw.backupDir !== undefined) {
    if (typeof raw.backupDir === 'string') value.backupDir = raw.backupDir;
    else issues.push({ message: 'backupDir must be a string', path: ['backupDir'] });
  }
  if (issues.length > 0) return { issues };
  return { value };
}

/** 行配置的运行时 schema。 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-coder-mode',
    validate
  }
};

/**
 * 取会话工作目录。
 * @param agent 目标 Agent（可能为空）。
 * @returns 绝对路径。
 */
function agentCwd(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
}

/** child 是否位于 parent 之内（含相等）。 */
function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 备份目标目录里的相对路径；工作目录之外的源文件落到 `_external/<盘符>/...`。 */
function backupRelative(cwd, source) {
  const absolute = path.resolve(source);
  const relative = path.relative(path.resolve(cwd), absolute);
  if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  const parsed = path.parse(absolute);
  const volume = parsed.root.replace(/[^a-zA-Z0-9]/g, '') || 'root';
  const parts = absolute.slice(parsed.root.length).split(/[\\/]+/).filter((part) => part !== '');
  return path.join('_external', volume, ...parts);
}

/** 生成人类可读的时间戳，用于备份目录名。 */
function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * 建立一个按 Agent 缓存的工作区扫描器。
 * @param config 已校验配置。
 * @param logger 可选的 Cordis logger。
 * @returns `{ get, put, forget, clear }`。
 */
function createWorkspaceCache(config, logger) {
  const entries = new Map();
  const scanNow = (cwd, depth) => {
    try {
      return scanForProjects(cwd, { depth, maxDirs: config.maxScanDirs });
    } catch (error) {
      return { root: cwd, scanned: 0, truncated: false, found: [], errors: [{ dir: cwd, message: messageOf(error) }] };
    }
  };
  const warn = (text) => {
    if (typeof logger?.warn === 'function') logger.warn(text);
  };
  return {
    get(agent) {
      const key = String(agent?.id ?? 'global');
      const cwd = agentCwd(agent);
      const now = Date.now();
      const cached = entries.get(key);
      if (cached !== undefined && cached.cwd === cwd && now - cached.at < config.refreshMs) return cached;
      const depth = config.scanDepth;
      const snapshot = {
        cwd,
        depth,
        at: now,
        scan: scanNow(cwd, depth),
        ...(cached !== undefined && cached.cwd === cwd && cached.ancestors !== undefined ? { ancestors: cached.ancestors } : {})
      };
      entries.set(key, snapshot);
      return snapshot;
    },
    put(agent, snapshot) {
      const key = String(agent?.id ?? 'global');
      entries.set(key, snapshot);
      return snapshot;
    },
    peek(agent) {
      return entries.get(String(agent?.id ?? 'global'));
    },
    forget(id) {
      entries.delete(String(id));
    },
    clear() {
      entries.clear();
    },
    warn
  };
}

/**
 * 合并两次扫描结果：按目录取并集，绝不因为一次更浅的扫描而丢掉已发现的项目标记。
 * @param base 已有扫描（配置深度）。
 * @param extra 新扫描（可能更浅）。
 * @returns 合并后的扫描结果。
 */
function mergeScans(base, extra) {
  const hits = new Map();
  for (const hit of base?.found ?? []) hits.set(String(hit.dir).toLowerCase(), hit);
  for (const hit of extra?.found ?? []) hits.set(String(hit.dir).toLowerCase(), hit);
  const failures = new Map();
  for (const failure of base?.errors ?? []) failures.set(String(failure.dir).toLowerCase(), failure);
  for (const failure of extra?.errors ?? []) failures.set(String(failure.dir).toLowerCase(), failure);
  return {
    root: base?.root ?? extra?.root,
    scanned: Math.max(base?.scanned ?? 0, extra?.scanned ?? 0),
    truncated: base?.truncated === true || extra?.truncated === true,
    found: [...hits.values()],
    errors: [...failures.values()]
  };
}

/**
 * 注册 `coder_project_probe`。
 * @param ctx 插件上下文。
 * @param config 已校验配置。
 * @param cache 工作区缓存。
 */
function registerProbeTool(ctx, config, cache) {
  const language = config.language;
  ctx.effect(() => ctx.tools.register({
    name: 'coder_project_probe',
    description: probeDescription(language),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: {
          type: 'string',
          description: '要探测的目录；省略时为会话工作目录。相对路径按会话工作目录解析。'
        },
        includeParents: {
          type: 'boolean',
          description: '是否向上层目录查找项目根。为 true 时必须同时传 consent:true，否则不会执行任何上溯。'
        },
        consent: {
          type: 'boolean',
          description: '用户已明确同意向上层目录查找。只有在你用 ask_user_question 拿到同意后才能设为 true。'
        },
        depth: {
          type: 'integer',
          description: '向下扫描层数，0 表示只看该目录本身；省略时用插件配置 scanDepth。'
        },
        parentLevels: {
          type: 'integer',
          description: '向上扫描层数；省略时用插件配置 parentLevels。'
        }
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { text: { type: 'string', description: '人类可读的探测报告。' } }
      },
      render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '' }]
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '探测项目形态',
      kind: 'read',
      rawInput: args
    }),
    async execute(args, exec) {
      const agent = exec.agent;
      const cwd = agentCwd(agent);
      const requested = typeof args?.path === 'string' && args.path.trim() !== '' ? args.path.trim() : '';
      const target = requested === '' ? cwd : path.resolve(cwd, requested);
      const depth = Number.isInteger(args?.depth) && args.depth >= 0 ? args.depth : config.scanDepth;
      const parentLevels = Number.isInteger(args?.parentLevels) && args.parentLevels > 0
        ? args.parentLevels
        : config.parentLevels;
      let info;
      try {
        info = await stat(target);
      } catch (error) {
        throw new Error(language === 'en'
          ? `coder_project_probe: unreadable path (${target}): ${messageOf(error)}`
          : `coder_project_probe：路径不可读（${target}）：${messageOf(error)}`);
      }
      if (!info.isDirectory()) {
        throw new Error(language === 'en'
          ? `coder_project_probe: ${target} is not a directory; pass a directory path.`
          : `coder_project_probe：${target} 不是目录，请传目录路径。`);
      }
      const scan = scanForProjects(target, { depth, maxDirs: config.maxScanDirs });
      const includeParents = args?.includeParents === true;
      const consent = args?.consent === true;
      if (includeParents && !consent) {
        const blocked = {
          needsConsent: true,
          cwd,
          target,
          depth,
          parentOf: path.dirname(target),
          scan
        };
        const text = probeResultText(blocked, language);
        return {
          text,
          status: 'consent-required',
          target,
          parentOf: path.dirname(target),
          scanned: scan.scanned,
          found: scan.found.map((hit) => ({ root: hit.dir, matches: hit.matches.map((match) => match.label) }))
        };
      }
      const ancestors = includeParents ? scanAncestors(target, parentLevels) : undefined;
      const escapesWorkingDirectory = !isInside(cwd, target);
      const result = { cwd, target, depth, scan, ancestors, escapesWorkingDirectory };
      const text = probeResultText(result, language);
      if (agent !== undefined && path.resolve(target).toLowerCase() === path.resolve(cwd).toLowerCase()) {
        const cached = cache.peek(agent);
        const reusable = cached !== undefined && cached.cwd === cwd ? cached : undefined;
        const usedDefaultDepth = !Number.isInteger(args?.depth);
        // 只有用配置深度扫出来的结果才整体替换缓存；更浅的一次探测只能补充，不能把
        // 上下文降级成"未发现项目标记"（否则模型会拿到与配置深度不符的工作区事实）。
        const merged = usedDefaultDepth || reusable === undefined
          ? scan
          : mergeScans(reusable.scan, scan);
        // 上下文里的"N 层"必须与真正产生这批命中结果的扫描深度一致。
        const labelDepth = usedDefaultDepth
          ? config.scanDepth
          : Math.max(depth, reusable?.depth ?? 0);
        const keptAncestors = ancestors ?? reusable?.ancestors;
        cache.put(agent, {
          cwd,
          depth: labelDepth,
          at: Date.now(),
          scan: merged,
          ...(keptAncestors === undefined ? {} : { ancestors: keptAncestors })
        });
      }
      return {
        text,
        status: scan.found.length === 0 ? 'no-known-project-marker' : 'project',
        target,
        scanned: scan.scanned,
        truncated: scan.truncated,
        escapesWorkingDirectory,
        found: scan.found.map((hit) => ({
          root: hit.dir,
          matches: hit.matches.map((match) => ({
            id: match.id,
            label: match.label,
            kind: match.kind,
            ...(match.version === undefined ? {} : { version: match.version }),
            docs: match.docs,
            ...(match.repo === undefined ? {} : { repo: match.repo })
          }))
        })),
        errors: scan.errors,
        ...(ancestors === undefined ? {} : {
          ancestors: ancestors.map((entry) => ({
            dir: entry.dir,
            vcs: entry.vcs,
            matches: entry.matches.map((match) => match.label),
            ...(entry.error === undefined ? {} : { error: entry.error })
          }))
        })
      };
    }
  }), 'coder-mode: coder_project_probe');
}

/**
 * 注册 `coder_backup`。
 * @param ctx 插件上下文。
 * @param config 已校验配置。
 */
function registerBackupTool(ctx, config) {
  const language = config.language;
  ctx.effect(() => ctx.tools.register({
    name: 'coder_backup',
    description: backupDescription(language),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paths: {
          type: 'array',
          description: '要备份的文件或目录；相对路径按会话工作目录解析。',
          items: { type: 'string', description: '一个文件或目录路径。' }
        },
        reason: {
          type: 'string',
          description: '为什么要备份（写入备份清单，便于以后恢复时判断）。'
        }
      },
      required: ['paths']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          text: { type: 'string', description: '人类可读的备份报告。' },
          root: { type: 'string', description: '本次备份目录。' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '' }]
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '备份文件',
      kind: 'other',
      rawInput: args,
      locations: Array.isArray(args?.paths)
        ? args.paths.filter((item) => typeof item === 'string').map((item) => ({ path: item }))
        : undefined
    }),
    async execute(args, exec) {
      const agent = exec.agent;
      const cwd = agentCwd(agent);
      const requested = Array.isArray(args?.paths)
        ? args.paths.filter((item) => typeof item === 'string' && item.trim() !== '')
        : [];
      if (requested.length === 0) {
        throw new Error(language === 'en'
          ? 'coder_backup: `paths` needs at least one non-empty path.'
          : 'coder_backup：paths 至少需要一个非空路径。');
      }
      const reason = typeof args?.reason === 'string' ? args.reason : '';
      const sessionKey = String(agent?.id ?? 'session').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 24) || 'session';
      const root = config.backupDir !== ''
        ? path.resolve(cwd, config.backupDir)
        : path.join(tmpdir(), 'dsh-coder-mode', sessionKey);
      const destDir = path.join(root, timestamp());
      const backups = [];
      const failures = [];
      const covered = [];
      const segments = (value) => value.split(/[\\/]+/).filter((part) => part !== '').length;
      // 浅路径先处理：父目录被完整备份后，其中的子项不再重复复制。
      const ordered = requested.slice().sort((left, right) => segments(left) - segments(right));
      for (const entry of ordered) {
        const source = path.resolve(cwd, entry);
        try {
          if (isInside(root, source)) {
            failures.push({ path: source, error: language === 'en' ? 'refusing to back up the backup directory itself' : '拒绝把备份目录自身再备份一遍' });
            continue;
          }
          const info = await stat(source);
          const duplicate = backups.find((item) => item.source.toLowerCase() === source.toLowerCase());
          const coveredBy = backups.find((item) => item.kind === 'directory' && isInside(item.source, source));
          const already = duplicate ?? coveredBy;
          if (already !== undefined) {
            covered.push({ path: source, by: already.source });
            continue;
          }
          const dest = path.join(destDir, backupRelative(cwd, source));
          await mkdir(path.dirname(dest), { recursive: true });
          if (info.isDirectory()) {
            await cp(source, dest, { recursive: true, errorOnExist: true, force: false });
          } else {
            await copyFile(source, dest, constants.COPYFILE_EXCL);
          }
          backups.push({ source, backup: dest, kind: info.isDirectory() ? 'directory' : 'file' });
        } catch (error) {
          failures.push({ path: source, error: messageOf(error) });
        }
      }
      const manifest = [
        '码农模式备份清单 / Coder Mode backup manifest',
        `时间 / time: ${new Date().toISOString()}`,
        `会话 / session: ${String(agent?.id ?? 'unknown')}`,
        `工作目录 / cwd: ${cwd}`,
        `原因 / reason: ${reason === '' ? '(未填写 / not provided)' : reason}`,
        '',
        '条目 / entries:',
        ...(backups.length === 0
          ? ['  (none)']
          : backups.map((item) => `  ${item.source} -> ${item.backup} (${item.kind})`)),
        '',
        '失败 / failures:',
        ...(failures.length === 0
          ? ['  (none)']
          : failures.map((item) => `  ${item.path}: ${item.error}`)),
        '',
        '同一备份内被父目录覆盖、未重复复制 / covered by a parent directory in the same backup:',
        ...(covered.length === 0
          ? ['  (none)']
          : covered.map((item) => `  ${item.path} (covered by ${item.by})`)),
        '',
        '只复制原文件，未修改源文件。/ Copies only; originals were not modified.'
      ].join('\n');
      try {
        await mkdir(destDir, { recursive: true });
        await writeFile(path.join(destDir, 'BACKUP-MANIFEST.txt'), manifest, 'utf8');
      } catch (error) {
        failures.push({ path: path.join(destDir, 'BACKUP-MANIFEST.txt'), error: messageOf(error) });
      }
      const result = { root: destDir, backups, failures, covered, reason };
      return {
        text: backupResultText(result, language),
        root: destDir,
        backedUp: backups.map((item) => ({ source: item.source, backup: item.backup, kind: item.kind })),
        coveredByParent: covered.map((item) => ({ source: item.path, by: item.by })),
        failures
      };
    }
  }), 'coder-mode: coder_backup');
}

/**
 * 注册码农模式：可选模式的开关、策略段、工作区上下文与工具。
 *
 * 模式默认关（`enabledByDefault`），状态折叠自会话日志里的 `/coder on|off` 命令记录，
 * 所以 resume / fork 后仍然保持。策略段与工作区上下文只在模式生效的会话里出现；
 * 两个工具始终可用（与 plan mode 一样，模式只切换提示词，不切换工具目录）。
 *
 * @param ctx 插件上下文（Host 根上下文）。
 * @param rawConfig 行配置。
 */
export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
  const language = config.language;
  const cache = createWorkspaceCache(config, ctx.logger);

  // 没有 projection 服务时的退化语义：按配置的默认值静态判定。
  let modeActiveFor = () => config.enabledByDefault === true;

  ctx.inject(['sessionProjections'], (scope) => {
    scope.effect(() => scope.sessionProjections.register(createModeProjection({
      commandName: config.command,
      enabledByDefault: config.enabledByDefault
    })), 'coder-mode: mode projection');

    modeActiveFor = (session) => {
      const state = scope.sessionProjections.stateOf(session, PROJECTION_KEY);
      return state === undefined ? config.enabledByDefault === true : effectiveActive(state);
    };

    if (config.policySection !== false) {
      scope.effect(() => scope.systemPrompt.section({
        name: 'coder-mode:policy',
        order: POLICY_SECTION_ORDER,
        text: (context) => {
          const agent = context?.agent;
          if (agent === undefined || !modeActiveFor(agent.session)) return '';
          return policyText(language);
        }
      }), 'coder-mode: policy section');
    }

    if (config.workspaceContext !== false) {
      scope.effect(() => scope.systemPrompt.context({
        name: 'coder-mode:workspace',
        order: WORKSPACE_CONTEXT_ORDER,
        text: (context) => {
          const agent = context?.agent;
          if (agent === undefined) return '';
          try {
            if (!modeActiveFor(agent.session)) return '';
            return workspaceContextText(cache.get(agent), language);
          } catch (error) {
            cache.warn(`coder-mode: workspace context failed: ${messageOf(error)}`);
            return '';
          }
        }
      }), 'coder-mode: workspace context');
    }
  });

  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
    cache.forget(agent.id);
  }), 'coder-mode: workspace cache eviction');
  ctx.effect(() => () => cache.clear(), 'coder-mode: workspace cache');

  ctx.inject(['commands'], (scope) => {
    scope.effect(() => scope.commands.register({
      definitionId: 'dsh-coder-mode',
      name: config.command,
      description: commandDescription(language),
      input: { hint: COMMAND_HINT },
      handler: ({ agent, rawInput }) => {
        const parsed = parseToggle(rawInput);
        if (parsed.kind === 'invalid') return { kind: 'error', text: invalidText(parsed.rawInput, language) };
        const session = agent?.session;
        const current = session === undefined ? config.enabledByDefault === true : modeActiveFor(session);
        if (parsed.kind === 'status') return { kind: 'success', text: statusText(current, language) };
        if (parsed.wanted === current) return { kind: 'success', text: alreadyText(current, language) };
        return { kind: 'success', text: switchText(parsed.wanted, language) };
      }
    }), 'coder-mode: toggle command');
  });

  if (config.tools !== false) {
    registerProbeTool(ctx, config, cache);
    registerBackupTool(ctx, config);
  }
}
