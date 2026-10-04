import { MemoryBudgetStore } from '@nest-decisions/core';
import { describe, expect, it } from 'vitest';
import { budgetStoreContract } from '../src';

// The shared contract, run against the default in-memory store.
budgetStoreContract(
  { describe, it, expect } as never,
  'MemoryBudgetStore',
  () => new MemoryBudgetStore(),
);
