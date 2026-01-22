/*
 * Main logic.
 */

// oxlint-disable no-console

import Module from "node:module";
import fs from "node:fs";
import { join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_GROUPS } from "./test_groups.ts";
import { setCurrentGroup, setCurrentRule, resetCurrentRule } from "./capture.ts";
import { FILTER_ONLY_RULE, FILTER_EXCLUDE_RULE } from "./filter.ts";
import { generateReport } from "./report.ts";
import { RuleTester, parserModules, parserModulePaths } from "./rule_tester.ts";

import type { RuleResult } from "./capture.ts";
import type { Language, TestCase } from "./rule_tester.ts";

/**
 * Definition of a test group.
 */
export interface TestGroupDefinition {
  /**
   * Name of the test group.
   */
  name: string;

  /**
   * Name of the submodule for this group.
   * i.e. name of the directory in `submodules` directory.
   */
  submoduleName: string;

  /**
   * Path to the directory containing test files for this group, relative to the submodule directory.
   */
  testFilesDirPath: string;

  /**
   * Transform test file name to test name.
   *
   * e.g.:
   * ```ts
   * (path: string) => {
   *   if (!path.endsWith(".js")) return null;
   *   return path.slice(0, -3);
   * }
   * ```
   *
   * @param filename - Filename of test file
   * @returns Name of test file if it should be run, or `null` if it should be skipped.
   */
  transformTestFilename: (filename: string) => string | null;

  /**
   * Function to run before loading any test files.
   * @param require - Require function, which requires modules relative to the test group directory
   * @param mock - Mock function, which mocks modules relative to the test group directory
   */
  prepare?: (require: NodeJS.Require, mock: (path: string, value: unknown) => void) => void;

  /**
   * Function that will be called for every failing test case.
   * If it returns `true`, the test case will be skipped.
   *
   * @param ruleName - Rule name
   * @param test - Test case
   * @param code - Code for test case
   * @param err - Error test case failed with
   * @returns `true` if test should be skipped
   */
  shouldSkipTest?: (ruleName: string, test: TestCase, code: string, err: Error) => boolean;

  /**
   * `RuleTester` instances to replace with the Oxc conformance `RuleTester`.
   *
   * - If `type` is `"local"`, `path` is a file path relative to the test group directory.
   * - If `type` is `"module"`, `path` is a module specifier.
   *   It will be resolved to a path relative to the test group directory with `require.resolve`.
   *
   * e.g.:
   * - `{ type: "local", path: "../../lib/rule-tester.js" }`
   * - `{ type: "module", path: "eslint" }`
   */
  ruleTesters: {
    type: "local" | "module";
    path: string;
  }[];

  /**
   * Known parsers to accept.
   *
   * If one of these parsers is passed as `languageOptions.parser` in test case config, Oxc parser will be used instead.
   * Otherwise, custom parsers are not accepted, and the test case will throw an error.
   *
   * - If `type` is `"local"`, `path` is a file path relative to the test group directory.
   * - If `type` is `"module"`, `path` is a module specifier.
   *   It will be resolved to a path relative to the test group directory with `require.resolve`.
   *
   * `lang` is the language to parse the test case code with when this parser is used.
   *
   * e.g. `{ type: "module", path: "@typescript-eslint/parser", lang: "ts" }`
   */
  parsers: {
    type: "local" | "module";
    path: string;
    lang: Language;
  }[];
}

/**
 * Test group with paths expanded to absolute paths.
 *
 * In this version, `testFilesDirPath` is an absolute path.
 */
export interface TestGroup extends TestGroupDefinition {
  /**
   * Absolute path to the submodule directory.
   */
  submoduleDirPath: string;
}

/**
 * Test file.
 */
interface TestFile {
  name: string;
  path: string;
}

/**
 * Mocked modules.
 * Mapping from absolute path to `module.exports` of the module.
 */
type Mocks = Map<string, unknown>;

// Paths
const CONFORMANCE_DIR_PATH = pathJoin(fileURLToPath(import.meta.url), "../..");
const SUBMODULES_DIR_PATH = pathJoin(CONFORMANCE_DIR_PATH, "submodules");
const SNAPSHOTS_DIR_PATH = pathJoin(CONFORMANCE_DIR_PATH, "snapshots");

