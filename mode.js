/**
 * 码农模式的"可选模式"状态机（纯函数 + zod 形状的最小 schema）。
 *
 * 设计取自 DSH 的 plan mode：**不发明新的会话事件类型**，而是把状态折叠自
 * `command/run` / `command/done` —— 这两个是核心命令服务自己写入日志的持久事件，
 * 所以 `/coder on|off` 的效果能随 resume / fork 一起恢复，插件被卸载后也不会
 * 留下"读不回来的未知事件"。
 *
 * 投影的 `stateSchema` / `wire.viewSchema` 在运行时只被调用 `.parse()`（见
 * @deepseek-ai/dsh-session-projection 的 `viewCheckpoint` / `restore` 路径）。
 * profile 安装的 bundle 解析不到 zod（`@deepseek-ai/*` 与 `zod` 都是
 * ERR_MODULE_NOT_FOUND），所以这里给出同样形状的极简 schema：校验合法就返回原值，
 * 否则抛错。校验故意宽松（字段缺失按缺失处理），避免旧存档让会话读不回来。
 */

/** 客户端可见的投影 key；与核心 key（inbox/plan/todos/…）不冲突。 */
export const PROJECTION_KEY = 'coderMode';

/** 命令输入提示。 */
export const COMMAND_HINT = '[on|off|status]';

/** 该值是否是普通对象。 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 是否为合法的模式状态。 */
function isModeState(value) {
  if (!isRecord(value)) return false;
  if (typeof value.active !== 'boolean') return false;
  if (value.running === null) return true;
  return isRecord(value.running)
    && typeof value.running.commandId === 'string'
    && typeof value.running.wanted === 'boolean';
}

/** 是否为合法的客户端视图值。 */
function isModeView(value) {
  return isRecord(value) && typeof value.active === 'boolean' && typeof value.pending === 'boolean';
}

/**
 * 构造 zod 形状的最小 schema（运行时只调用 `parse`）。
 * @param validate 校验函数。
 * @param label 报错里用的名字。
 * @returns 带 `parse` 的 schema 对象。
 */
function schemaOf(validate, label) {
  return {
    parse(value) {
      if (validate(value)) return value;
      throw new Error(`coder-mode: invalid ${label}`);
    }
  };
}

/**
 * 解析 `/coder` 的参数。
 * @param rawInput 命令后的原始输入。
 * @returns `{ kind: 'set', wanted }`、`{ kind: 'status' }` 或 `{ kind: 'invalid' }`。
 */
export function parseToggle(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput.trim().toLowerCase() : '';
  if (text === '') return { kind: 'set', wanted: true };
  if (text === 'status') return { kind: 'status' };
  if (['on', 'enable', 'enabled', 'true', '1'].includes(text)) return { kind: 'set', wanted: true };
  if (['off', 'disable', 'disabled', 'false', '0'].includes(text)) return { kind: 'set', wanted: false };
  return { kind: 'invalid', rawInput: text };
}

/**
 * 当前生效的开关值：命令已经进入但尚未落定时，以用户刚选的值为准。
 * @param state 投影状态。
 * @returns 是否生效。
 */
export function effectiveActive(state) {
  if (!isModeState(state)) return false;
  return state.running === null ? state.active : state.running.wanted;
}

/**
 * 构造 `coderMode` 投影单元。
 * @param options `{ commandName, enabledByDefault }`。
 * @returns 可直接交给 `ctx.sessionProjections.register` 的定义。
 */
export function createModeProjection(options) {
  const commandName = options.commandName;
  const enabledByDefault = options.enabledByDefault === true;
  return {
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: schemaOf(isModeState, 'coder-mode projection state'),
    init: () => ({ active: enabledByDefault, running: null }),
    /**
     * 纯折叠：忽略的事件必须返回同一个引用。
     * @param state 当前状态。
     * @param event 会话事件。
     * @returns 新状态或原状态。
     */
    apply: (state, event) => {
      if (event.type === 'command/run' && event.data.name === commandName) {
        const parsed = parseToggle(event.data.args ?? '');
        if (parsed.kind !== 'set') return state;
        return {
          active: state.active,
          running: { commandId: String(event.data.commandId), wanted: parsed.wanted }
        };
      }
      if (event.type === 'command/done'
        && state.running !== null
        && String(event.data.commandId) === state.running.commandId) {
        if (event.data.kind !== 'success') return { active: state.active, running: null };
        return { active: state.running.wanted, running: null };
      }
      return state;
    },
    wire: {
      viewSchema: schemaOf(isModeView, 'coder-mode projection view'),
      view: (state) => ({
        active: state.active,
        pending: state.running !== null && state.running.wanted !== state.active
      })
    }
  };
}

/** `/coder` 的命令描述。 */
export function commandDescription(language) {
  return language === 'en'
    ? 'Enter, leave, or read Coder Mode for this session'
    : '开启、关闭或查看本会话的码农模式';
}

/**
 * `/coder status` 的结果文案。
 * @param active 当前是否生效。
 * @param language `zh` 或 `en`。
 * @returns 文案。
 */
export function statusText(active, language) {
  if (language === 'en') return `Coder Mode is ${active ? 'on' : 'off'} for this session.`;
  return `本会话的码农模式当前${active ? '已开启' : '已关闭'}。`;
}

/**
 * 切换命令的结果文案。
 * @param wanted 目标状态。
 * @param language `zh` 或 `en`。
 * @returns 文案。
 */
export function switchText(wanted, language) {
  if (language === 'en') {
    return wanted
      ? 'Coder Mode on: the policy section and workspace facts apply from your next step.'
      : 'Coder Mode off: the policy section and workspace facts are dropped from your next step.';
  }
  return wanted
    ? '码农模式已开启：策略段与工作区事实会从下一步开始生效。'
    : '码农模式已关闭：策略段与工作区事实会从下一步起移除。';
}

/**
 * 已经是目标状态时的文案。
 * @param active 当前状态。
 * @param language `zh` 或 `en`。
 * @returns 文案。
 */
export function alreadyText(active, language) {
  if (language === 'en') return `Coder Mode is already ${active ? 'on' : 'off'}.`;
  return `码农模式已经是${active ? '开启' : '关闭'}状态。`;
}

/**
 * 参数非法时的错误文案。
 * @param rawInput 非法输入。
 * @param language `zh` 或 `en`。
 * @returns 文案。
 */
export function invalidText(rawInput, language) {
  if (language === 'en') {
    return `unknown /coder argument ${JSON.stringify(rawInput)}; use on, off, or status.`;
  }
  return `无法识别的 /coder 参数 ${JSON.stringify(rawInput)}；可用 on、off 或 status。`;
}
