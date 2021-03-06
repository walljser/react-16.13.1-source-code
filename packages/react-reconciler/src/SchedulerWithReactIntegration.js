/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// Intentionally not named imports because Rollup would use dynamic dispatch for
// CommonJS interop named imports.
import * as Scheduler from 'scheduler';
import {__interactionsRef} from 'scheduler/tracing';
import {enableSchedulerTracing} from 'shared/ReactFeatureFlags';
import invariant from 'shared/invariant';

const {
  unstable_runWithPriority: Scheduler_runWithPriority,
  unstable_scheduleCallback: Scheduler_scheduleCallback,
  unstable_cancelCallback: Scheduler_cancelCallback,
  unstable_shouldYield: Scheduler_shouldYield,
  unstable_requestPaint: Scheduler_requestPaint,
  unstable_now: Scheduler_now,
  unstable_getCurrentPriorityLevel: Scheduler_getCurrentPriorityLevel,
  unstable_ImmediatePriority: Scheduler_ImmediatePriority,
  unstable_UserBlockingPriority: Scheduler_UserBlockingPriority,
  unstable_NormalPriority: Scheduler_NormalPriority,
  unstable_LowPriority: Scheduler_LowPriority,
  unstable_IdlePriority: Scheduler_IdlePriority,
} = Scheduler;

if (enableSchedulerTracing) {
  // Provide explicit error message when production+profiling bundle of e.g.
  // react-dom is used with production (non-profiling) bundle of
  // scheduler/tracing
  invariant(
    __interactionsRef != null && __interactionsRef.current != null,
    'It is not supported to run the profiling version of a renderer (for ' +
      'example, `react-dom/profiling`) without also replacing the ' +
      '`scheduler/tracing` module with `scheduler/tracing-profiling`. Your ' +
      'bundler might have a setting for aliasing both modules. Learn more at ' +
      'http://fb.me/react-profiling',
  );
}

export type ReactPriorityLevel = 99 | 98 | 97 | 96 | 95 | 90;
export type SchedulerCallback = (isSync: boolean) => SchedulerCallback | null;

type SchedulerCallbackOptions = {timeout?: number, ...};

const fakeCallbackNode = {};

// 优先级用数字，方便比较
// 从90开始算React优先级是为了防止和Scheduler的优先级冲突
export const ImmediatePriority: ReactPriorityLevel = 99; // 最高优先级
export const UserBlockingPriority: ReactPriorityLevel = 98; // 次优先级（交互优先级）
export const NormalPriority: ReactPriorityLevel = 97; // 正常优先级
export const LowPriority: ReactPriorityLevel = 96; // 低优先级
export const IdlePriority: ReactPriorityLevel = 95; // 最低优先级
// NoPriority is the absence of priority. Also React-only.
export const NoPriority: ReactPriorityLevel = 90;

export const shouldYield = Scheduler_shouldYield;
export const requestPaint =
  // Fall back gracefully if we're running an older version of Scheduler.
  Scheduler_requestPaint !== undefined ? Scheduler_requestPaint : () => {};

let syncQueue: Array<SchedulerCallback> | null = null;
let immediateQueueCallbackNode: mixed | null = null;
let isFlushingSyncQueue: boolean = false;
let initialTimeMs: number = Scheduler_now();

// If the initial timestamp is reasonably small, use Scheduler's `now` directly.
// This will be the case for modern browsers that support `performance.now`. In
// older browsers, Scheduler falls back to `Date.now`, which returns a Unix
// timestamp. In that case, subtract the module initialization time to simulate
// the behavior of performance.now and keep our times small enough to fit
// within 32 bits.
// TODO: Consider lifting this into Scheduler.
export const now =
  initialTimeMs < 10000 ? Scheduler_now : () => Scheduler_now() - initialTimeMs;

