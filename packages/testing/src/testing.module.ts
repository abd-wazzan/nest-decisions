import { DecisionsModule } from '@nest-decisions/core';
import { MockProvider, type MockProviderOptions } from './mock-provider.js';

export const DecisionsTestingModule = {
  /**
   * Import in a Test.createTestingModule. Returns the module plus the provider, so a test can
   * change answers and inspect the calls:
   *
   *   const { module, provider } = DecisionsTestingModule.with({ answers: { urgent: mockNoul(0.95) } });
   */
  with(options: MockProviderOptions = {}) {
    const provider = new MockProvider(options);
    const module = DecisionsModule.forRoot({ provider, audit: { record: () => {} } });
    return { module, provider };
  },
};
