/**
 * 码农模式自检：不需要 Harness 运行时，用桩 ctx 验证注册形状、扫描逻辑、上下文渲染与两个工具。
 * 运行：node test/self-test.mjs [要扫描的目录]
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Config, apply, inject, name } from '../index.js';
import { PROJECTION_KEY, createModeProjection, effectiveActive, parseToggle } from '../mode.js';
import { backupResultText, policyText, probeResultText, workspaceContextText } from '../policy.js';
import { scanAncestors, scanForProjects } from '../rules.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(here);
const scanTarget = process.argv[2] ?? path.resolve(packageRoot, '..');

/**
 * 收集注册结果的桩上下文。实现 `inject` 与一个最小的投影引擎，用于验证
 * "可选模式"的折叠与门禁：`emit()` 把会话事件喂给所有已注册的投影单元。
 */
function createStubContext() {
  const registered = { sections: [], contexts: [], tools: [], events: [], effects: [], commands: [], projections: [] };
  const definitions = new Map();
  const states = new Map();
  const stateFor = (session, key) => {
    const definition = definitions.get(key);
    if (definition === undefined) return undefined;
    let perKey = states.get(session.id);
    if (perKey === undefined) {
      perKey = new Map();
      states.set(session.id, perKey);
    }
    if (!perKey.has(key)) perKey.set(key, definition.init(session.header, 0));
    return perKey.get(key);
  };
  const services = {
    systemPrompt: {
      section(section) {
        registered.sections.push(section);
        return () => {};
      },
      context(context) {
        registered.contexts.push(context);
        return () => {};
      }
    },
    tools: {
      register(definition) {
        registered.tools.push(definition);
        return () => {};
      }
    },
    sessionProjections: {
      register(definition) {
        registered.projections.push(definition);
        definitions.set(definition.key, definition);
        return () => {};
      },
      stateOf(session, key) {
        return stateFor(session, key);
      }
    },
    commands: {
      register(definition) {
        registered.commands.push(definition);
        return () => {};
      }
    }
  };
  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    ...services,
    effect(factory, label) {
      const dispose = factory();
      registered.effects.push({ label, dispose: typeof dispose === 'function' ? dispose : () => {} });
      return () => {};
    },
    on(event, listener) {
      registered.events.push({ event, listener });
      return () => {};
    },
    get(service) {
      return services[service];
    },
    inject(deps, callback) {
      const scope = { ...services, effect: ctx.effect, on: ctx.on, get: ctx.get, logger: ctx.logger };
      callback(scope);
      return () => {};
    }
  };
  registered.emit = (session, event) => {
    for (const definition of definitions.values()) {
      const current = stateFor(session, definition.key);
      states.get(session.id).set(definition.key, definition.apply(current, event));
    }
  };
  return { ctx, registered };
}

/** 构造一个只带 id 与 cwd 的假 Agent。 */
function fakeAgent(cwd, id = 'test-session') {
  return { id, session: { id, header: { cwd } } };
}

/** 假工具执行上下文。 */
function fakeExec(cwd) {
  return { agent: fakeAgent(cwd), signal: new AbortController().signal };
}

