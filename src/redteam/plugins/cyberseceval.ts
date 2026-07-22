import fs from 'fs/promises';
import path from 'path';

import { getEnvString } from '../../envars';
import logger from '../../logger';
import { getRequestTimeoutMs } from '../../providers/shared';
import { fetchWithTimeout } from '../../util/fetch/index';
import { RedteamPluginBase } from './base';

import type { Assertion, TestCase } from '../../types/index';

const PLUGIN_ID = 'promptfoo:redteam:cyberseceval';

// Use a specific tag to ensure stability - update when datasets change
const DATASET_VERSION = '0.119.14';

const DATASET_URL = `https://raw.githubusercontent.com/promptfoo/promptfoo/refs/tags/${DATASET_VERSION}/examples/cyberseceval/prompt_injection.json`;

const DATASET_URL_MULTILINGUAL = `https://raw.githubusercontent.com/promptfoo/promptfoo/refs/tags/${DATASET_VERSION}/examples/cyberseceval/prompt_injection_multilingual.json`;

interface CyberSecEvalInput {
  test_case_prompt: string;
  user_input: string;
  judge_question: string;
  injection_type: string;
  injection_variant: string;
  risk_category: string;
  speaking_language: string;
}

type CyberSecEvalVars = Record<string, string>;

interface CyberSecEvalTestCase extends TestCase {
  vars: CyberSecEvalVars;
}

// Language code → full name mapping for speaking_language filtering.
const LANGUAGE_CODE_MAP: Record<string, string> = {
  zh: 'Chinese',
  en: 'English',
  hi: 'Hindi',
  bn: 'Bengali',
  tr: 'Turkish',
  ar: 'Arabic',
  it: 'Italian',
  es: 'Spanish',
  vi: 'Vietnamese',
  fr: 'French',
  ru: 'Russian',
  tl: 'Filipino/Tagalog',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  de: 'German',
  id: 'Indonesian',
  th: 'Thai',
};

function normalizeLanguage(lang: string): string {
  const lower = lang.toLowerCase().trim();
  if (LANGUAGE_CODE_MAP[lower]) {
    return LANGUAGE_CODE_MAP[lower];
  }
  return lang.charAt(0).toUpperCase() + lang.slice(1).toLowerCase();
}

async function fetchDataset(
  limit: number,
  isMultilingual: boolean,
  language?: string,
): Promise<CyberSecEvalTestCase[]> {
  const normalizedLang = language ? normalizeLanguage(language) : undefined;
  const useMultilingual = isMultilingual || (!!normalizedLang && normalizedLang !== 'English');

  const localDir = getEnvString('PROMPTFOO_LOCAL_DATASETS_DIR');
  if (localDir) {
    try {
      const filename = useMultilingual ? 'cyberseceval_multilingual.json' : 'cyberseceval.json';
      const filePath = path.join(localDir, filename);
      const raw = await fs.readFile(filePath, 'utf8');
      const data: CyberSecEvalInput[] = JSON.parse(raw);

      if (!data || !Array.isArray(data)) {
        throw new Error(`[CyberSecEval] Invalid local dataset at ${filePath}`);
      }

      let filtered = data;
      if (normalizedLang) {
        const matching = data.filter((item) => (item as any).speaking_language === normalizedLang);
        if (matching.length > 0) {
          filtered = matching;
          logger.debug(
            `[CyberSecEval] Language filter "${normalizedLang}" → ${matching.length} records from ${filename}`,
          );
        } else {
          logger.warn(
            `[CyberSecEval] No "${normalizedLang}" entries in ${filename}, using all ${data.length} records`,
          );
        }
      }

      // Apply the same shuffle-and-slice logic as the remote path
      const testCases = filtered
        .map((item) => ({
          vars: {
            prompt: item.user_input,
            test_case_prompt: item.test_case_prompt,
            user_input: item.user_input,
            judge_question: item.judge_question,
            injection_type: item.injection_type,
            injection_variant: item.injection_variant,
            risk_category: item.risk_category,
            speaking_language: item.speaking_language,
          },
          metadata: {},
        }))
        .sort(() => Math.random() - 0.5) as CyberSecEvalTestCase[];
      return testCases.slice(0, limit);
    } catch (err) {
      logger.warn(`[cyberseceval] Failed to load local dataset, falling back to remote: ${err}`);
    }
  }

  try {
    const url = useMultilingual ? DATASET_URL_MULTILINGUAL : DATASET_URL;
    const response = await fetchWithTimeout(url, {}, getRequestTimeoutMs());
    if (!response.ok) {
      throw new Error(`[CyberSecEval] HTTP status: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as CyberSecEvalInput[];

    if (!data || !Array.isArray(data)) {
      throw new Error(`[CyberSecEval] Invalid response from ${DATASET_URL}`);
    }

    let filtered = data;
    if (normalizedLang) {
      const matching = data.filter((item) => (item as any).speaking_language === normalizedLang);
      if (matching.length > 0) {
        filtered = matching;
      } else {
        logger.warn(
          `[CyberSecEval] No "${normalizedLang}" entries in remote dataset, using all ${data.length} records`,
        );
      }
    }

    // Convert the raw data to test cases and shuffle them
    const testCases = filtered
      .map(
        (input): CyberSecEvalTestCase => ({
          vars: {
            test_case_prompt: input.test_case_prompt,
            user_input: input.user_input,
            judge_question: input.judge_question,
            speaking_language: (input as any).speaking_language as string,
          },
        }),
      )
      .sort(() => Math.random() - 0.5) // Shuffle the array
      .slice(0, limit); // Take the first n items after shuffling

    logger.debug(`[CyberSecEval] Generated ${testCases.length} test cases`);
    if (testCases.length === 0) {
      throw new Error(`[CyberSecEval] No test cases generated`);
    }

    return testCases;
  } catch (error) {
    logger.error(`[CyberSecEval] Error fetching dataset: ${error}`);
    return [];
  }
}

export class CyberSecEvalPlugin extends RedteamPluginBase {
  readonly id = PLUGIN_ID;
  static readonly canGenerateRemote = false;

  async getTemplate(): Promise<string> {
    throw new Error('Not implemented');
  }

  getAssertions(prompt: string): Assertion[] {
    return [
      {
        metric: 'CyberSecEval',
        type: 'llm-rubric',
        value: `${prompt}. If yes, fail. Otherwise, pass.`,
      },
    ];
  }

  async generateTests(n: number, _delayMs?: number): Promise<TestCase[]> {
    const language = this.config.language as string | undefined;
    const testCases = await fetchDataset(n, this.config.multilingual as boolean, language);

    return testCases.map((test) => ({
      vars: {
        [this.injectVar]: test.vars.user_input,
      },
      assert: [
        {
          metric: 'CyberSecEval',
          type: 'llm-rubric',
          value: `${test.vars.judge_question}. If yes, fail. Otherwise, pass.`,
        },
      ],
    }));
  }
}
