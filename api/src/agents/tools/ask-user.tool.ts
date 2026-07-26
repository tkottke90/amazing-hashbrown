import { tool } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
import { z } from 'zod';

const AskUserSchema = z.object({
  question: z.string().describe('The question to present to the user'),
  // `kind` was originally required. Made optional (defaulting to free_text)
  // after four consecutive wiki-navigation wnav-004 runs where glm reasons
  // "I should ask the user" and then emits prose with no tool call at all —
  // while reliably calling every wiki_* tool, all of which require only one
  // or two plain strings. The system-prompt header (eighth tightening)
  // flagged this tool's required enum + five optionals as the untested
  // variable once wording had plateaued; this tests that hypothesis. zod
  // fills the default before the value reaches interrupt(), so the
  // hitl_prompt payload contract (stream-handler.ts) still always has kind.
  kind: z
    .enum(['yes_no', 'multiple_choice', 'free_text'])
    .default('free_text')
    .describe('The format of the expected answer (default: free_text)'),
  choices: z
    .array(z.string())
    .optional()
    .describe('Required for multiple_choice: the list of options to present'),
  allowFreeText: z
    .boolean()
    .optional()
    .describe(
      'multiple_choice only: also show a free-text input so the user can type a custom answer',
    ),
  approveLabel: z
    .string()
    .optional()
    .describe('yes_no only: label for the affirmative button (default: "Yes")'),
  approveType: z
    .enum(['primary', 'secondary', 'destructive'])
    .optional()
    .describe('yes_no only: visual style of the affirmative button (default: "primary")'),
  rejectLabel: z
    .string()
    .optional()
    .describe('yes_no only: label for the negative button (default: "No")'),
});

export const askUserTool = tool(
  async (input: z.infer<typeof AskUserSchema>) => {
    // interrupt() suspends graph execution. The value passed here becomes the
    // hitl_prompt payload sent to the frontend. When the graph is resumed via
    // Command({ resume: answer }), interrupt() returns that answer string.
    const answer = interrupt(input);
    return `User answered: ${String(answer)}`;
  },
  {
    name: 'ask_user',
    description:
      'Ask the human user a question and pause until they respond. ' +
      'Only "question" is required. Optionally set kind="yes_no" for boolean decisions or ' +
      '"multiple_choice" with choices for selecting from a list; omitting kind means free text.',
    schema: AskUserSchema,
  },
);
