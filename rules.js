/**
 * 码农模式 (Coder Mode) — 项目标记识别表与目录扫描。
 *
 * 这个模块只使用 Node 内置模块，不 import 任何 `@deepseek-ai/*` 包：
 * profile 安装的 bundle 由 Loader 直接加载，无法保证能解析到 Harness 自己的依赖树。
 *
 * 规则字段（空字段表示不参与判断）：
 *   files     顶层文件名，全部存在于该目录才算匹配
 *   anyFiles  顶层文件名或通配（可含 `*`），任一命中即算匹配
 *   dirs      顶层目录名，全部存在才算匹配
 *   anyDirs   顶层目录名或通配，任一命中即算匹配
 *   paths     相对子路径（可含目录），全部存在才算匹配
 *   deps      文件内容特征 `[{ file, pattern }]`，file 可含 `*`，全部命中才算匹配
 *   version   版本线索 `{ file, pattern }`，pattern 的第 1 个捕获组作为版本
 *   docs      官方文档地址（回答该引擎/框架问题时的第一站）
 *   repo      官方仓库地址
 *   hints     该技术栈的附加提醒
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** 扫描时不下钻的目录名（小写比较），涵盖依赖、构建产物与引擎缓存。 */
export const IGNORED_DIRS = new Set([
  'node_modules', 'bower_components', 'vendor',
  '.git', '.hg', '.svn', '.godot', '.import', '.gradle', '.idea', '.vs', '.vscode',
  '.dart_tool', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.venv',
  '__pycache__', 'venv', 'env',
  'library', 'temp', 'obj', 'bin', 'binaries', 'build', 'dist', 'out', 'target',
  'intermediate', 'deriveddatacache', 'saved', 'packages', 'pods', 'cmakefiles'
]);

/** 单个标记文件最多嗅探的字节数。 */
const MAX_SNIFF_BYTES = 32768;

/**
 * 项目标记规则表。顺序只影响输出顺序。
 * 官方地址只写能确认属于官方的站点/仓库；不确定时留空，由模型去问用户或自行搜索。
 */