const { createRequire } = Module;
const require = createRequire(import.meta.url);

// Run
const groups = getTestGroups();
const mocks = initMocks();
mockRuleTesters(groups, mocks);
runGroups(groups, mocks);

/**
 * Get `TestGroup` objects for all test groups.
 * @returns Test group objects
 */
function getTestGroups(): TestGroup[] {
  // oxlint-disable-next-line no-map-spread
  return TEST_GROUPS.map((group) => {
    const submoduleDirPath = pathJoin(SUBMODULES_DIR_PATH, group.submoduleName),
      testFilesDirPath = pathJoin(submoduleDirPath, group.testFilesDirPath);
    return {
      ...group,
      submoduleDirPath,
      testFilesDirPath,
    };
  });
}

/**
 * Patch NodeJS CJS loader to allow mocking modules.
 *
 * Returns a `Map`. Adding entries to the map will mock the module.
 * `mocks.set("/path/to/module.js", { whatever: true })`
 *
 * @returns Mocks `Map`
 */
function initMocks(): Mocks {
  const mocks = new Map();

  const extensions = (
    Module as unknown as {
      _extensions: Record<string, (module: Module, path: string, ...args: any[]) => any>;
    }
  )._extensions;

  for (const [ext, loader] of Object.entries(extensions)) {
    extensions[ext] = function (module: Module, path: string, ...args: any[]) {
      if (!mocks.has(path)) return loader.call(this, module, path, ...args);
      module.exports = mocks.get(path);
    };
  }

  return mocks;
}

/**
 * Mock any `RuleTester` instances specified in any test groups.
 * When these rule tester files are `require`-ed, Oxlint's conformance `RuleTester` will be substituted.
 *
 * @param groups - Test groups
 */
function mockRuleTesters(groups: TestGroup[], mocks: Mocks) {
  console.log("Patching rule testers...");

  // `RuleTester` will be `module.exports`, so allow loading that module with either:
  // 1. `import RuleTester from "path/to/rule_tester.js";`
  // 2. `import { RuleTester } from "path/to/rule_tester.js";`
  // @ts-expect-error - not a property of `RuleTester`
  RuleTester.RuleTester = RuleTester;

  for (const group of groups) {
    for (const ruleTesterProps of group.ruleTesters) {
      let ruleTesterPath: string;
      if (ruleTesterProps.type === "local") {
        ruleTesterPath = pathJoin(group.submoduleDirPath, ruleTesterProps.path);
      } else {
        const require = createRequire(pathJoin(group.testFilesDirPath, "dummy.js"));
        ruleTesterPath = require.resolve(ruleTesterProps.path);
      }
      mocks.set(ruleTesterPath, RuleTester);
    }
  }
}

/**
 * Run all test groups.
 * @param groups - Test groups
 */
function runGroups(groups: TestGroup[], mocks: Mocks) {
  for (const group of groups) {
    runGroup(group, mocks);
  }
}

/**
 * Run all tests in a test group.
 * @param group - Test group
 */
