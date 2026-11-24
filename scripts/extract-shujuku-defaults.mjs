// 从本机 shujuku 源码自动提取全部 10 类功能的 100% 完整官方内置默认提示词与模板，生成 src/shujuku-defaults.js。
// 以后 shujuku 升级后重新运行本脚本即可一键同步：node scripts/extract-shujuku-defaults.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHUJUKU_ROOT = path.resolve(ROOT, '../shujuku');
const OUT_FILE = path.join(ROOT, 'src/shujuku-defaults.js');

const require = createRequire(path.join(SHUJUKU_ROOT, 'node_modules/.pnpm/node_modules/esbuild/package.json'));
const esbuild = require(path.join(SHUJUKU_ROOT, 'node_modules/.pnpm/node_modules/esbuild'));

const entryCode = `
import {
  DEFAULT_CHAR_CARD_PROMPT_ACU,
  DEFAULT_CHAR_CARD_PROMPT_STRICT_JSON_ACU,
  DEFAULT_CHAR_CARD_PROMPT_SQL_STRICT_JSON_ACU,
  DEFAULT_TABLE_TEMPLATE_ACU,
  DEFAULT_TIME_RECALL_PLOT_PRESET_ACU,
  DEFAULT_CONTENT_OPTIMIZATION_PROMPT_GROUP_ACU,
} from './src/shared/defaults-json.js';
import {
  defaultVectorMemoryConfig_ACU,
  buildDefaultAgentDecisionPromptSegments_ACU,
  buildDefaultAgentSkillifyPromptSegments_ACU,
} from './src/shared/defaults.ts';
import { buildDefaultContinuationOutlinePrompt_ACU } from './src/service/continuation/defaults.ts';
import { buildDefaultContinuationAgentPrompts_ACU } from './src/service/continuation/agent/agent-defaults.ts';
import { buildDefaultWorldSimulationAgentPrompts_ACU } from './src/service/simulation/agent/agent-defaults.ts';
import { buildPseudoRoleTemplateAssistantPromptSegments_ACU } from './src/service/template-assistant/service.ts';

let parsedTemplate = DEFAULT_TABLE_TEMPLATE_ACU;
for (let i = 0; i < 3 && typeof parsedTemplate === 'string'; i++) {
  parsedTemplate = JSON.parse(parsedTemplate);
}

export const EXTRACTED = {
  plot: {
    ...JSON.parse(JSON.stringify(DEFAULT_TIME_RECALL_PLOT_PRESET_ACU)),
    name: '默认剧情推进',
  },
  tableTemplate: parsedTemplate,
  contentReplace: {
    name: '默认正文替换',
    promptGroup: JSON.parse(JSON.stringify(DEFAULT_CONTENT_OPTIMIZATION_PROMPT_GROUP_ACU)),
  },
  promptFill: {
    version: 1,
    feature: 'promptFill',
    groups: {
      ordinary: JSON.parse(JSON.stringify(DEFAULT_CHAR_CARD_PROMPT_ACU)),
      strictJson: JSON.parse(JSON.stringify(DEFAULT_CHAR_CARD_PROMPT_STRICT_JSON_ACU)),
      strictSql: JSON.parse(JSON.stringify(DEFAULT_CHAR_CARD_PROMPT_SQL_STRICT_JSON_ACU)),
    },
  },
  promptContinuation: {
    version: 1,
    feature: 'promptContinuation',
    groups: {
      outline: JSON.parse(JSON.stringify(buildDefaultContinuationOutlinePrompt_ACU())),
      ...JSON.parse(JSON.stringify(buildDefaultContinuationAgentPrompts_ACU())),
    },
  },
  promptSimulation: {
    version: 1,
    feature: 'promptSimulation',
    groups: JSON.parse(JSON.stringify(buildDefaultWorldSimulationAgentPrompts_ACU())),
  },
  promptKeyword: {
    version: 1,
    feature: 'promptKeyword',
    groups: {
      keyword: JSON.parse(JSON.stringify(defaultVectorMemoryConfig_ACU.keywordPromptGroup)),
    },
  },
  promptSummary: {
    version: 1,
    feature: 'promptSummary',
    groups: {
      summary: JSON.parse(JSON.stringify(defaultVectorMemoryConfig_ACU.summaryPromptGroup)),
    },
  },
  promptAssistant: {
    version: 1,
    feature: 'promptAssistant',
    groups: {
      assistant: JSON.parse(JSON.stringify(buildPseudoRoleTemplateAssistantPromptSegments_ACU(3))),
    },
  },
  promptAgent: {
    version: 1,
    feature: 'promptAgent',
    groups: {
      decision: JSON.parse(JSON.stringify(buildDefaultAgentDecisionPromptSegments_ACU())),
      skillify: JSON.parse(JSON.stringify(buildDefaultAgentSkillifyPromptSegments_ACU())),
    },
  },
};
`;

const result = await esbuild.build({
    stdin: {
        contents: entryCode,
        resolveDir: SHUJUKU_ROOT,
        loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    plugins: [
        {
            name: 'stub-virtual',
            setup(build) {
                build.onResolve({ filter: /^__ACU_SQLITE_ENGINE_IMPORT__$/ }, () => ({
                    path: 'stub',
                    namespace: 'stub',
                }));
                build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
                    contents: 'export default async function () { return {}; }',
                    loader: 'js',
                }));
            },
        },
    ],
});

const code = result.outputFiles[0].text;
// 提供最小浏览器全局变量桩，防止模块顶层访问 window/document 时抛错
globalThis.window ||= globalThis;
globalThis.document ||= { createElement: () => ({}), querySelector: () => null };
globalThis.localStorage ||= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const tmpFile = path.join(ROOT, 'scripts/.tmp-shujuku-defaults.cjs');
fs.writeFileSync(tmpFile, code, 'utf8');
let EXTRACTED;
try {
    ({ EXTRACTED } = require(tmpFile));
} finally {
    fs.rmSync(tmpFile, { force: true });
}

const manifest = JSON.parse(fs.readFileSync(path.join(SHUJUKU_ROOT, 'manifest.json'), 'utf8'));
const header = `// 自动提取自 shujuku v${manifest.version} 官方源码，请勿手改；升级数据库后可运行 node scripts/extract-shujuku-defaults.mjs 重新生成。\n`;
const outContent =
    header +
    `export const SHUJUKU_DEFAULTS_VERSION = ${JSON.stringify(manifest.version)};\n` +
    `export const SHUJUKU_DEFAULTS = ${JSON.stringify(EXTRACTED, null, 2)};\n`;

fs.writeFileSync(OUT_FILE, outContent, 'utf8');
for (const [k, v] of Object.entries(EXTRACTED)) {
    const info = v.groups
        ? Object.entries(v.groups)
              .map(([gk, arr]) => `${gk}:${arr.length}`)
              .join(', ')
        : v.plotTasks
          ? `tasks:${v.plotTasks.length}`
          : v.promptGroup
            ? `segs:${v.promptGroup.length}`
            : `sheets:${Object.keys(v).filter((x) => x.startsWith('sheet_')).length}`;
    console.log(`Extracted ${k} => ${info}`);
}
console.log(`Wrote ${OUT_FILE} (${(outContent.length / 1024).toFixed(1)} KB)`);
