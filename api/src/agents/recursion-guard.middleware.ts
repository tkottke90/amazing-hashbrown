import { interrupt } from '@langchain/langgraph';
import { isAIMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

export function createRecursionGuardMiddleware(recursionLimit: number, warnThreshold: number) {
  const threshold = Math.floor(recursionLimit * warnThreshold);

  return createMiddleware({
    name: 'RecursionGuardMiddleware',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    beforeAgent: async (state: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const completedSteps: number = (state.messages as any[]).filter(isAIMessage).length;

      // Skip before any work is done. Fire at multiples of threshold so the agent
      // gets a fresh interval between consecutive resumes (e.g., at 75, 150, …).
      if (completedSteps === 0 || completedSteps % threshold !== 0) return undefined;

      // interrupt() suspends the graph while it is still alive. On resume,
      // it returns the user's answer string with a fresh recursion budget.
      const answer = interrupt({
        kind: 'recursion_limit_warning',
        question: `I've been working for ${completedSteps} LLM calls and want to check in before continuing. What would you like me to do?`,
        choices: ['Continue working', 'Stop and summarize what you have done so far'],
        allowFreeText: true,
        stepsUsed: completedSteps,
        recursionLimit,
      });

      // Inject non-"continue" answers as guidance so the LLM sees the direction.
      if (typeof answer === 'string' && answer !== 'Continue working') {
        const { HumanMessage } = await import('@langchain/core/messages');
        return { messages: [new HumanMessage(`[User guidance]: ${answer}`)] };
      }
      return undefined;
    },
  });
}
