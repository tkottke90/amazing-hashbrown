export enum CUSTOM_TAGS {
  /**
   * This tag indicates that a test requires a live connection to a Large Language Model (LLM) to be
   * performed.  These should be skipped in CICD Pipelines to avoid cost
   */
  LLM = '@llm',

  /**
   * This tag indicates that a test requires a human in the loop (e.g. it calls
   * promptPassFail from lib/interactivity.ts) and can only run in an interactive
   * terminal. These should be skipped in CI/CD pipelines, which have no one to answer.
   */
  LOCAL = '@local',
}
