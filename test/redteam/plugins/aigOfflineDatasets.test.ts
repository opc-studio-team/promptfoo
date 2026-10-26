import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithCache } from '../../../src/cache';
import { fetchHuggingFaceDataset } from '../../../src/integrations/huggingfaceDatasets';
import logger from '../../../src/logger';
import { fetchWithProxy, fetchWithTimeout } from '../../../src/util/fetch/index';

vi.mock('../../../src/logger');
vi.mock('../../../src/integrations/huggingfaceDatasets', () => ({
  fetchHuggingFaceDataset: vi.fn(),
}));
vi.mock('../../../src/util/fetch/index', async (original) => ({
  ...(await original()),
  fetchWithProxy: vi.fn(),
  fetchWithTimeout: vi.fn(),
}));
vi.mock('../../../src/cache', async (original) => ({
  ...(await original()),
  fetchWithCache: vi.fn(),
}));

const provider = { id: () => 'synthetic', callApi: vi.fn() };
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const cases = [
  {
    id: 'aegis',
    file: 'aegis.json',
    data: [{ vars: { text: 'synthetic aegis', text_type: 'user_message', labels_0: 'synthetic' } }],
    load: async () =>
      new (await import('../../../src/redteam/plugins/aegis')).AegisPlugin(
        provider,
        'synthetic',
        'prompt',
      ),
  },
  {
    id: 'beavertails',
    file: 'beavertails.json',
    data: [
      { vars: { prompt: 'synthetic beaver', is_safe: false, category: 'animal_abuse' } },
      { vars: { prompt: 'safe excluded', is_safe: true } },
    ],
    load: async () =>
      new (await import('../../../src/redteam/plugins/beavertails')).BeavertailsPlugin(
        provider,
        'synthetic',
        'prompt',
      ),
  },
  {
    id: 'cyberseceval',
    file: 'cyberseceval.json',
    data: [
      {
        user_input: 'synthetic cyber',
        test_case_prompt: 'local',
        judge_question: 'synthetic?',
        speaking_language: 'English',
      },
    ],
    load: async () =>
      new (await import('../../../src/redteam/plugins/cyberseceval')).CyberSecEvalPlugin(
        provider,
        'synthetic',
        'prompt',
      ),
  },
  {
    id: 'donotanswer',
    file: 'donotanswer.csv',
    data: 'id,risk_area,types_of_harm,specific_harms,question\n1,synthetic,synthetic,synthetic,synthetic question\n',
    load: async () =>
      new (await import('../../../src/redteam/plugins/donotanswer')).DoNotAnswerPlugin(
        provider,
        'synthetic',
        'prompt',
      ),
  },
  {
    id: 'harmbench',
    file: 'harmbench.csv',
    data: 'Behavior,SemanticCategory,FunctionalCategory,BehaviorID\nsynthetic behavior,chemical_biological,standard,fixture\n',
    load: async () =>
      new (await import('../../../src/redteam/plugins/harmbench')).HarmbenchPlugin(
        provider,
        'synthetic',
        'prompt',
      ),
  },
  {
    id: 'toxic-chat',
    file: 'toxic-chat.json',
    data: [
      { vars: { prompt: 'synthetic prompt field', toxicity: 1 } },
      { vars: { user_input: 'synthetic user_input field', jailbreaking: 1 } },
      { vars: { prompt: 'safe excluded', toxicity: 0 } },
    ],
    load: async () =>
      new (await import('../../../src/redteam/plugins/toxicChat')).ToxicChatPlugin(
        provider,
        'synthetic',
        'prompt',
      ),
  },
  {
    id: 'unsafebench',
    file: 'unsafebench.json',
    data: [
      {
        image: png,
        category: 'Violence',
        safety_label: 'unsafe',
        text: 'synthetic image description',
      },
    ],
    load: async () =>
      new (await import('../../../src/redteam/plugins/unsafebench')).UnsafeBenchPlugin(
        provider,
        'synthetic',
        'prompt',
      ),
  },
  {
    id: 'vlguard',
    file: 'vlguard.json',
    data: [
      {
        image: png,
        category: 'Privacy',
        subcategory: 'Personal data',
        question: 'synthetic image question',
        safe: false,
      },
    ],
    load: async () =>
      new (await import('../../../src/redteam/plugins/vlguard')).VLGuardPlugin(
        provider,
        'synthetic',
        'prompt',
      ),
  },
  {
    id: 'vlsu',
    file: 'vlsu.csv',
    data: `prompt,image_grade,consensus_text_grade,consensus_combined_grade,image_category,text_category,combined_category,web_path,uuid\nsynthetic image,safe,safe,unsafe,C1,C1,C1,"${png}",fixture\n`,
    load: async () =>
      new (await import('../../../src/redteam/plugins/vlsu')).VLSUPlugin(
        provider,
        'synthetic',
        'prompt',
      ),
  },
  {
    id: 'xstest',
    file: 'xstest.csv',
    data: 'prompt,label,focus,type,note\nsynthetic xs,safe,synthetic,synthetic,fixture\n',
    load: async () =>
      new (await import('../../../src/redteam/plugins/xstest')).XSTestPlugin(
        provider,
        'synthetic',
        'prompt',
      ),
  },
];
let dir: string;
const network = [fetchHuggingFaceDataset, fetchWithProxy, fetchWithTimeout, fetchWithCache];
let allowedNetwork: typeof fetchHuggingFaceDataset | undefined;

