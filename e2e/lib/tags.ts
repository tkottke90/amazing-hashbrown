export enum CUSTOM_TAGS {
  /**
   * This tag indicates that a test requires a live connection to a Large Language Model (LLM) to be
   * performed.  These should be skipped in CICD Pipelines to avoid cost
   */
  LLM = '@llm',
}
