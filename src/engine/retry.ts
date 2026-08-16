import type { RetryPolicy } from "./types.js";

export type RetryEvaluation = {
  escalate: boolean;
  nextAttempt: number;
};

// §7.6: on CONFIRMED entry to a step with retryPolicy, increment unconditionally of source
// result, then check the cap (maxRetries + 1). Initial fix-required entry counts as 1.
export function evaluateRetry(currentAttempts: number, policy: RetryPolicy): RetryEvaluation {
  const nextAttempt = currentAttempts + 1;
  return { escalate: nextAttempt > policy.maxRetries + 1, nextAttempt };
}

// retryOn is NOT a count condition — only used to tag Event Log isRetry and to flag
// unexpected reentry from a result declared in neither retryOn nor the initial path.
export function isRetryEntry(sourceResult: string, policy: RetryPolicy): boolean {
  return policy.retryOn.includes(sourceResult);
}