beforeEach(async () => {
  vi.resetModules(); // Reset dataset-manager singleton caches between fixtures.
  allowedNetwork = undefined;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aig-datasets-'));
  vi.stubEnv('PROMPTFOO_LOCAL_DATASETS_DIR', dir);
  vi.stubEnv('PROMPTFOO_DISABLE_REMOTE_GENERATION', 'false');
  vi.stubEnv('PROMPTFOO_DISABLE_REMOTE_DATASET_FETCH', 'true');
  for (const fn of network) {
    vi.mocked(fn).mockReset().mockRejectedValue(new Error('Unexpected synthetic network call'));
  }
});
afterEach(async () => {
  for (const fn of network) {
    if (fn !== allowedNetwork) {
      expect(fn).not.toHaveBeenCalled();
    }
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe.each(cases)('AIG local dataset $id', ({ id, file, data, load }) => {
  it.each(['true', 'false'])(
    'prefers local valid JSON/CSV with remote disabled=%s',
    async (disabled) => {
      vi.stubEnv('PROMPTFOO_DISABLE_REMOTE_DATASET_FETCH', disabled);
      await fs.writeFile(
        path.join(dir, file),
        typeof data === 'string' ? data : JSON.stringify(data),
      );
      const tests = await (await load()).generateTests(id === 'toxic-chat' ? 2 : 1);
      expect(tests).toHaveLength(id === 'toxic-chat' ? 2 : 1);
      expect(tests.every((test) => typeof test.vars?.prompt === 'string')).toBe(true);
      if (id === 'toxic-chat') {
        expect(tests.map((test) => test.vars?.prompt).sort()).toEqual([
          'synthetic prompt field',
          'synthetic user_input field',
        ]);
      }
      if (id === 'unsafebench') {
        expect(tests[0].vars?.text).toBe('synthetic image description');
        expect(tests[0].metadata?.text).toBe('synthetic image description');
      }
    },
  );

  it.each(['missing', 'malformed', 'general-disable'])(
    'reports %s data without network fallback',
    async (mode) => {
      if (mode === 'general-disable') {
        vi.stubEnv('PROMPTFOO_DISABLE_REMOTE_GENERATION', 'true');
        vi.stubEnv('PROMPTFOO_DISABLE_REMOTE_DATASET_FETCH', 'false');
      }
      if (mode === 'malformed') {
        await fs.writeFile(path.join(dir, file), file.endsWith('.json') ? '{invalid' : '"unclosed');
      }
      const plugin = await load();
      await plugin.generateTests(1).then(
        (tests) => expect(tests).toHaveLength(0),
        (error) => expect(error).toBeInstanceOf(Error),
      );
      expect(logger.warn).toHaveBeenCalled();
    },
  );
});

it.each(['missing', 'malformed'])(
  'permits mocked remote fallback only when authorized: %s',
  async (mode) => {
    vi.stubEnv('PROMPTFOO_DISABLE_REMOTE_DATASET_FETCH', 'false');
    if (mode === 'malformed') {
      await fs.writeFile(path.join(dir, 'aegis.json'), '{invalid');
    }
    allowedNetwork = fetchHuggingFaceDataset;
    vi.mocked(fetchHuggingFaceDataset).mockResolvedValue([
      { vars: { text: 'synthetic remote fixture', text_type: 'user_message' } },
    ]);
    const { AegisPlugin } = await import('../../../src/redteam/plugins/aegis');
    expect(await new AegisPlugin(provider, 'synthetic', 'prompt').generateTests(1)).toHaveLength(1);
    expect(fetchHuggingFaceDataset).toHaveBeenCalledTimes(1);
  },
);

it('keeps Pliny remote-only and does not fetch when disabled', async () => {
  const { PlinyPlugin } = await import('../../../src/redteam/plugins/pliny');
  expect(await new PlinyPlugin(provider, 'synthetic', 'prompt').generateTests(1)).toEqual([]);
});

it('blocks VLSU remote image URLs as well as dataset downloads', async () => {
  const { fetchImageAsBase64 } = await import('../../../src/redteam/plugins/imageDatasetUtils');
  expect(await fetchImageAsBase64('https://synthetic.invalid/image.png', 'vlsu')).toBeNull();
});

it('normalizes CyberSecEval language and preserves missing-language fallback', async () => {
  const records = [
    { user_input: 'synthetic Chinese', judge_question: 'synthetic?', speaking_language: 'Chinese' },
    { user_input: 'synthetic English', judge_question: 'synthetic?', speaking_language: 'English' },
  ];
  await fs.writeFile(path.join(dir, 'cyberseceval_multilingual.json'), JSON.stringify(records));
  const { CyberSecEvalPlugin } = await import('../../../src/redteam/plugins/cyberseceval');
  const chinese = await new CyberSecEvalPlugin(provider, 'synthetic', 'prompt', {
    language: 'zh',
  }).generateTests(1);
  expect(chinese[0].vars?.prompt).toBe('synthetic Chinese');
  const fallback = await new CyberSecEvalPlugin(provider, 'synthetic', 'prompt', {
    language: 'ja',
  }).generateTests(2);
  expect(fallback).toHaveLength(2);
});
