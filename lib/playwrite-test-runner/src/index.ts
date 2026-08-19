import { Page, test, TestDetails, TestInfo } from "@playwright/test";

export { TAGS } from './tags.js';


type TestMarker = boolean | string | (() => boolean | string);

interface TestMarkers {
  slow?: TestMarker;
  skip?: TestMarker;
  fail?: TestMarker;
  fixme?: TestMarker;
}

interface BaseTestProps extends TestDetails, TestMarkers {}

export type TestAction<Args, Return = unknown> = (args: Args, testInfo: TestInfo) => Promise<Return> | Return;

/**
 * An individual test step within a test suite.  This checks a specific action and expected outcome
 * of the larger process being tested.  Each step has its own goal to verify a specific part of the
 * process.
 */
export interface TestStep<Args extends { page: Page } = { page: Page }> extends BaseTestProps {
  action: string;
  expectedOutcome: string;
  test: TestAction<Args>;
}

/**
 * A test suite is a collection of steps to achieve a larger goal.  A user typically does not typically
 * go into the application and take a single action.  It is a call and response of multiple steps working
 * in concert to achieve a larger goal.
 * 
 * @example An example is the user sending an email.  They need to take these discrete steps:
 * 
 * 1. Login to the application
 * 2. Click the "Compose" button to open the email compose window
 * 3. Enter the recipient's email address
 * 4. Enter the subject of the email
 * 5. Enter the body of the email
 * 6. Click the "Send" button to send the email
 * 
 * Each of these steps is a test step that can be tested individually, but they are all part of the larger
 * goal of sending an email.
 */
export interface TestSuite extends BaseTestProps {
  id: number;
  name: string;
  purpose: string;
  steps: TestStep[];
  beforeAll?: TestAction<{ page: Page }>;
  afterAll?: TestAction<{ page: Page }>;
  beforeEach?: TestAction<{ page: Page }>;
  afterEach?: TestAction<{ page: Page }>;
  startingPage?: string;
  recordVideo?: boolean;
}

/**
 * Processes a "Marker" which allows the test author to mark an individual step or entire suite as slow, skipped, failed, or fixme. The marker can be a boolean or a string.  
 * If it is a boolean, then the test will be marked as such with a default message. 
 * If it is a string, then the test will be marked as such with the provided message.
 * @param marker The marker to process when true or a non-empty string, it will mark the test as such.  When a string it will also mark the test with a provided message.
 * @param markerName The specific marker to process, when a boolean is provided this is used as the default message for the marker.
 * @returns A tuple of the marker boolean and the message to use for the marker.
 * 
 * @example
 * // This will mark the test as slow with the default message "Test marked as slow"
 * test.slow(...parseTestMarker(step.slow || false, 'slow'));
 * 
 * // This will mark the test as slow with the provided message "This test is slow because it takes a long time to complete"
 * test.slow(...parseTestMarker(step.slow || "This test is slow because it takes a long time to complete", 'slow'));
 */
function parseTestMarker(marker: TestMarker, markerName: 'slow' | 'skip' | 'fail' | 'fixme'): [boolean, string] {
  // Process function markers and turn them into the boolean | string variant. 
  const _marker = typeof marker === 'function'
    ? marker()
    : marker;
  
  if (typeof _marker === 'boolean') {
    return [_marker, `Test marked as ${markerName}`];
  } else if (typeof _marker === 'string') {
    return [true, _marker];
  } else {
    return [false, ''];
  }
}

/**
 * Populates the test markers on a given test step or suite based on the configuration
 * @param step Configuration for the Test Step/Suite
 */
function addTestMarkers(step: BaseTestProps): void {
  test.slow(...parseTestMarker(step.slow || false, 'slow'));
  test.skip(...parseTestMarker(step.skip || false, 'skip'));
  test.fixme(...parseTestMarker(step.fixme || false, 'fixme'));
  test.fail(...parseTestMarker(step.fail || false, 'fail'));
}

/**
 * Configure the Test Step level tags and annotations.  This ensures all the metadata for
 * a test are captured as annotations.  This also handles de-duping the tags
 * @param step The step being run
 * @param suite The suite the test is a part of
 */
function testAnnotations(step: TestStep, suite: TestSuite){
  const tags = step.tag ?
    Array.isArray(step.tag) ? step.tag : [step.tag] :
    [];
  
  // Filter out any tags that are already present in the suite's tags to avoid duplication. Suite
  // level tags are applied to any tests inside of the suite, so we don't want to duplicate them at the step level.
  test.info().tags.push(...tags.filter(tag => !suite.tag?.includes(tag)));

  test.info().annotations.push({ type: `step.action`, description: step.action });
  test.info().annotations.push({ type: 'step.expectedOutcome', description: step.expectedOutcome });
}