let passed = 0;
async function check(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ok - ${label}`);
}

const toolNamed = (tools, toolName) => tools.find((tool) => tool.name === toolName);

console.log('码农模式自检');
console.log(`  插件：${name}，inject=[${inject.join(', ')}]`);

await check('配置默认值与非法值', () => {
  const ok = Config['~standard'].validate({ language: 'en', scanDepth: 1 });
  assert.equal(ok.issues, undefined);
  assert.equal(ok.value.language, 'en');
  assert.equal(ok.value.scanDepth, 1);
  assert.equal(ok.value.maxScanDirs, 80);
  assert.ok(Array.isArray(Config['~standard'].validate({ language: 'fr' }).issues));
  assert.ok(Array.isArray(Config['~standard'].validate({ nope: 1 }).issues));
  assert.equal(Config['~standard'].validate(undefined).value.language, 'zh');
});

const { ctx, registered } = createStubContext();
apply(ctx, {});

await check('注册了 1 个投影、1 条命令、1 个策略段、1 个上下文、2 个工具', () => {
  assert.equal(registered.projections.length, 1);
  assert.equal(registered.projections[0].key, PROJECTION_KEY);
  assert.equal(registered.commands.length, 1);
  assert.equal(registered.commands[0].name, 'coder');
  assert.equal(registered.sections.length, 1);
  assert.equal(registered.sections[0].name, 'coder-mode:policy');
  assert.ok(policyText('zh').length > 200);
  assert.equal(registered.contexts.length, 1);
  assert.equal(registered.contexts[0].name, 'coder-mode:workspace');
  assert.deepEqual(registered.tools.map((tool) => tool.name).sort(), ['coder_backup', 'coder_project_probe']);
  assert.ok(registered.events.some((entry) => entry.event === 'agent/disposed'));
});

await check('配置：模式默认值、命令名校验', () => {
  const value = Config['~standard'].validate({}).value;
  assert.equal(value.enabledByDefault, false);
  assert.equal(value.command, 'coder');
  assert.equal(Config['~standard'].validate({ enabledByDefault: true }).value.enabledByDefault, true);
  assert.equal(Config['~standard'].validate({ command: 'code-mode' }).value.command, 'code-mode');
  assert.ok(Array.isArray(Config['~standard'].validate({ command: 'Coder Mode' }).issues));
  assert.ok(Array.isArray(Config['~standard'].validate({ enabledByDefault: 'yes' }).issues));
});

await check('模式：/coder 参数解析', () => {
  assert.deepEqual(parseToggle(''), { kind: 'set', wanted: true });
  assert.deepEqual(parseToggle(' ON '), { kind: 'set', wanted: true });
  assert.deepEqual(parseToggle('off'), { kind: 'set', wanted: false });
  assert.deepEqual(parseToggle('status'), { kind: 'status' });
  assert.equal(parseToggle('onx').kind, 'invalid');
});

await check('模式：投影折叠只认本命令，忽略的事件返回同一引用', () => {
  const projection = createModeProjection({ commandName: 'coder', enabledByDefault: false });
  const initial = projection.init({ cwd: scanTarget }, 0);
  assert.equal(effectiveActive(initial), false);
  assert.equal(projection.apply(initial, { type: 'turn/start', data: { turn: 1 } }), initial);
  assert.equal(projection.apply(initial, { type: 'command/run', data: { commandId: 'c1', name: 'plan', args: '' } }), initial);
  const queued = projection.apply(initial, { type: 'command/run', data: { commandId: 'c1', name: 'coder', args: 'on' } });
  assert.equal(effectiveActive(queued), true, '命令已进入但未落定时按用户意图生效');
  const active = projection.apply(queued, { type: 'command/done', data: { commandId: 'c1', kind: 'success' } });
  assert.equal(active.active, true);
  assert.equal(active.running, null);
  assert.equal(
    projection.apply(active, { type: 'command/run', data: { commandId: 'c2', name: 'coder', args: 'status' } }),
    active,
    'status 不应改变状态'
  );
  const failing = projection.apply(active, { type: 'command/run', data: { commandId: 'c3', name: 'coder', args: 'off' } });
  const settled = projection.apply(failing, { type: 'command/done', data: { commandId: 'c3', kind: 'error', text: 'boom' } });
  assert.equal(settled.active, true, '命令失败不应翻转状态');
  assert.equal(settled.running, null);
  assert.equal(projection.stateSchema.parse(active), active);
  assert.deepEqual(projection.wire.view(active), { active: true, pending: false });
  assert.equal(projection.wire.viewSchema.parse({ active: false, pending: true }).pending, true);
  assert.throws(() => projection.stateSchema.parse({ active: 'yes', running: null }));
});

await check('模式：命令 + 门禁（默认关 → 开 → 关）', () => {
  const stub = createStubContext();
  apply(stub.ctx, {});
  const agent = fakeAgent(scanTarget, 'mode-session');
  const section = () => stub.registered.sections[0].text({ agent });
  const context = () => stub.registered.contexts[0].text({ agent });
  assert.equal(section(), '', '默认关时不应注入策略段');
  assert.equal(context(), '', '默认关时不应注入工作区事实');
  const command = stub.registered.commands[0];
  assert.match(command.handler({ agent, rawInput: 'status' }).text, /已关闭/);
  assert.equal(command.handler({ agent, rawInput: 'nope' }).kind, 'error');
  assert.equal(command.handler({ agent, rawInput: 'on' }).kind, 'success');
  stub.registered.emit(agent.session, { type: 'command/run', data: { commandId: 'k1', name: 'coder', args: 'on' } });
  stub.registered.emit(agent.session, { type: 'command/done', data: { commandId: 'k1', kind: 'success' } });
  assert.ok(section().includes('码农模式'), section());
  assert.ok(context().includes('工作目录'), context());
  assert.match(command.handler({ agent, rawInput: 'on' }).text, /已经是开启/);
  stub.registered.emit(agent.session, { type: 'command/run', data: { commandId: 'k2', name: 'coder', args: 'off' } });
  stub.registered.emit(agent.session, { type: 'command/done', data: { commandId: 'k2', kind: 'success' } });
  assert.equal(section(), '');
  assert.equal(context(), '');
  assert.match(command.handler({ agent, rawInput: 'status' }).text, /已关闭/);
});

await check('模式：enabledByDefault=true 时开箱即用', () => {
  const stub = createStubContext();
  apply(stub.ctx, { enabledByDefault: true });
  const agent = fakeAgent(scanTarget, 'default-on-session');
  assert.ok(stub.registered.sections[0].text({ agent }).includes('码农模式'));
  assert.ok(stub.registered.contexts[0].text({ agent }).includes('工作目录'));
});

await check('客户端模块：工厂 id / 插槽 / 命令 / 投影 key 与 Host 一致', () => {
  const source = readFileSync(path.join(packageRoot, 'client.js'), 'utf8');
  assert.ok(source.includes("id: 'dsh-coder-mode'"));
  assert.ok(source.includes("window.__ModuleLoader__.load"));
  assert.ok(source.includes("'conversation.input.left'"));
  assert.ok(source.includes('ctx.remote.commands.execute'));
  assert.ok(source.includes(`PROJECTION_KEY = '${PROJECTION_KEY}'`));
  assert.ok(source.includes("COMMAND = 'coder'"));
  assert.ok(source.includes('--dsw-alias-'), '必须使用主题 token');
  assert.ok(!source.includes('document.body'), '不得操作 document.body');
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.ok(manifest.files.includes('client.js'));
});

await check('工具定义带有合法的 output 与 parameters', () => {
  for (const tool of registered.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(typeof tool.output?.render, 'function');
    assert.equal(tool.output?.schema?.type, 'object');
    assert.equal(tool.parameters?.type, 'object');
    assert.equal(typeof tool.execute, 'function');
  }
});

await check('客户端模块：浏览器模块可加载、注册插槽、组件发出正确命令', async () => {
  const previousWindow = globalThis.window;
  let captured;
  globalThis.window = { __ModuleLoader__: { load: (options) => { captured = options; } } };
  try {
    await import(`${pathToFileURL(path.join(packageRoot, 'client.js')).href}?self-test=${Date.now()}`);
  } finally {
    globalThis.window = previousWindow;
  }
  assert.equal(captured.id, 'dsh-coder-mode');
  assert.equal(typeof captured.factory, 'function');
  const react = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (initial) => [initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {}
  };
  const moduleExports = captured.factory((specifier) => {
    if (specifier === 'react') return react;
    throw new Error(`unexpected require: ${specifier}`);
  });
  assert.deepEqual(moduleExports.inject, ['slots', 'remote', 'remote.commands', 'locale']);

  const calls = [];
  const slots = {
    injectedKey: null,
    registrations: [],
    inject(key, callback) {
      this.injectedKey = key;
      callback();
      return () => {};
    },
    register(options, component) {
      this.registrations.push({ options, component });
      return () => {};
    }
  };
  const locale = {
    dicts: null,
    register(namespace, dictionaries) {
      this.dicts = { namespace, dictionaries };
      return () => {};
    },
    bind() {
      return (key) => key;
    }
  };
  const clientCtx = {
    effect: (factory) => {
      factory();
      return () => {};
    },
    slots,
    locale,
    remote: {
      commands: {
        async execute(...args) {
          calls.push(args);
          return { ok: true, value: { result: { kind: 'success' } } };
        }
      }
    }
  };
  moduleExports.apply(clientCtx);
  assert.equal(slots.injectedKey, 'conversation.input.left');
  assert.equal(slots.registrations.length, 1);
  assert.equal(slots.registrations[0].options.id, 'coder-mode');
  assert.ok(locale.dicts.dictionaries.zh !== undefined && locale.dicts.dictionaries.en !== undefined);

  const component = slots.registrations[0].component;
  const tree = component({
    useProjection: (key) => (key === PROJECTION_KEY ? { active: true, pending: false } : undefined),
    sessionId: 'session-1'
  });
  const button = tree.children.find((child) => child.type === 'button');
  assert.ok(button !== undefined, '组件应渲染一个 button');
  assert.equal(button.props['aria-pressed'], true);
  assert.equal(button.props.disabled, false);
  assert.equal(button.props.className.includes('is-on'), true);
  button.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls[0], ['session-1', '/coder off', []]);

  // 关闭状态下点击应发出 /coder on
  const offTree = component({
    useProjection: (key) => (key === PROJECTION_KEY ? { active: false, pending: false } : undefined),
    sessionId: 'session-2'
  });
  const offButton = offTree.children.find((child) => child.type === 'button');
  assert.equal(offButton.props['aria-pressed'], false);
  offButton.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls[1], ['session-2', '/coder on', []]);

  // 投影还没到达（undefined）时按关闭渲染，不崩
  const blankTree = component({ useProjection: () => undefined, sessionId: 'session-3' });
  assert.equal(blankTree.children.find((child) => child.type === 'button').props['aria-pressed'], false);
});

await check(`扫描 ${scanTarget} 能识别出项目标记`, () => {
  const scan = scanForProjects(scanTarget, { depth: 2, maxDirs: 80 });
  assert.ok(scan.scanned > 0);
  assert.equal(scan.errors.length, 0, `扫描报错：${JSON.stringify(scan.errors)}`);
  assert.ok(scan.found.length > 0, '未发现任何项目标记');
  const labels = scan.found.flatMap((hit) => hit.matches.map((match) => match.label));
  assert.ok(labels.includes('Godot Engine'), `命中的标记：${labels.join(', ')}`);
  const entry = scan.found
    .flatMap((hit) => hit.matches.map((match) => ({ dir: hit.dir, match })))
    .find((item) => item.match.id === 'godot');
  const declared = readFileSync(path.join(entry.dir, 'project.godot'), 'utf8')
    .match(/config\/features=PackedStringArray\(\s*"([^"]+)"/)[1];
  assert.equal(entry.match.version, declared);
  assert.ok(entry.match.docs[0].startsWith('https://docs.godotengine.org'));
});

await check('工作区上下文渲染出项目、版本与官方地址', () => {
  const scan = scanForProjects(scanTarget, { depth: 2, maxDirs: 80 });
  const text = workspaceContextText({ cwd: scanTarget, depth: 2, scan }, 'zh');
  assert.ok(text.includes('形态：项目'), text);
  assert.ok(text.includes('Godot Engine'), text);
  assert.ok(text.includes('https://docs.godotengine.org'), text);
  assert.ok(text.includes('https://github.com/godotengine/godot'), text);
});

await check('无项目标记时上下文要求先征求同意', () => {
  const empty = { root: scanTarget, scanned: 1, truncated: false, found: [], errors: [] };
  const text = workspaceContextText({ cwd: scanTarget, depth: 2, scan: empty }, 'zh');
  assert.ok(text.includes('疑似「杂项文件'), text);
  assert.ok(text.includes('consent: true'), text);
});

await check('探针：未获同意时不执行上溯', async () => {
  const probe = toolNamed(registered.tools, 'coder_project_probe');
  const cwd = path.join(scanTarget, 'animals-fight');
  const result = await probe.execute({ includeParents: true, consent: false }, fakeExec(cwd));
  assert.equal(result.status, 'consent-required');
  assert.ok(result.text.includes('未执行'), result.text);
  assert.equal('ancestors' in result, false);
});

await check('探针：获同意后真的上溯并报告结果', async () => {
  const probe = toolNamed(registered.tools, 'coder_project_probe');
  const cwd = path.join(scanTarget, 'animals-fight');
  const result = await probe.execute({ includeParents: true, consent: true, parentLevels: 3 }, fakeExec(cwd));
  assert.equal(result.status, 'project');
  assert.ok(Array.isArray(result.ancestors) && result.ancestors.length > 0);
  assert.ok(result.text.includes('向上查找'), result.text);
});

await check('探针：向上查找找到项目根时会写进上下文', async () => {
  const probe = toolNamed(registered.tools, 'coder_project_probe');
  const scan = scanForProjects(scanTarget, { depth: 0, maxDirs: 8 });
  assert.equal(scan.found.length, 0, '本目录不应直接命中标记（标记在子目录里）');
  const result = await probe.execute({ depth: 0 }, fakeExec(scanTarget));
  assert.equal(result.status, 'no-known-project-marker');
  const text = probeResultText({
    cwd: scanTarget,
    target: scanTarget,
    depth: 0,
    scan,
    escapesWorkingDirectory: false
  }, 'zh');
  assert.ok(text.includes('疑似「杂项文件'), text);
  assert.ok(text.includes('includeParents:true, consent:true'), text);
  const withParents = await probe.execute({ includeParents: true, consent: true, parentLevels: 2 }, fakeExec(scanTarget));
  const contextText = workspaceContextText({
    cwd: scanTarget,
    depth: 0,
    scan,
    ancestors: withParents.ancestors
  }, 'zh');
  assert.ok(contextText.includes('向上查找'), contextText);
});

await check('探针：更浅的一次探测不会把工作区上下文降级成"杂项"', async () => {
  const probe = toolNamed(registered.tools, 'coder_project_probe');
  const agent = fakeAgent(scanTarget, 'context-downgrade-session');
  // 默认关：先把这个会话打开，才谈得上"上下文被降级"。
  registered.emit(agent.session, { type: 'command/run', data: { commandId: 'ctx-on', name: 'coder', args: 'on' } });
  registered.emit(agent.session, { type: 'command/done', data: { commandId: 'ctx-on', kind: 'success' } });
  const render = () => registered.contexts[0].text({ agent });
  const before = render();
  assert.ok(before.includes('形态：项目'), before);
  assert.ok(before.includes('Godot Engine'), before);
  await probe.execute({ depth: 0 }, { agent, signal: new AbortController().signal });
  const after = render();
  assert.ok(after.includes('形态：项目'), `depth:0 探测后上下文被降级：\n${after}`);
  assert.ok(after.includes('Godot Engine'), after);
});

await check('探针：不存在的路径直接报错', async () => {
  const probe = toolNamed(registered.tools, 'coder_project_probe');
  await assert.rejects(
    () => probe.execute({ path: 'definitely-not-here-9f3a' }, fakeExec(scanTarget)),
    /路径不可读/
  );
});

await check('探针：文件路径被拒绝', async () => {
  const probe = toolNamed(registered.tools, 'coder_project_probe');
  await assert.rejects(
    () => probe.execute({ path: 'project.godot' }, fakeExec(path.join(scanTarget, 'animals-fight'))),
    /不是目录/
  );
});

await check('备份：文件+目录只复制，覆盖与失败都如实报告', async () => {
  const backup = toolNamed(registered.tools, 'coder_backup');
  const sandbox = mkdtempSync(path.join(tmpdir(), 'coder-mode-test-'));
  try {
    const sourceDir = path.join(sandbox, 'project');
    mkdirSync(path.join(sourceDir, 'scenes'), { recursive: true });
    const sourceFile = path.join(sourceDir, 'scenes', 'main.tscn');
    const content = '[gd_scene]\n';
    writeFileSync(sourceFile, content, 'utf8');
    const result = await backup.execute(
      { paths: ['project/scenes/main.tscn', 'project/scenes', 'project/missing.tscn'], reason: '自检' },
      fakeExec(sandbox)
    );
    assert.equal(result.backedUp.length, 1);
    assert.equal(result.coveredByParent.length, 1);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].error, /ENOENT/);
    const dirEntry = result.backedUp[0];
    assert.equal(dirEntry.kind, 'directory');
    assert.equal(readFileSync(path.join(dirEntry.backup, 'main.tscn'), 'utf8'), content);
    assert.equal(readFileSync(sourceFile, 'utf8'), content, '原文件必须未被修改');
    assert.ok(readFileSync(path.join(result.root, 'BACKUP-MANIFEST.txt'), 'utf8').includes('自检'));
    const text = backupResultText({ root: result.root, backups: result.backedUp, failures: result.failures, covered: result.coveredByParent, reason: '自检' }, 'zh');
    assert.ok(text.includes('备份完成'), text);
    assert.ok(text.includes('失败条目'), text);
    assert.ok(text.includes('未重复复制'), text);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

await check('备份：空 paths 直接报错', async () => {
  const backup = toolNamed(registered.tools, 'coder_backup');
  await assert.rejects(() => backup.execute({ paths: [] }, fakeExec(scanTarget)), /至少需要一个非空路径/);
});

await check('备份：工作目录之外的文件落到 _external', async () => {
  const backup = toolNamed(registered.tools, 'coder_backup');
  const outside = mkdtempSync(path.join(tmpdir(), 'coder-mode-outside-'));
  const sandbox = mkdtempSync(path.join(tmpdir(), 'coder-mode-test-'));
  try {
    const externalFile = path.join(outside, 'notes.txt');
    writeFileSync(externalFile, 'external\n', 'utf8');
    const result = await backup.execute({ paths: [externalFile] }, fakeExec(sandbox));
    assert.equal(result.backedUp.length, 1);
    assert.ok(result.backedUp[0].backup.includes('_external'), result.backedUp[0].backup);
    assert.equal(readFileSync(result.backedUp[0].backup, 'utf8'), 'external\n');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

await check('策略段包含 5 条规则关键词', () => {
  const zh = policyText('zh');
  for (const key of ['向上层目录查找项目根', '官方文档', '不知道', '缺失', 'coder_backup']) {
    assert.ok(zh.includes(key), `策略段缺少关键词：${key}`);
  }
  const en = policyText('en');
  assert.ok(en.includes('consent') && en.includes('coder_backup'));
});

await check('祖先扫描：从工作区根继续向上不会崩', () => {
  const chain = scanAncestors(scanTarget, 4);
  assert.ok(Array.isArray(chain));
  for (const entry of chain) assert.equal(typeof entry.dir, 'string');
});

console.log(`\n全部通过：${passed} 项检查。`);
