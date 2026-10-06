/**
 * 码农模式的 Web 开关（Client half）。
 *
 * 位置：`conversation.input.left`（会话级、`replaceRisk: none` 的紧凑控件位，与计划模式
 * 控件同在输入框工具行）。状态来自 Host 投影 `coderMode` 的 wire 视图；点击则执行
 * 同一条 `/coder on|off` 命令——UI 与命令走同一套 Host 逻辑，不存在第二份实现。
 *
 * 这是纯 JS 的浏览器模块（`window.__ModuleLoader__.load`），只 require 基线里的 `react`，
 * 样式为组件内 `<style>`（随组件卸载一起消失），类名与变量都用自己的前缀与
 * `--dsw-alias-*` 主题 token，不 import 任何 Harness 客户端包。
 */
window.__ModuleLoader__.load({
  id: 'dsh-coder-mode',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 本插件的 locale 命名空间。 */
    const NS = 'coder-mode';
    /** Host 投影 key（与 host 侧 mode.js 的 PROJECTION_KEY 一致）。 */
    const PROJECTION_KEY = 'coderMode';
    /** 挂载的插槽。 */
    const SLOT = 'conversation.input.left';
    /** 命令名（与 host 侧默认配置一致）。 */
    const COMMAND = 'coder';

    /** 文案字典。 */
    const DICTS = {
      zh: {
        label: '码农',
        off: '码农模式已关闭 — 点击开启（/coder on）',
        on: '码农模式已开启 — 点击关闭（/coder off）',
        busy: '正在切换码农模式…',
        failed: '切换码农模式失败',
        unknown: '未知命令：/coder'
      },
      en: {
        label: 'Coder',
        off: 'Coder Mode off — click to turn on (/coder on)',
        on: 'Coder Mode on — click to turn off (/coder off)',
        busy: 'Switching Coder Mode…',
        failed: 'Coder Mode switch failed',
        unknown: 'unknown command: /coder'
      }
    };

    /** 组件内样式（只用主题 token，命名带自己的前缀）。 */
    const CSS = `
.dsh-coder-mode-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.dsh-coder-mode-chip:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
}
.dsh-coder-mode-chip.is-on {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.dsh-coder-mode-chip:disabled {
  cursor: default;
  opacity: 0.6;
}
.dsh-coder-mode-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary);
}
.dsh-coder-mode-chip.is-on .dsh-coder-mode-dot {
  background: var(--dsw-alias-state-success-primary);
}
.dsh-coder-mode-chip.is-error {
  border-color: var(--dsw-alias-state-error-primary);
}
`;

    /** 服务依赖：客户端插槽、Remote 命令调用、locale。 */
    const inject = ['slots', 'remote', 'remote.commands', 'locale'];

    /**
     * 注册开关。
     * @param ctx 客户端根上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTS), 'coder-mode: client dictionaries');
      const t = ctx.locale.bind(NS);

      /**
       * 执行一条命令并翻译失败原因；成功返回 null。
       * @param sessionId 目标会话。
       * @param line 完整命令行。
       * @returns 失败文案或 null。
       */
      const runCommand = async (sessionId, line) => {
        try {
          const result = await ctx.remote.commands.execute(sessionId, line, []);
          if (result === undefined || result === null) return t('unknown');
          if (result.ok === false) {
            const message = result.error?.message ?? 'error';
            const code = result.error?.code ?? '?';
            return `${message} (${code})`;
          }
          if (result.value === undefined) return t('unknown');
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };

      /**
       * 输入框工具行里的模式开关。
       * @param props 插槽标准 props（`useProjection`、`sessionId`）。
       * @returns React 元素。
       */
      function CoderModeChip(props) {
        const value = props.useProjection(PROJECTION_KEY);
        const sessionId = props.sessionId;
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState(null);
        const alive = React.useRef(true);
        React.useEffect(() => () => {
          alive.current = false;
        }, []);
        const active = value !== undefined && value !== null && value.active === true;
        const click = () => {
          if (busy || sessionId === undefined) return;
          setBusy(true);
          setError(null);
          runCommand(sessionId, `/${COMMAND} ${active ? 'off' : 'on'}`).then((failure) => {
            if (!alive.current) return;
            setBusy(false);
            setError(failure);
          });
        };
        const title = error !== null
          ? `${t('failed')}: ${error}`
          : busy ? t('busy') : active ? t('on') : t('off');
        const className = `dsh-coder-mode-chip${active ? ' is-on' : ''}${error !== null ? ' is-error' : ''}`;
        return h(React.Fragment, null,
          h('style', { key: 'style' }, CSS),
          h('button', {
            key: 'button',
            type: 'button',
            className,
            'aria-pressed': active,
            'aria-label': title,
            title,
            disabled: busy,
            onClick: click
          }, [
            h('span', { key: 'dot', className: 'dsh-coder-mode-dot', 'aria-hidden': true }),
            h('span', { key: 'label' }, t('label'))
          ]));
      }

      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: 'coder-mode',
        order: 20,
        label: () => t('label')
      }, CoderModeChip));
    }

    return { inject, apply };
  }
});