/**
 * Tag test suites with tags and annotations.  This is using 
 * @param suite The test suite that is being processed
 * 
 * @example
 * 
 * test.describe('[1] Test Suite', async () => {
 *   suiteAnnotations(suite)
 * })
 */
function suiteAnnotations(suite: TestSuite) {
  test.info().tags.push(...(suite.tag ?? []));

  test.info().annotations.push({ type: 'suite.id', description: String(suite.id) });
  test.info().annotations.push({ type: 'suite.name', description: suite.name });
  test.info().annotations.push({ type: 'suite.purpose', description: suite.purpose });
}


async function testRunner(page: Page, action: TestAction<{ page: Page }>): Promise<unknown> {
  return action({ page }, test.info());
}

const RECORDING_PAUSE_MS = 3000;

/**
 * Whether this suite's test will actually end up with video recorded.
 * `suite.recordVideo` is an explicit override we apply ourselves via
 * test.use() below, so it's authoritative when set. When unset, fall back
 * to the project's own configured mode — testInfo.project.use is a static
 * snapshot of the config file, so this branch is only accurate when we
 * haven't overridden it with test.use() ourselves.
 */
function isRecordingVideo(suite: TestSuite, testInfo: TestInfo): boolean {
  if (suite.recordVideo !== undefined) return suite.recordVideo;
  const video = testInfo.project.use.video;
  const mode = typeof video === 'string' ? video : video?.mode;
  return !!mode && mode !== 'off';
}

/**
 * Gives a video viewer a moment to see the "before" state before an action
 * plays out — a no-op (and no wasted time) when this suite's test isn't
 * actually being recorded. suiteRunner() already calls this once before
 * each step; call it again from inside a step's own test() body — passing
 * the same suite and the testInfo it's handed as its second argument — to
 * pace individual verifications within that step too.
 */
export async function pauseForVideo(page: Page, suite: TestSuite, testInfo: TestInfo): Promise<void> {
  if (isRecordingVideo(suite, testInfo)) {
    await page.waitForTimeout(RECORDING_PAUSE_MS);
  }
}

/**
 * Registers exactly one test() per suite (its steps run as test.step()s
 * inside it, sharing one page across the whole flow). Because of that 1:1
 * mapping, hooks/video are registered directly at the file's top level
 * rather than inside a test.describe() wrapper — a describe() around a
 * single test buys no extra scoping and would double up its title in
 * reports (e.g. "[1] Suite › [1] Suite"), and Playwright rejects
 * worker-scoped test.use({ video }) calls made inside a describe() group
 * entirely (they "force a new worker", which describe() blocks can't do).
 *
 * The tradeoff: call suiteRunner() at most once per spec file. Since
 * beforeAll/afterAll/beforeEach/afterEach and recordVideo are now
 * registered at the file's top level instead of a per-suite describe()
 * scope, a second suiteRunner() call in the same file would leak its hooks
 * and video setting onto every other suite's test in that file.
 */
export function suiteRunner(suite: TestSuite): void {
  // Register suite-level hooks if they are provided. These must be
  // registered synchronously at the top level of the file — Playwright
  // rejects beforeAll/afterAll/beforeEach/afterEach calls made from within
  // a running test() body.
  if (suite.afterAll) test.afterAll(suite.afterAll);
  if (suite.beforeAll) test.beforeAll(suite.beforeAll);
  if (suite.afterEach) test.afterEach(suite.afterEach);
  if (suite.beforeEach) test.beforeEach(suite.beforeEach);

  // suite.recordVideo is an explicit override on top of the project's own
  // video setting — leave the project default alone when it's unset. Must
  // also be top-level: test.use({ video }) forces a new worker, which
  // Playwright only allows outside a describe() group.
  if (suite.recordVideo === true) test.use({ video: 'on' });
  else if (suite.recordVideo === false) test.use({ video: 'off' });

  // Create a test for the suite
  test(`[${suite.id}] ${suite.name}`, async ({ page }) => {
    // Set Metadata
    suiteAnnotations(suite)

    // Set the suite-level test markers
    addTestMarkers(suite);

    // A recording test can accumulate several pauseForVideo() waits across
    // its steps' own verification blocks on top of the one suiteRunner()
    // adds per step — tripling the timeout keeps that pacing from blowing
    // through the default 30s budget on its own.
    if (isRecordingVideo(suite, test.info())) test.slow();

    // A plain forEach won't await each async test.step() call, so steps
    // would fire concurrently instead of running in the order the suite
    // describes them — a for..of loop keeps them sequential.
    for (const [index, step] of suite.steps.entries()) {
      await test.step(`[${suite.id}.${index}] ${step.action}`, async () => {
        // Set the step-level test markers
        addTestMarkers(step);
        // Setup annotations/tags for tests
        testAnnotations(step, suite);

        // Give a video viewer a moment to see this step's "before" state
        // before its actions run.
        await pauseForVideo(page, suite, test.info());
        await testRunner(page, step.test)
      })
    }
  });
}