export const PROJECT_RULES = [
  // ---- 游戏引擎 ----
  {
    id: 'godot', label: 'Godot Engine', kind: 'engine',
    files: ['project.godot'],
    version: { file: 'project.godot', pattern: /config\/features=PackedStringArray\(\s*"([^"]+)"/ },
    docs: ['https://docs.godotengine.org/en/stable/'],
    repo: 'https://github.com/godotengine/godot',
    hints: ['GDScript 与 C# 的 API 文档是分开的；版本写在同一份 project.godot 里。']
  },
  {
    id: 'godot-csharp', label: 'Godot Engine + C# (Mono/.NET)', kind: 'engine',
    files: ['project.godot'], anyFiles: ['*.csproj'],
    version: { file: 'project.godot', pattern: /config\/features=PackedStringArray\(\s*"([^"]+)"/ },
    docs: ['https://docs.godotengine.org/en/stable/tutorials/scripting/c_sharp/index.html'],
    repo: 'https://github.com/godotengine/godot',
    hints: ['C# 侧还要看 GodotSharp 程序集版本与 *.csproj 的 TargetFramework，两者必须与引擎版本匹配。']
  },
  {
    id: 'unity', label: 'Unity', kind: 'engine',
    dirs: ['Assets'], paths: ['ProjectSettings/ProjectVersion.txt'],
    version: { file: 'ProjectSettings/ProjectVersion.txt', pattern: /m_EditorVersion:\s*(\S+)/ },
    docs: ['https://docs.unity3d.com/Manual/index.html', 'https://docs.unity3d.com/ScriptReference/'],
    repo: 'https://github.com/Unity-Technologies/UnityCsReference',
    hints: ['API 随版本变化很大，先确认 ProjectVersion.txt 的精确版本再查文档；Package Manager 里的包各有自己的文档。']
  },
  {
    id: 'unreal', label: 'Unreal Engine', kind: 'engine',
    anyFiles: ['*.uproject'],
    docs: ['https://dev.epicgames.com/documentation/en-us/unreal-engine'],
    repo: 'https://github.com/EpicGames/UnrealEngine',
    hints: ['引擎版本线索在 .uproject 的 EngineAssociation 与 Config/DefaultEngine.ini；C++ API 以对应版本的引擎源码为准。']
  },
  {
    id: 'gamemaker', label: 'GameMaker', kind: 'engine',
    anyFiles: ['*.yyp'],
    docs: ['https://manual.gamemaker.io/monthly/en/'],
    hints: ['运行时版本与 IDE 版本要一起看，.yyp 里的 resourceVersion 也是线索。']
  },
  {
    id: 'defold', label: 'Defold', kind: 'engine',
    files: ['game.project'],
    docs: ['https://defold.com/manuals/'],
    repo: 'https://github.com/defold/defold'
  },
  {
    id: 'love2d', label: 'LÖVE (Love2D)', kind: 'engine',
    files: ['conf.lua'],
    docs: ['https://love2d.org/wiki/Main_Page'],
    repo: 'https://github.com/love2d/love'
  },
  {
    id: 'cocos', label: 'Cocos Creator', kind: 'engine',
    dirs: ['assets', 'settings'], deps: [{ file: 'package.json', pattern: '"creator"' }],
    docs: ['https://docs.cocos.com/creator/manual/en/'],
    repo: 'https://github.com/cocos/cocos-engine'
  },
  {
    id: 'roblox', label: 'Roblox (Rojo / Studio 项目)', kind: 'engine',
    anyFiles: ['default.project.json', '*.rbxlx', '*.rbxl', '*.rbxm'],
    docs: ['https://create.roblox.com/docs'],
    repo: 'https://github.com/rojo-rbx/rojo'
  },
  {
    id: 'stride', label: 'Stride', kind: 'engine',
    anyFiles: ['*.sdpkg'],
    docs: ['https://doc.stride3d.net/latest/en/index.html'],
    repo: 'https://github.com/stride3d/stride'
  },
  {
    id: 'flax', label: 'Flax Engine', kind: 'engine',
    anyFiles: ['*.flaxproj'],
    docs: ['https://docs.flaxengine.com/manual/'],
    repo: 'https://github.com/FlaxEngine/FlaxEngine'
  },
  {
    id: 'bevy', label: 'Bevy (Rust)', kind: 'engine',
    deps: [{ file: 'Cargo.toml', pattern: 'bevy' }],
    version: { file: 'Cargo.toml', pattern: /bevy\s*=\s*(?:\{[^}]*version\s*=\s*)?"([^"]+)"/ },
    docs: ['https://bevyengine.org/learn/', 'https://docs.rs/bevy'],
    repo: 'https://github.com/bevyengine/bevy',
    hints: ['Bevy 每个小版本都会改 API；先确认 Cargo.lock 锁定的确切版本，再读该版本的 docs.rs 与迁移指南。']
  },
  {
    id: 'monogame', label: 'MonoGame', kind: 'engine',
    deps: [{ file: '*.csproj', pattern: 'MonoGame' }],
    docs: ['https://docs.monogame.net/'],
    repo: 'https://github.com/MonoGame/MonoGame'
  },
  {
    id: 'libgdx', label: 'libGDX', kind: 'engine',
    deps: [{ file: 'build.gradle', pattern: 'gdx' }],
    docs: ['https://libgdx.com/wiki/'],
    repo: 'https://github.com/libgdx/libgdx'
  },
  {
    id: 'raylib', label: 'raylib', kind: 'engine',
    deps: [{ file: 'CMakeLists.txt', pattern: 'raylib' }],
    docs: ['https://www.raylib.com/'],
    repo: 'https://github.com/raysan5/raylib'
  },
  {
    id: 'pygame', label: 'pygame', kind: 'engine',
    deps: [{ file: 'requirements.txt', pattern: 'pygame' }],
    docs: ['https://www.pygame.org/docs/'],
    repo: 'https://github.com/pygame/pygame'
  },
  {
    id: 'three', label: 'three.js', kind: 'engine',
    deps: [{ file: 'package.json', pattern: '"three"\\s*:' }],
    docs: ['https://threejs.org/docs/'],
    repo: 'https://github.com/mrdoob/three.js'
  },
  {
    id: 'phaser', label: 'Phaser', kind: 'engine',
    deps: [{ file: 'package.json', pattern: '"phaser"\\s*:' }],
    docs: ['https://docs.phaser.io/'],
    repo: 'https://github.com/phaserjs/phaser'
  },

  // ---- 应用 / 前端框架 ----
  {
    id: 'next', label: 'Next.js', kind: 'framework',
    deps: [{ file: 'package.json', pattern: '"next"\\s*:' }],
    docs: ['https://nextjs.org/docs'],
    repo: 'https://github.com/vercel/next.js'
  },
  {
    id: 'nuxt', label: 'Nuxt', kind: 'framework',
    deps: [{ file: 'package.json', pattern: '"nuxt"\\s*:' }],
    docs: ['https://nuxt.com/docs'],
    repo: 'https://github.com/nuxt/nuxt'
  },
  {
    id: 'react', label: 'React', kind: 'framework',
    deps: [{ file: 'package.json', pattern: '"react"\\s*:' }],
    docs: ['https://react.dev/'],
    repo: 'https://github.com/facebook/react'
  },
  {
    id: 'vue', label: 'Vue', kind: 'framework',
    deps: [{ file: 'package.json', pattern: '"vue"\\s*:' }],
    docs: ['https://vuejs.org/'],
    repo: 'https://github.com/vuejs/core'
  },
  {
    id: 'svelte', label: 'Svelte / SvelteKit', kind: 'framework',
    deps: [{ file: 'package.json', pattern: '"svelte"\\s*:' }],
    docs: ['https://svelte.dev/docs'],
    repo: 'https://github.com/sveltejs/svelte'
  },
  {
    id: 'astro', label: 'Astro', kind: 'framework',
    deps: [{ file: 'package.json', pattern: '"astro"\\s*:' }],
    docs: ['https://docs.astro.build/'],
    repo: 'https://github.com/withastro/astro'
  },
  {
    id: 'vite', label: 'Vite', kind: 'framework',
    deps: [{ file: 'package.json', pattern: '"vite"\\s*:' }],
    docs: ['https://vite.dev/'],
    repo: 'https://github.com/vitejs/vite'
  },
  {
    id: 'electron', label: 'Electron', kind: 'framework',
    deps: [{ file: 'package.json', pattern: '"electron"\\s*:' }],
    docs: ['https://www.electronjs.org/docs/latest/'],
    repo: 'https://github.com/electron/electron'
  },
  {
    id: 'tauri', label: 'Tauri', kind: 'framework',
    dirs: ['src-tauri'],
    docs: ['https://v2.tauri.app/'],
    repo: 'https://github.com/tauri-apps/tauri'
  },
  {
    id: 'flutter', label: 'Flutter / Dart', kind: 'framework',
    files: ['pubspec.yaml'],
    docs: ['https://docs.flutter.dev/', 'https://api.flutter.dev/'],
    repo: 'https://github.com/flutter/flutter'
  },
  {
    id: 'django', label: 'Django', kind: 'framework',
    files: ['manage.py'],
    docs: ['https://docs.djangoproject.com/en/stable/'],
    repo: 'https://github.com/django/django'
  },
  {
    id: 'fastapi', label: 'FastAPI', kind: 'framework',
    deps: [{ file: 'requirements.txt', pattern: 'fastapi' }],
    docs: ['https://fastapi.tiangolo.com/'],
    repo: 'https://github.com/fastapi/fastapi'
  },
  {
    id: 'flask', label: 'Flask', kind: 'framework',
    deps: [{ file: 'requirements.txt', pattern: 'flask' }],
    docs: ['https://flask.palletsprojects.com/'],
    repo: 'https://github.com/pallets/flask'
  },
  {
    id: 'pytorch', label: 'PyTorch', kind: 'framework',
    deps: [{ file: 'requirements.txt', pattern: 'torch' }],
    docs: ['https://pytorch.org/docs/stable/index.html'],
    repo: 'https://github.com/pytorch/pytorch'
  },

  // ---- 语言 / 构建系统 ----
  {
    id: 'dotnet', label: '.NET / C#', kind: 'toolchain',
    anyFiles: ['*.csproj', '*.sln', '*.fsproj'],
    docs: ['https://learn.microsoft.com/dotnet/'],
    repo: 'https://github.com/dotnet/runtime'
  },
  {
    id: 'cargo', label: 'Rust / Cargo', kind: 'toolchain',
    files: ['Cargo.toml'],
    docs: ['https://doc.rust-lang.org/cargo/'],
    repo: 'https://github.com/rust-lang/cargo'
  },
  {
    id: 'go', label: 'Go modules', kind: 'toolchain',
    files: ['go.mod'],
    docs: ['https://go.dev/doc/'],
    repo: 'https://github.com/golang/go'
  },
  {
    id: 'maven', label: 'Maven', kind: 'toolchain',
    files: ['pom.xml'],
    docs: ['https://maven.apache.org/guides/'],
    repo: 'https://github.com/apache/maven'
  },
  {
    id: 'gradle', label: 'Gradle', kind: 'toolchain',
    anyFiles: ['build.gradle', 'build.gradle.kts'],
    docs: ['https://docs.gradle.org/current/userguide/userguide.html'],
    repo: 'https://github.com/gradle/gradle'
  },
  {
    id: 'android', label: 'Android', kind: 'toolchain',
    paths: ['app/src/main/AndroidManifest.xml'],
    docs: ['https://developer.android.com/docs'],
    hints: ['AndroidManifest.xml 与 build.gradle 里的 compileSdk/targetSdk 决定可用 API。']
  },
  {
    id: 'xcode', label: 'Xcode', kind: 'toolchain',
    anyDirs: ['*.xcodeproj', '*.xcworkspace'],
    docs: ['https://developer.apple.com/documentation/xcode']
  },
  {
    id: 'cmake', label: 'CMake', kind: 'toolchain',
    files: ['CMakeLists.txt'],
    docs: ['https://cmake.org/documentation/'],
    repo: 'https://github.com/Kitware/CMake'
  },
  {
    id: 'node', label: 'Node.js / npm 包', kind: 'toolchain',
    files: ['package.json'],
    docs: ['https://docs.npmjs.com/'],
    hints: ['先看 package.json 的依赖版本与 packageManager / engines 字段，再看 node_modules 里实际安装的版本。']
  },
  {
    id: 'pnpm-workspace', label: 'pnpm workspace (monorepo)', kind: 'toolchain',
    files: ['pnpm-workspace.yaml'],
    docs: ['https://pnpm.io/workspaces'],
    repo: 'https://github.com/pnpm/pnpm'
  },
  {
    id: 'python', label: 'Python 项目', kind: 'toolchain',
    anyFiles: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'],
    docs: ['https://docs.python.org/3/'],
    repo: 'https://github.com/python/cpython'
  },
  {
    id: 'dsh-bundle', label: 'DSH 插件 / Bundle', kind: 'toolchain',
    files: ['cordis.patch.yml'],
    docs: [],
    hints: ['DSH 的权威来源是本机安装目录里的 @deepseek-ai/* 包（lib/types/*.d.ts 与 lib/index.js），以及 `dsh --profile <profile> --dump-config` 的组合结果；没有确认过的公开仓库地址不要引用。']
  }
];

