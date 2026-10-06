# 码农模式 (Coder Mode)

给写代码 / 辅助游戏引擎的场景加一层硬约束的 DSH 插件。它是一个**可选模式**：新会话默认关闭，用 `/coder on` 或输入框左侧的开关打开，打开后才会把"工作区事实"和"来源纪律"注入模型；两个工具则始终可用。

## 可选模式怎么开

| 入口 | 行为 |
| --- | --- |
| `/coder on` | 打开本会话的码农模式（`/coder`、`/coder enable`、`/coder true` 同义） |
| `/coder off` | 关闭本会话的码农模式（`/coder disable`、`/coder false` 同义） |
| `/coder status` | 查看当前状态，不改状态 |
| 输入框左侧的「码农」开关 | 与命令等价的 UI 入口：点击即执行同一条 `/coder on|off` 命令 |

- **默认关**：`enabledByDefault: false`。模式关着的时候，策略段与工作区事实都不进提示词（工具仍在）。
- **状态可持久**：模式状态不靠新事件类型，而是**折叠会话日志里 `command/run` / `command/done` 这对核心事件**（命令服务自己写入的持久记录），所以 resume / fork 后开关状态会跟着回来。
- **打开后生效的内容**：策略段（5 条约定）+ 每步的工作区事实上下文；关闭即从下一步起移除。
- **工具不受开关影响**：`coder_project_probe` / `coder_backup` 始终注册（与 plan mode 同思路：模式只切换提示词，工具目录保持稳定）。

## 它解决什么

| 需求 | 插件里的实现 |
| --- | --- |
| 1. 工作区是杂项/单文件时，向上查找项目要**先要权限**；拿不到权限又缺文件参考时必须问 | 每步注入的运行时上下文先给出形态判定（项目 / 疑似杂项）；`coder_project_probe` 在 `includeParents: true` 但没有 `consent: true` 时**什么都不做**，只返回"需要先询问用户"的指令；策略段要求缺文件时列清单并询问，不许猜 |
| 2. 涉及项目所用引擎/框架的问题，先去官网/官方仓库找答案 | 探测结果与上下文直接列出该技术栈的**官方文档 + 官方仓库**地址（含版本线索），策略段规定检索顺序为 官方文档 → 官方仓库 → 官方 API 参考，并要求先确认项目实际版本 |
| 3. 官方来源找不到就直说"不知道"并交出线索 | 策略段规定：回答"官方文档没有说明 / 我不知道"，并必须给出 ①已检索的具体来源 ②已排除的可能 ③线索与不确定点 ④建议去哪里找或直接问用户；禁止编造 API |
| 4. 缺什么、链路断在哪、没找到什么，都要直说 | 策略段规定缺失报告格式（缺失项/期望位置/实际观察/影响/需要用户做什么）；工具把读取失败的目录、备份失败的条目**逐条**放进结果里 |
| 5. 可能改坏文件不可还原时先备份 | 策略段把"先备份再动手"写成前置步骤；`coder_backup` 只复制不改原文件，落盘到会话备份目录并写 `BACKUP-MANIFEST.txt`，失败条目如实上报 |

## 安装

用 `plugin_manager` 安装**打好的 tarball**（不要装目录，原因见下）：

```
action: install_bundle
target: F:\GodotProjects\NewGame2\dsh-coder-mode\dist\dsh-coder-mode-<版本>.tgz
```

装好后 profile 里会多出 `dsh-coder-mode` 依赖和一条 `id: coder-mode` 的插件行。改动的是 Host 代码时安装结果是 `restart-required`：**重启 Harness 才会加载新的模块代次**；改动的是 client.js 时再**刷新页面**才会加载新的浏览器模块。

**为什么不用目录直接装：** 本机 profile 是 pnpm workspace（`pnpm-workspace.yaml`）+ `node-linker=hoisted`，工作区在 `C:`、插件在 `F:`。这种组合下 pnpm 8.15.9 会把 `link:`/`file:` 的盘符绝对路径当成**相对路径**拼接，生成一个指向 `C:\Users\...\profiles\web\F:\GodotProjects\...` 的死链接，Loader 随即报 `cannot resolve profile bundle`。已实测：`link:F:\...`、`link:F:/...`、`file:F:\...`、`file:F:/...` 全部失败，只有 tarball 能装成。tarball 是**复制**安装，所以改完源码必须重打包再装。

改完源码后重新打包安装：

```
cd F:\GodotProjects\NewGame2\dsh-coder-mode
npm pack --pack-destination dist          # 同时把 package.json 的 version 加一
# 然后用 plugin_manager install_bundle 指向新的 dist\dsh-coder-mode-<版本>.tgz
```

**不要删掉 `dist\` 里当前那个 tarball**：profile 的依赖记的是这个文件的绝对路径，删了以后再做任何插件安装/修复都会解析失败（`ENOENT ... .tgz`）。装完新版本后，旧的 tarball 才移进 `dist\archive\`。

移除：`plugin_manager` `remove_bundle`，target 为 `dsh-coder-mode`。

## 配置

默认行来自本包的 `cordis.patch.yml`（`id: coder-mode`）。要改配置，在 profile 的 `cordis.patch.yml` 里加一条按 id 覆盖的行，只写要改的键：

```yaml
- id: coder-mode
  name: dsh-coder-mode
  config:
    language: en
    enabledByDefault: true
    backupDir: D:\dsh-backups
