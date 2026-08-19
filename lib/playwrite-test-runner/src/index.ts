import { Page, test, TestDetails, TestInfo } from "@playwright/test";

export { TAGS } from './tags.js';


type TestMarker = boolean | string | (() => boolean | string);

interface TestMarkers {
  slow?: TestMarker;
  skip?: TestMarker;
  fail?: TestMarker;
  fixme?: TestMarker;
}

interface BaseTestProps extends TestDetails, TestMarkers {
  recordVideo?: boolean;
}

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

  test.info().annotations.push({ type: 'step.action', description: step.action });
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

export function suiteRunner(suite: TestSuite): void {
  test.describe(`[${suite.id}] ${suite.name}`, () => {
    // Register suite-level hooks if they are provided. These must be
    // registered synchronously inside test.describe() — Playwright rejects
    // beforeAll/afterAll/beforeEach/afterEach calls made from within a
    // running test() body.
    if (suite.afterAll) test.afterAll(suite.afterAll);
    if (suite.beforeAll) test.beforeAll(suite.beforeAll);
    if (suite.afterEach) test.afterEach(suite.afterEach);
    if (suite.beforeEach) test.beforeEach(suite.beforeEach);

    // Create a test for the suite
    test(`[${suite.id}] ${suite.name}`, async ({ page }) => {
      // Set Metadata
      suiteAnnotations(suite)

      // Set the suite-level test markers
      addTestMarkers(suite);

      // A plain forEach won't await each async test.step() call, so steps
      // would fire concurrently instead of running in the order the suite
      // describes them — a for..of loop keeps them sequential.
      for (const [index, step] of suite.steps.entries()) {
        await test.step(`[${suite.id}.${index}] ${step.action}`, async () => {
          // Set the step-level test markers
          addTestMarkers(step);
          // Setup annotations/tags for tests
          testAnnotations(step, suite);

          await testRunner(page, step.test)
        })
      }
    });
  });
}
