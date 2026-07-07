import type { Message } from '../types/message.js';
import type { BaseCompleteOptions, InferenceAdapter, InferenceResponse } from '../types/inference.js';

export class NullInferenceAdapter implements InferenceAdapter {
  async invoke(_messages: Message[], _options?: BaseCompleteOptions): Promise<InferenceResponse> {
    return {
      message: { role: 'assistant', content: '' },
    };
  }
}