```

可用的键：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `language` | `zh` | 策略段、上下文、工具描述、开关文案的语言（`zh` / `en`） |
| `enabledByDefault` | `false` | 新会话是否默认处于码农模式 |
| `command` | `coder` | 开关命令名（不带斜杠），例如改成 `mode` 就是 `/mode on` |
| `policySection` | `true` | 是否注册策略段（仅在模式生效的会话里出现） |
| `workspaceContext` | `true` | 是否注入"工作区事实"上下文（仅在模式生效的会话里出现） |
| `tools` | `true` | 是否注册两个工具（与模式开关无关，始终可用） |
| `scanDepth` | `2` | 工作目录**向下**扫描层数（0 = 只看本目录） |
| `maxScanDirs` | `80` | 单次扫描读取目录数上限（超出会提示结果可能不完整） |
| `parentLevels` | `8` | **向上**查找时最多上溯层数（仍需用户先同意） |
| `refreshMs` | `60000` | 同一会话扫描结果缓存时长 |
| `backupDir` | `""` | 备份根目录；空串 = `<系统临时目录>/dsh-coder-mode/<会话>` |

配置里出现未知键、类型错误或越界值会让这一行激活失败并报出具体原因（不静默兜底）。

本插件的 `Config` 用 Standard Schema（`~standard.validate`）声明，不依赖 `@deepseek-ai/schemastery`——profile 安装的 bundle 解析不到 Harness 自己的依赖树（已实测：从已安装副本里 `import('@deepseek-ai/schemastery')`、`import('@deepseek-ai/dsh-tools')`、`import('zod')` 全是 `ERR_MODULE_NOT_FOUND`）。代价是 Plugin Manager 读不到可渲染的表单：`Config.listConfigs` 里这条行状态是 `unsupported`，并带一条诊断 `Config is not a native Schemastery schema`。配置本身照常在 `cordis.patch.yml` 的 `config` 里写、照常在激活时校验。

## 工具

### `coder_project_probe`

参数：`path`、`includeParents`、`consent`、`depth`、`parentLevels`。

- 默认只扫描会话工作目录及其子目录，返回：形态、命中的项目标记（含所在目录、版本线索、官方文档/仓库）、读取失败清单。
- `includeParents: true` 必须同时 `consent: true`（先用 `ask_user_question` 拿到用户同意）。否则返回 `status: "consent-required"`，**不执行任何上溯**。
- 路径不存在 / 不是目录 → 直接报错，不猜。

### `coder_backup`

参数：`paths`（文件或目录，可多个）、`reason`。

- 只复制，不改原文件；写到 `<backupDir 或临时目录>/<时间戳>/...`，并写 `BACKUP-MANIFEST.txt`（时间、会话、cwd、原因、条目、失败）。
- 同一批里父目录已覆盖的子项不重复复制，并在结果里说明。
- 工作目录之外的源文件落到 `_external/<盘符>/...`，不会跳出备份根目录。
- 备份失败逐条报告；恢复 = 把备份路径复制回原路径。

## 目录结构

```
dsh-coder-mode/
  index.js            Host 入口：Config、apply、模式接线、两个工具
  mode.js             可选模式的状态机：/coder 参数解析、投影折叠、zod 形状的 schema
  policy.js           模型可见文案：策略段、工具描述、上下文与工具输出渲染
  rules.js            项目标记规则表 + 目录扫描（只用 node: 内置模块）
  client.js           Web 开关（浏览器纯 JS 模块，挂 conversation.input.left）
  cordis.patch.yml    bundle patch（profile 里那条 coder-mode 行）
  locale/{zh,en}.json Plugin Manager 里的标题与说明
  icon.svg            插件图标
  test/self-test.mjs  无需 Harness 运行时的自检
  dist/               安装用的 tarball（archive/ 是旧版本）
```

## 自检

```
node test/self-test.mjs [要扫描的目录]
```

用桩 ctx（含最小投影引擎）验证：注册形状（1 个投影 + 1 条命令 + 1 个策略段 + 1 个上下文 + 2 个工具）、模式门禁（默认关 → `/coder on` → `/coder off`）、投影折叠的纯度与失败不翻转状态、`enabledByDefault`、client.js 与 Host 的 key/插槽/命令一致性，并在 Node 里真的加载浏览器模块、注册插槽、渲染组件、断言它按状态发出 `/coder off` 与 `/coder on`；此外还有扫描与版本提取、`consent` 门禁、浅扫描不降级上下文、探针报错、备份的复制/覆盖/失败语义。当前 24 项全部通过。

## 已知边界

- 项目标记是**文件名 + 有限内容嗅探**（每个候选文件最多读 32 KB），不是完整解析器；`project.godot` 一类清单文件缺失或重命名时判定会退回"疑似杂项"。
- 官方地址是内置表，可能随上游变化而过期；表中没有的技术栈会明确写"官方地址未确认"，要求去问用户或自行检索，而不是编一个地址。
- 扫描不下钻符号链接，跳过 `node_modules/.git/.godot/Library/build/...` 等目录；超上限会提示结果不完整。
- 投影的 `stateSchema` / `viewSchema` 是**zod 形状的最小替身**（运行时只调用 `.parse()`，见 dsh-session-projection 的 `viewCheckpoint` / `restore`）。将来若上游改成调用别的 zod 方法，这一处需要跟着改；校验故意宽松，不会因为旧存档让会话读不回来。
- 模式状态来自 `/coder` 的命令记录：**必须通过这条命令（或 UI 开关）切换**才持久；直接改配置 `enabledByDefault` 只影响之后新建的会话。
- 插件不代替审批：破坏性操作本身仍需用户确认，备份只是多一层可恢复性。
- 备份默认落在系统临时目录，可能被系统清理；需要长期保留请在 `backupDir` 里指定一个固定目录。
- `Config.listConfigs` 里这条行的状态是 `unsupported`（原因见"配置"一节）：配置能用，只是没有 GUI 表单。
- 目录里的 `*.bak`（修 schema 时留下的安全副本）与 `dist/archive/` 里的旧 tarball 都不参与打包（`files` 白名单），确认不需要后可自行删除。
