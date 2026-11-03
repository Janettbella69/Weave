// A change that raced another one on the same account (the Agent was writing while the person pressed a button) is
// answered with 409: the stored copy moved on. The person did nothing wrong, so the page loads the new copy and
// tries the same change once more; any other error is shown as it is.
import {ApiError} from './api-client.mjs';

export async function retryOnConflict(fn, refresh) {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
  }
  await refresh();
  return fn();
}
