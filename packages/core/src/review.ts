import { randomUUID } from 'node:crypto';

export interface ReviewItem {
  /** Name of the decision that asked for review. */
  decision: string;
  /**
   * What a reviewer needs to see. By default this is the redacted state the model saw, not the raw
   * request. Override per gate with `reviewPayload` when a reviewer needs more (and may hold it).
   */
  payload: unknown;
  /** The verdict's reason, when the policy gave one. */
  reason?: string;
}

/** Where "needs a human" cases go. Implement it over Bull, a table, a ticket system, anything. */
export interface ReviewQueue {
  /** Throw to refuse the item; a gate then fails closed with 503. */
  enqueue(item: ReviewItem): Promise<{ id: string }>;
}

/**
 * Default queue: bounded, in memory. Fine for tests and demos, not for production. When full it
 * refuses new items, so an attacker who can trigger "review" cannot grow memory without limit.
 */
export class InMemoryReviewQueue implements ReviewQueue {
  readonly items: (ReviewItem & { id: string })[] = [];

  constructor(private readonly maxItems = 1000) {}

  async enqueue(item: ReviewItem): Promise<{ id: string }> {
    if (this.items.length >= this.maxItems) {
      throw new Error(`Review queue is full (${this.maxItems} items).`);
    }
    const id = randomUUID();
    this.items.push({ ...item, id });
    return { id };
  }
}