function runGroup(group: TestGroup, mocks: Mocks) {
  setCurrentGroup(group);

  const groupName = group.name;

  // Run `prepare` function
  const { prepare } = group;
  if (prepare) {
    console.log(`Running prepare hook for ${groupName}...`);
    const require = createRequire(pathJoin(group.testFilesDirPath, "dummy.js"));

    const mock = (path: string, value: unknown) => {
      mocks.set(path, value);
    };

    prepare(require, mock);
  }

  // Get custom parsers
  console.log(`Loading custom parsers for ${groupName}...`);

  parserModules.clear();
  parserModulePaths.clear();

  for (const group of groups) {
    for (const parserProps of group.parsers) {
      let path: string, parser: unknown;
      if (parserProps.type === "local") {
        path = pathJoin(group.testFilesDirPath, parserProps.path);
        parser = require(path);
      } else {
        const require = createRequire(pathJoin(group.testFilesDirPath, "dummy.js"));
        path = require.resolve(parserProps.path);
        parser = require(parserProps.path);
      }

      parserModules.set(parser, parserProps.lang);
      parserModulePaths.set(path, parserProps.lang);
    }
  }

  console.log(`Finding rule test files for ${groupName}...`);
  const files = findTestFiles(group);
  console.log(`Found ${files.length} test files\n`);

  console.log(`Running tests for ${groupName}...`);
  const results = runAllTests(files);

  // Write results to markdown file
  const snapshotPath = pathJoin(SNAPSHOTS_DIR_PATH, `${groupName}.md`);

  const report = generateReport(group.name, results);
  fs.writeFileSync(snapshotPath, report);
  console.log(`\nResults written to: ${snapshotPath}`);

  // Print summary
  const totalRuleCount = results.length;
  let loadErrorCount = 0,
    fullyPassingCount = 0;

  for (const rule of results) {
    if (rule.isLoadError) {
      loadErrorCount++;
    } else {
      const { tests } = rule;
      if (tests.length > 0 && tests.every((test) => test.isPassed || test.isSkipped)) {
        fullyPassingCount++;
      }
    }
  }

  console.log("\n=====================================");
  console.log("Summary:");
  console.log(`  Total rules: ${totalRuleCount}`);
  console.log(`  Fully passing: ${fullyPassingCount}`);
  console.log(`  Load errors: ${loadErrorCount}`);
  console.log(`  With failures: ${totalRuleCount - fullyPassingCount - loadErrorCount}`);
}

/**
 * Find all ESLint rule test files.
 * @param group - Test group
 * @returns Test file details
 */
function findTestFiles(group: TestGroup): TestFile[] {
  const filenames = fs.readdirSync(group.testFilesDirPath);

  let nameMatchesFilter = null;
  if (FILTER_ONLY_RULE !== null) {
    nameMatchesFilter = Array.isArray(FILTER_ONLY_RULE)
      ? (name: string) => FILTER_ONLY_RULE!.includes(name)
      : (name: string) => name === FILTER_ONLY_RULE;
  } else if (FILTER_EXCLUDE_RULE !== null) {
    nameMatchesFilter = Array.isArray(FILTER_EXCLUDE_RULE)
      ? (name: string) => !FILTER_EXCLUDE_RULE!.includes(name)
      : (name: string) => name !== FILTER_EXCLUDE_RULE;
  }

  const files: TestFile[] = [];
  for (const filename of filenames) {
    const name = group.transformTestFilename(filename);
    if (name === null) continue;
    if (nameMatchesFilter !== null && !nameMatchesFilter(name)) continue;

    const path = pathJoin(group.testFilesDirPath, filename);
    files.push({ name: name, path });
  }
  return files;
}

/**
 * Run all test files for a group.
 * @param testFiles - Test files
 * @returns Results of running tests
 */
function runAllTests(testFiles: TestFile[]): RuleResult[] {
  const results = [];

  for (let i = 0; i < testFiles.length; i++) {
    const testFile = testFiles[i];
    process.stdout.write(`[${i + 1}/${testFiles.length}] Testing ${testFile.name}...`);

    const result = runRuleTests(testFile);
    results.push(result);

    if (result.isLoadError) {
      console.log(" LOAD ERROR");
    } else {
      const { tests } = result,
        totalCount = tests.length;

      let passedCount = 0,
        skippedCount = 0;
      for (const test of tests) {
        if (test.isPassed) passedCount++;
        if (test.isSkipped) skippedCount++;
      }

      const status = passedCount + skippedCount === totalCount ? "PASS" : "FAIL";
      let message = ` ${status} (${passedCount}/${totalCount})`;
      if (skippedCount > 0) message += ` (${skippedCount} skipped)`;
      console.log(message);
    }
  }

  return results;
}

/**
 * Run tests for a single rule file.
 * @param testFile - Test file details
 * @returns Results of running tests for rule
 */
function runRuleTests(testFile: TestFile): RuleResult {
  const result: RuleResult = {
    ruleName: testFile.name,
    isLoadError: false,
    loadError: null,
    tests: [],
  };

  setCurrentRule(result);

  // Load the test file - this will execute the tests
  try {
    require(testFile.path);
  } catch (err) {
    result.isLoadError = true;
    result.loadError = err as Error;
  }

  resetCurrentRule();

  return result;
}
