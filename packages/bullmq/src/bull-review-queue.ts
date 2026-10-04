import { randomUUID } from 'node:crypto';
import type { ReviewItem, ReviewQueue } from '@nest-decisions/core';

/**
 * The part of a BullMQ `Queue` this adapter uses. A real `Queue` from `bullmq` satisfies it, so
 * this package has no runtime dependency on BullMQ and you keep control of the connection.
 */
export interface BullQueueLike {
  add(
    name: string,
    data: ReviewJobData,
    options?: Record<string, unknown>,
  ): Promise<{ id?: string | undefined }>;
}

/** What a reviewer service finds in each job. */
export interface ReviewJobData {
  decision: string;
  /** The redacted state the model saw (or what the gate's `reviewPayload` returned). */
  payload: unknown;
  /** The policy's reason for asking for review, when it gave one. */
  reason?: string;
  /** ISO timestamp of when the request was held. */
  queuedAt: string;
}

export interface BullReviewQueueOptions {
  queue: BullQueueLike;
  /** Job name. Default `review`. */
  jobName?: string;
  /**
   * Extra BullMQ job options, for example `{ removeOnComplete: { age: 7 * 24 * 3600 } }`. Review
   * jobs are not meant to be processed automatically: they wait until a person decides.
   */
  jobOptions?: Record<string, unknown>;
}

/**
 * A review queue that survives restarts and is shared by every instance: a request a gate holds
 * for a human becomes a BullMQ job in Redis, and a reviewer service reads it from there.
 *
 *   DecisionsModule.forRoot({ provider, reviewQueue: new BullReviewQueue({ queue: new Queue('reviews', { connection }) }) })
 *
 * The id returned to the caller (`reviewId` in the 202 body) is the job id.
 */
export class BullReviewQueue implements ReviewQueue {
  private readonly queue: BullQueueLike;
  private readonly jobName: string;
  private readonly jobOptions: Record<string, unknown>;

  constructor(options: BullReviewQueueOptions) {
    this.queue = options.queue;
    this.jobName = options.jobName ?? 'review';
    this.jobOptions = options.jobOptions ?? {};
  }

  async enqueue(item: ReviewItem): Promise<{ id: string }> {
    const id = randomUUID();
    const data: ReviewJobData = {
      decision: item.decision,
      payload: item.payload,
      reason: item.reason,
      queuedAt: new Date().toISOString(),
    };
    // Rejects if Redis is unreachable or the payload cannot be serialized. The gate then fails
    // closed (503): a request nobody can review is never let through.
    const job = await this.queue.add(this.jobName, data, { ...this.jobOptions, jobId: id });
    return { id: job.id ?? id };
  }
}
