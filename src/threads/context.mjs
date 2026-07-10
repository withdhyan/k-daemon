import { gatherContext } from '../../daemon/run.mjs';
import {
  optionalString,
  requiredString,
} from '../substrate.mjs';

export async function threadContext({
  store,
  segmentation,
  threadId,
  station,
  dataDir,
  gather = gatherContext,
  ...options
} = {}) {
  if (!store) throw new Error('store is required');

  const scopedThreadId = requiredString(threadId, 'threadId');
  const scopedStation = requiredString(station, 'station');
  const thread = findThread(segmentation, scopedThreadId);

  return gather(scopedStation, {
    ...options,
    store,
    dataDir: dataDir ?? store.dataDir,
    threadId: scopedThreadId,
    threadExposureIds: thread?.exposureIds ?? [],
  });
}

function findThread(segmentation, threadId) {
  return threadsFromSegmentation(segmentation).find(
    (thread) => optionalString(thread?.threadId) === threadId,
  ) ?? null;
}

function threadsFromSegmentation(segmentation) {
  if (Array.isArray(segmentation)) return segmentation;
  if (Array.isArray(segmentation?.threads)) return segmentation.threads;
  return [];
}
