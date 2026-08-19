export enum TAGS {

  /**
   * User workflow tests are tests which follow the actions of an end user to complete a specific
   * task. This is typically a suite level tag.
   */
  UserWorkflow = '@user-workflow',


  /**
   * Functional tests focus on non-user workflows such as automation. These tests can trigger processes
   * both using the UI or other mechanisms (API, WS, etc) and focus on validating a process which indirectly
   * related to users use OR when the trigger is not a user.  This is typically a suite level tag
   */
  Functional = '@functional',

  /**
   * Smoke tests focus on simple, quick to validate items and are the primary driver for sanity checks post-release.
   * They should importantly NOT make any data changes and simply validate that are running as expected.
   */
  Smoke = '@smoke',

  /**
   * Unlike smoke tests, comprehensive tests focus on full validation of a process or step.  Ideally these
   * tests SHOULD make changes to the data in order to validate that a capability is working as expected. As such
   * it is also realistic that these tests may include setup/cleanup work before/after the test to restore a specific
   * base-state to the environment.
   */
  Comprehensive = '@comprehensive',

  /**
   * Accessability testing focuses on validating accessability choices for end-users as they are implemented, supporting
   * preferences like theme, motion, color-blindness, etc.
   */
  Accessability = '@accessability'
}