// 根据当前调度任务的优先级获取react优先级
export function getCurrentPriorityLevel(): ReactPriorityLevel {
  switch (Scheduler_getCurrentPriorityLevel()) {
    case Scheduler_ImmediatePriority:
      return ImmediatePriority;
    case Scheduler_UserBlockingPriority:
      return UserBlockingPriority;
    case Scheduler_NormalPriority:
      return NormalPriority;
    case Scheduler_LowPriority:
      return LowPriority;
    case Scheduler_IdlePriority:
      return IdlePriority;
    default:
      invariant(false, 'Unknown priority level.');
  }
}

/**
 * 获取调度优先级
 * @param {*} reactPriorityLevel
 */
function reactPriorityToSchedulerPriority(reactPriorityLevel) {
  switch (reactPriorityLevel) {
    case ImmediatePriority:
      return Scheduler_ImmediatePriority;
    case UserBlockingPriority:
      return Scheduler_UserBlockingPriority;
    case NormalPriority:
      return Scheduler_NormalPriority;
    case LowPriority:
      return Scheduler_LowPriority;
    case IdlePriority:
      return Scheduler_IdlePriority;
    default:
      invariant(false, 'Unknown priority level.');
  }
}

export function runWithPriority<T>(
  reactPriorityLevel: ReactPriorityLevel,
  fn: () => T,
): T {
  // 获取调度优先级
  const priorityLevel = reactPriorityToSchedulerPriority(reactPriorityLevel);
  // 该函数的功能是：临时替换当前的优先级，去执行传进来的 callback
  return Scheduler_runWithPriority(priorityLevel, fn);
}

export function scheduleCallback(
  reactPriorityLevel: ReactPriorityLevel,
  callback: SchedulerCallback,
  options: SchedulerCallbackOptions | void | null,
) {
  const priorityLevel = reactPriorityToSchedulerPriority(reactPriorityLevel);
  return Scheduler_scheduleCallback(priorityLevel, callback, options);
}

export function scheduleSyncCallback(callback: SchedulerCallback) {
  // Push this callback into an internal queue. We'll flush these either in
  // the next tick, or earlier if something calls `flushSyncCallbackQueue`.
  if (syncQueue === null) {
    syncQueue = [callback];
    // Flush the queue in the next tick, at the earliest.
    immediateQueueCallbackNode = Scheduler_scheduleCallback(
      Scheduler_ImmediatePriority,
      flushSyncCallbackQueueImpl,
    );
  } else {
    // Push onto existing queue. Don't need to schedule a callback because
    // we already scheduled one when we created the queue.
    syncQueue.push(callback);
  }
  return fakeCallbackNode;
}

export function cancelCallback(callbackNode: mixed) {
  if (callbackNode !== fakeCallbackNode) {
    Scheduler_cancelCallback(callbackNode);
  }
}

// 刷新同步任务队列
export function flushSyncCallbackQueue() {
  if (immediateQueueCallbackNode !== null) {
    const node = immediateQueueCallbackNode;
    immediateQueueCallbackNode = null;
    Scheduler_cancelCallback(node);
  }
  flushSyncCallbackQueueImpl();
}

/**
 * 更新同步队列
 */
function flushSyncCallbackQueueImpl() {
  // 如果同步队列未处于更新 且 同步队列不为空
  if (!isFlushingSyncQueue && syncQueue !== null) {
    // Prevent re-entrancy.
    // 上锁，防止重复执行
    isFlushingSyncQueue = true;
    let i = 0;
    try {
      const isSync = true;
      const queue = syncQueue; // 同步队列
      // 用最高优先级执行回调函数
      runWithPriority(ImmediatePriority, () => {
        // 遍历同步队列
        for (; i < queue.length; i++) {
          let callback = queue[i];
          do {
            // 执行同步队列里的回调函数
            callback = callback(isSync);
          } while (callback !== null);
        }
      });
      // 遍历结束后，将同步队列置空
      syncQueue = null;
    } catch (error) {
      // If something throws, leave the remaining callbacks on the queue.
      if (syncQueue !== null) {
        syncQueue = syncQueue.slice(i + 1);
      }
      // Resume flushing in the next tick
      Scheduler_scheduleCallback(
        Scheduler_ImmediatePriority,
        flushSyncCallbackQueue,
      );
      throw error;
    } finally {
      isFlushingSyncQueue = false;
    }
  }
}
