import matter from 'gray-matter';

interface BaseFile {
  /**
   * Relative path to the file on disk, relative to the wiki root directory.
   */
  filename: string;

  /**
   * The content of the file.  This is the raw markdown content of the file, without any frontmatter.
   */
  content: string;

  /**
   * The date the file was created.  This is used to determine if the file has changed since it was last read.
   */
  created: Date;

  /**
   * The date the file was last modified.  This is used to determine if the file has changed since it was last read.
   */
  lastModified: Date;
}

export interface WikiFile<T = Record<string, unknown>> extends BaseFile, T {
  /**
   * Title of the file.  This is used to display the file in the UI and should be a human-readable string.
   */
  title: string;

  /**
   * SHA256 hash of the file contents.  This can be used to determine if the file has changed since it was last read.
   */
  sha: string;

  /**
   * Collection of types that the a file can be assigned
   */
  type: 'entity' | 'concept' | 'query' | 'runbook' | 'index' | 'log';
}