/**
 * 把只含 `*` 的通配模式编译成忽略大小写的锚定正则。
 * @param pattern 通配模式，例如 `*.uproject`。
 * @returns 锚定正则。
 */
export function globToRegExp(pattern) {
  const parts = String(pattern).split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`, 'i');
}

/**
 * 把任意抛出的值转成可读消息。
 * @param error 抛出的值。
 * @returns 消息文本。
 */
export function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 通配是否命中给定名字（无 `*` 时按全名忽略大小写比较）。 */
function matchesAnyName(pattern, names) {
  const regexp = globToRegExp(pattern);
  return names.some((name) => regexp.test(name));
}

/** 该目录名是否属于扫描时跳过的目录。 */
function isIgnoredDir(name) {
  return name.startsWith('.') || IGNORED_DIRS.has(name.toLowerCase());
}

/** 读取一层目录的文件名与目录名；符号链接不跟随。 */
function listEntries(dir) {
  const dirents = readdirSync(dir, { withFileTypes: true });
  const files = [];
  const dirs = [];
  for (const dirent of dirents) {
    if (dirent.isDirectory()) dirs.push(dirent.name);
    else if (dirent.isFile()) files.push(dirent.name);
  }
  files.sort((a, b) => a.localeCompare(b));
  dirs.sort((a, b) => a.localeCompare(b));
  return { files, dirs };
}

/** 建立带缓存的标记文件读取器（最多读 MAX_SNIFF_BYTES）。 */
function makeSniffer(dir) {
  const cache = new Map();
  return (fileName) => {
    const key = String(fileName).toLowerCase();
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let text = '';
    try {
      const full = path.join(dir, fileName);
      if (statSync(full).isFile()) text = readFileSync(full, 'utf8').slice(0, MAX_SNIFF_BYTES);
    } catch {
      text = '';
    }
    cache.set(key, text);
    return text;
  };
}

/** 规则里的 deps 条目落到具体文件名（file 可含 `*`）。 */
function resolveDepFile(dep, files) {
  if (!String(dep.file).includes('*')) {
    const wanted = String(dep.file).toLowerCase();
    return files.find((name) => name.toLowerCase() === wanted) ?? null;
  }
  const regexp = globToRegExp(dep.file);
  return files.find((name) => regexp.test(name)) ?? null;
}

/** 判断一条规则是否命中该目录。 */
function ruleMatches(rule, dir, entries, sniff) {
  for (const name of rule.files ?? []) {
    if (!entries.files.some((file) => file.toLowerCase() === name.toLowerCase())) return false;
  }
  for (const name of rule.dirs ?? []) {
    if (!entries.dirs.some((sub) => sub.toLowerCase() === name.toLowerCase())) return false;
  }
  const anyFiles = rule.anyFiles ?? [];
  if (anyFiles.length > 0 && !anyFiles.some((pattern) => matchesAnyName(pattern, entries.files))) return false;
  const anyDirs = rule.anyDirs ?? [];
  if (anyDirs.length > 0 && !anyDirs.some((pattern) => matchesAnyName(pattern, entries.dirs))) return false;
  for (const rel of rule.paths ?? []) {
    try {
      if (!statSync(path.join(dir, rel)).isFile()) return false;
    } catch {
      return false;
    }
  }
  for (const dep of rule.deps ?? []) {
    const file = resolveDepFile(dep, entries.files);
    if (file === null) return false;
    let matched = false;
    try {
      matched = new RegExp(dep.pattern, 'i').test(sniff(file));
    } catch {
      matched = false;
    }
    if (!matched) return false;
  }
  return true;
}

/** 把命中的规则整理成可读结果。 */
function describeMatch(rule, entries, sniff) {
  const markers = [];
  for (const name of rule.files ?? []) markers.push(name);
  for (const pattern of rule.anyFiles ?? []) {
    markers.push(pattern.includes('*')
      ? entries.files.find((name) => globToRegExp(pattern).test(name)) ?? pattern
      : pattern);
  }
  for (const name of rule.dirs ?? []) markers.push(`${name}/`);
  for (const pattern of rule.anyDirs ?? []) {
    markers.push(`${entries.dirs.find((name) => globToRegExp(pattern).test(name)) ?? pattern}/`);
  }
  for (const rel of rule.paths ?? []) markers.push(rel);
  for (const dep of rule.deps ?? []) {
    const file = resolveDepFile(dep, entries.files) ?? dep.file;
    markers.push(`${file} 含 ${dep.pattern}`);
  }
  let version;
  if (rule.version !== undefined) {
    const text = sniff(rule.version.file);
    const found = text.match(rule.version.pattern);
    if (found !== null && found[1] !== undefined) version = found[1].trim();
  }
  return {
    id: rule.id,
    label: rule.label,
    kind: rule.kind,
    markers,
    docs: [...(rule.docs ?? [])],
    ...(rule.repo === undefined ? {} : { repo: rule.repo }),
    ...(rule.hints === undefined ? {} : { hints: [...rule.hints] }),
    ...(version === undefined ? {} : { version })
  };
}

/**
 * 检查一个目录，返回命中的项目标记。
 * @param dir 目录路径。
 * @returns `{ dir, files, dirs, matches, error? }`；读取失败时 error 有值、matches 为空。
 */
export function inspectDirectory(dir) {
  let entries;
  try {
    entries = listEntries(dir);
  } catch (error) {
    return { dir, files: [], dirs: [], matches: [], error: messageOf(error) };
  }
  const sniff = makeSniffer(dir);
  const matches = [];
  for (const rule of PROJECT_RULES) {
    if (!ruleMatches(rule, dir, entries, sniff)) continue;
    matches.push(describeMatch(rule, entries, sniff));
  }
  return { dir, files: entries.files, dirs: entries.dirs, matches };
}

/**
 * 向下扫描工作区，报告每个命中项目标记的目录。
 * @param rootDir 起点目录。
 * @param options `{ depth, maxDirs }`；depth 为向下层数（0 表示只看该目录）。
 * @returns `{ root, scanned, truncated, found, errors }`。
 */
export function scanForProjects(rootDir, options) {
  const depth = Number.isInteger(options?.depth) && options.depth >= 0 ? options.depth : 2;
  const maxDirs = Number.isInteger(options?.maxDirs) && options.maxDirs > 0 ? options.maxDirs : 80;
  const root = path.resolve(rootDir);
  const found = [];
  const errors = [];
  const visited = new Set([root.toLowerCase()]);
  let queue = [root];
  let scanned = 0;
  let level = 0;
  let truncated = false;
  while (queue.length > 0 && level <= depth) {
    const next = [];
    for (const dir of queue) {
      if (scanned >= maxDirs) {
        truncated = true;
        break;
      }
      const inspected = inspectDirectory(dir);
      scanned += 1;
      if (inspected.error !== undefined) errors.push({ dir, message: inspected.error });
      if (inspected.matches.length > 0) found.push(inspected);
      if (level === depth) continue;
      for (const name of inspected.dirs) {
        if (isIgnoredDir(name)) continue;
        const child = path.join(dir, name);
        const key = child.toLowerCase();
        if (visited.has(key)) continue;
        visited.add(key);
        next.push(child);
      }
    }
    queue = next;
    level += 1;
  }
  return { root, scanned, truncated, found, errors };
}

/**
 * 向上扫描父目录（只看每一层本身，不下钻），用于工作区缺少项目证据时找项目根。
 * @param startDir 起点目录（通常为会话工作目录）。
 * @param levels 最多上溯层数。
 * @returns `[{ dir, matches, vcs, error? }]`，从最近的父目录往外。
 */
export function scanAncestors(startDir, levels) {
  const limit = Number.isInteger(levels) && levels > 0 ? levels : 8;
  const chain = [];
  let current = path.dirname(path.resolve(startDir));
  while (chain.length < limit) {
    const parent = path.dirname(current);
    if (current === parent) break;
    const inspected = inspectDirectory(current);
    const vcs = inspected.dirs.some((name) => name.toLowerCase() === '.git')
      || inspected.files.some((name) => name.toLowerCase() === '.git');
    chain.push({
      dir: current,
      matches: inspected.matches,
      vcs,
      ...(inspected.error === undefined ? {} : { error: inspected.error })
    });
    current = parent;
  }
  return chain;
}
