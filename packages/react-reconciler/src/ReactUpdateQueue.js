/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// UpdateQueue is a linked list of prioritized updates.
//
// Like fibers, update queues come in pairs: a current queue, which represents
// the visible state of the screen, and a work-in-progress queue, which can be
// mutated and processed asynchronously before it is committed — a form of
// double buffering. If a work-in-progress render is discarded before finishing,
// we create a new work-in-progress by cloning the current queue.
//
// Both queues share a persistent, singly-linked list structure. To schedule an
// update, we append it to the end of both queues. Each queue maintains a
// pointer to first update in the persistent list that hasn't been processed.
// The work-in-progress pointer always has a position equal to or greater than
// the current queue, since we always work on that one. The current queue's
// pointer is only updated during the commit phase, when we swap in the
// work-in-progress.
//
// For example:
//
//   Current pointer:           A - B - C - D - E - F
//   Work-in-progress pointer:              D - E - F
//                                          ^
//                                          The work-in-progress queue has
//                                          processed more updates than current.
//
// The reason we append to both queues is because otherwise we might drop
// updates without ever processing them. For example, if we only add updates to
// the work-in-progress queue, some updates could be lost whenever a work-in
// -progress render restarts by cloning from current. Similarly, if we only add
// updates to the current queue, the updates will be lost whenever an already
// in-progress queue commits and swaps with the current queue. However, by
// adding to both queues, we guarantee that the update will be part of the next
// work-in-progress. (And because the work-in-progress queue becomes the
// current queue once it commits, there's no danger of applying the same
// update twice.)
//
// Prioritization
// --------------
//
// Updates are not sorted by priority, but by insertion; new updates are always
// appended to the end of the list.
//
// The priority is still important, though. When processing the update queue
// during the render phase, only the updates with sufficient priority are
// included in the result. If we skip an update because it has insufficient
// priority, it remains in the queue to be processed later, during a lower
// priority render. Crucially, all updates subsequent to a skipped update also
// remain in the queue *regardless of their priority*. That means high priority
// updates are sometimes processed twice, at two separate priorities. We also
// keep track of a base state, that represents the state before the first
// update in the queue is applied.
//
// For example:
//
//   Given a base state of '', and the following queue of updates
//
//     A1 - B2 - C1 - D2
//
//   where the number indicates the priority, and the update is applied to the
//   previous state by appending a letter, React will process these updates as
//   two separate renders, one per distinct priority level:
//
//   First render, at priority 1:
//     Base state: ''
//     Updates: [A1, C1]
//     Result state: 'AC'
//
//   Second render, at priority 2:
//     Base state: 'A'            <-  The base state does not include C1,
//                                    because B2 was skipped.
//     Updates: [B2, C1, D2]      <-  C1 was rebased on top of B2
//     Result state: 'ABCD'
//
// Because we process updates in insertion order, and rebase high priority
// updates when preceding updates are skipped, the final result is deterministic
// regardless of priority. Intermediate state may vary according to system
// resources, but the final state is always the same.

import type {Fiber} from './ReactFiber';
import type {ExpirationTime} from './ReactFiberExpirationTime';
import type {SuspenseConfig} from './ReactFiberSuspenseConfig';
import type {ReactPriorityLevel} from './SchedulerWithReactIntegration';

import {NoWork, Sync} from './ReactFiberExpirationTime';
import {
  enterDisallowedContextReadInDEV,
  exitDisallowedContextReadInDEV,
} from './ReactFiberNewContext';
import {Callback, ShouldCapture, DidCapture} from 'shared/ReactSideEffectTags';

import {debugRenderPhaseSideEffectsForStrictMode} from 'shared/ReactFeatureFlags';

import {StrictMode} from './ReactTypeOfMode';
import {
  markRenderEventTimeAndConfig,
  markUnprocessedUpdateTime,
} from './ReactFiberWorkLoop';

import invariant from 'shared/invariant';
import {getCurrentPriorityLevel} from './SchedulerWithReactIntegration';

export type Update<State> = {|
  // 过期时间（本次更新任务的优先级）
  expirationTime: ExpirationTime,

  // 挂起相关配置
  suspenseConfig: null | SuspenseConfig,

  // 下方的代码有这些tag。
  // export const UpdateState = 0  // 更新状态
  // export const ReplaceState = 1  // 替换更新
  // export const ForceUpdate = 2  // 强制更新
  // export const CaptureUpdate = 3  // 捕获更新
  // 指定更新的类型，总共为4种
  tag: 0 | 1 | 2 | 3,

  // 更新内容：比如`setState`接受的第一个参数
  payload: any,

  // 更新回调，`setState`和`render`都有
  callback: (() => mixed) | null,

  // 指向下一个更新
  next: Update<State>,

  // DEV only
  priority?: ReactPriorityLevel,
|};

type SharedQueue<State> = {|pending: Update<State> | null|};

// 单项链表，用来存放update，
// BaseQueue和shared(pendingQueue)均存储单向链表的尾结点
export type UpdateQueue<State> = {|
  // 先前的状态，作为payload函数的preState参数
  // 每次的更新都是在这个baseState基础上进行更新
  baseState: State,
  // 更新队列，单链表，
  baseQueue: Update<State> | null,
  // 以pending属性存储待执行的更新任务 Update 队列，单向循环链表
  shared: SharedQueue<State>,
  // side-effects队列
  effects: Array<Update<State>> | null,
|};

// 更新类型
export const UpdateState = 0;  // 更新状态
export const ReplaceState = 1;  // 替换更新
export const ForceUpdate = 2;  // 强制更新
export const CaptureUpdate = 3;  // 捕获更新

// Global state that is reset at the beginning of calling `processUpdateQueue`.
// It should only be read right after calling `processUpdateQueue`, via
// `checkHasForceUpdateAfterProcessing`.
let hasForceUpdate = false;

let didWarnUpdateInsideUpdate;
let currentlyProcessingQueue;
export let resetCurrentlyProcessingQueue;
if (__DEV__) {
  didWarnUpdateInsideUpdate = false;
  currentlyProcessingQueue = null;
  resetCurrentlyProcessingQueue = () => {
    currentlyProcessingQueue = null;
  };
}

// 初始化更新队列
export function initializeUpdateQueue<State>(fiber: Fiber): void {
  const queue: UpdateQueue<State> = {
    baseState: fiber.memoizedState,
    baseQueue: null,
    shared: {
      pending: null,
    },
    effects: null,
  };
  fiber.updateQueue = queue;
}

export function cloneUpdateQueue<State>(
  current: Fiber,
  workInProgress: Fiber,
): void {
  // Clone the update queue from current. Unless it's already a clone.
  const queue: UpdateQueue<State> = (workInProgress.updateQueue: any);
  const currentQueue: UpdateQueue<State> = (current.updateQueue: any);
  if (queue === currentQueue) {
    const clone: UpdateQueue<State> = {
      baseState: currentQueue.baseState,
      baseQueue: currentQueue.baseQueue,
      shared: currentQueue.shared,
      effects: currentQueue.effects,
    };
    workInProgress.updateQueue = clone;
  }
}

/**
 * 创建update对象
 * @param {*} expirationTime
 * @param {*} suspenseConfig
 */
export function createUpdate(
  expirationTime: ExpirationTime,
  suspenseConfig: null | SuspenseConfig,
): Update<*> {
  let update: Update<*> = {
    expirationTime, // 过期时间
    suspenseConfig,

    // export const UpdateState = 0  // 更新状态
    // export const ReplaceState = 1  // 替换更新
    // export const ForceUpdate = 2  // 强制更新
    // export const CaptureUpdate = 3  // 捕获更新

    // 默认是0，即更新状态
    tag: UpdateState,

    // 更新内容，例如：setState接受的第一个参数
    payload: null,

    // 更新后对应的回调函数
    callback: null,

    // 指向下一个更新
    next: (null: any),
  };
  update.next = update;
  if (__DEV__) {
    update.priority = getCurrentPriorityLevel();
  }
  return update;
}

/**
 * 加入更新队列
 * 主体逻辑：在rootFiber updateQueue中加入update
 * @param {*} fiber
 * @param {*} update
 */
export function enqueueUpdate<State>(fiber: Fiber, update: Update<State>) {
  // 当前更新的updateQueue
  const updateQueue = fiber.updateQueue;
  if (updateQueue === null) {
    // 只有在fiber没有被挂载的时候才会出现updateQueue为空
    // Only occurs if the fiber has been unmounted.
    return;
  }

  // shared是SharedQueue，以pending属性存储的待执行的更新任务
  // 待执行的 Update 任务
  const sharedQueue = updateQueue.shared;
  const pending = sharedQueue.pending;
  if (pending === null) {
    // This is the first update. Create a circular list.
    // pending为空为首次更新，创建一个循环链表（next指向自己）
    // 最终结构为：
    // sharedQueue.pending = update
    // update.next = update
    update.next = update;
  } else {
    // 插入到pending之后，pending.next之前
    // 始终是一个循环链表
    update.next = pending.next;
    pending.next = update;
  }
  // 指向最新的待更新
  sharedQueue.pending = update;

  if (__DEV__) {
    if (
      currentlyProcessingQueue === sharedQueue &&
      !didWarnUpdateInsideUpdate
    ) {
      console.error(
        'An update (setState, replaceState, or forceUpdate) was scheduled ' +
          'from inside an update function. Update functions should be pure, ' +
          'with zero side-effects. Consider using componentDidUpdate or a ' +
          'callback.',
      );
      didWarnUpdateInsideUpdate = true;
    }
  }
}

export function enqueueCapturedUpdate<State>(
  workInProgress: Fiber,
  update: Update<State>,
) {
  const current = workInProgress.alternate;
  if (current !== null) {
    // Ensure the work-in-progress queue is a clone
    cloneUpdateQueue(current, workInProgress);
  }

  // Captured updates go only on the work-in-progress queue.
  const queue: UpdateQueue<State> = (workInProgress.updateQueue: any);
  // Append the update to the end of the list.
  const last = queue.baseQueue;
  if (last === null) {
    queue.baseQueue = update.next = update;
    update.next = update;
  } else {
    update.next = last.next;
    last.next = update;
  }
}

function getStateFromUpdate<State>(
  workInProgress: Fiber,
  queue: UpdateQueue<State>,
  update: Update<State>,
  prevState: State,
  nextProps: any,
  instance: any,
): any {
  switch (update.tag) {
    case ReplaceState: {
      const payload = update.payload;
      if (typeof payload === 'function') {
        // Updater function
        if (__DEV__) {
          enterDisallowedContextReadInDEV();
          if (
            debugRenderPhaseSideEffectsForStrictMode &&
            workInProgress.mode & StrictMode
          ) {
            payload.call(instance, prevState, nextProps);
          }
        }
        const nextState = payload.call(instance, prevState, nextProps);
        if (__DEV__) {
          exitDisallowedContextReadInDEV();
        }
        return nextState;
      }
      // State object
      return payload;
    }
    case CaptureUpdate: {
      workInProgress.effectTag =
        (workInProgress.effectTag & ~ShouldCapture) | DidCapture;
    }
    // Intentional fallthrough
    case UpdateState: {
      const payload = update.payload;
      let partialState;
      if (typeof payload === 'function') {
        // Updater function
        if (__DEV__) {
          enterDisallowedContextReadInDEV();
          if (
            debugRenderPhaseSideEffectsForStrictMode &&
            workInProgress.mode & StrictMode
          ) {
            payload.call(instance, prevState, nextProps);
          }
        }
        partialState = payload.call(instance, prevState, nextProps);
        if (__DEV__) {
          exitDisallowedContextReadInDEV();
        }
      } else {
        // Partial state object
        partialState = payload;
      }
      if (partialState === null || partialState === undefined) {
        // Null and undefined are treated as no-ops.
        return prevState;
      }
      // Merge the partial state and the previous state.
      return Object.assign({}, prevState, partialState);
    }
    case ForceUpdate: {
      hasForceUpdate = true;
      return prevState;
    }
  }
  return prevState;
}

/**
 * 更新 update 队列，并更新 state
 * 主要流程：
 *   1. 丢弃原先的baseQueue，将pendingQueue赋值给baseQueue，作为执行中的Update队列
 *   2. 启用 while 循环处理Update队列。如果优先级足够，获取最新的状态值；如果优先级不够，添加到newBaseQueue队列，等待下次处理。
 * @param {*} workInProgress
 * @param {*} props
 * @param {*} instance
 * @param {*} renderExpirationTime
 */
export function processUpdateQueue<State>(
  workInProgress: Fiber,
  props: any,
  instance: any,
  renderExpirationTime: ExpirationTime,
): void {
  // This is always non-null on a ClassComponent or HostRoot
  // 获取updateQueue
  const queue: UpdateQueue<State> = (workInProgress.updateQueue: any);

  // 非强制更新
  hasForceUpdate = false;

  if (__DEV__) {
    currentlyProcessingQueue = queue.shared;
  }

  // The last rebase update that is NOT part of the base state.
  let baseQueue = queue.baseQueue;

  // The last pending update that hasn't been processed yet.
  let pendingQueue = queue.shared.pending;
  if (pendingQueue !== null) {
    // We have new updates that haven't been processed yet.
    // We'll add them to the base queue.
    if (baseQueue !== null) {
      // Merge the pending queue and the base queue.
      let baseFirst = baseQueue.next;
      let pendingFirst = pendingQueue.next;
      baseQueue.next = pendingFirst;
      pendingQueue.next = baseFirst;
    }

    // 将pendingQueue赋值给baseQueue
    baseQueue = pendingQueue;

    // 将pendingQueue置空
    queue.shared.pending = null;
    // TODO: Pass `current` as argument
    const current = workInProgress.alternate;
    if (current !== null) {
      const currentQueue = current.updateQueue;
      if (currentQueue !== null) {
        currentQueue.baseQueue = pendingQueue;
      }
    }
  }

  // These values may change as we process the queue.
  if (baseQueue !== null) {
    let first = baseQueue.next;
    // Iterate through the list of updates to compute the result.
    let newState = queue.baseState;
    let newExpirationTime = NoWork;

    let newBaseState = null;
    let newBaseQueueFirst = null;
    let newBaseQueueLast = null;

    if (first !== null) {
      let update = first;
      do {
        const updateExpirationTime = update.expirationTime;
        // 优先级不足时，将 update 添加到 newBaseQueue 队列中
        // newBaseState 更新为前一个 update 任务的结果
        if (updateExpirationTime < renderExpirationTime) {
          // Priority is insufficient. Skip this update. If this is the first
          // skipped update, the previous update/state is the new base
          // update/state.
          const clone: Update<State> = {
            expirationTime: update.expirationTime,
            suspenseConfig: update.suspenseConfig,

            tag: update.tag,
            payload: update.payload,
            callback: update.callback,

            next: (null: any),
          };
          if (newBaseQueueLast === null) {
            newBaseQueueFirst = newBaseQueueLast = clone;
            newBaseState = newState;
          } else {
            newBaseQueueLast = newBaseQueueLast.next = clone;
          }
          // Update the remaining priority in the queue.
          if (updateExpirationTime > newExpirationTime) {
            newExpirationTime = updateExpirationTime;
          }
        } else {
          // This update does have sufficient priority.

          if (newBaseQueueLast !== null) {
            const clone: Update<State> = {
              expirationTime: Sync, // This update is going to be committed so we never want uncommit it.
              suspenseConfig: update.suspenseConfig,

              tag: update.tag,
              payload: update.payload,
              callback: update.callback,

              next: (null: any),
            };
            newBaseQueueLast = newBaseQueueLast.next = clone;
          }

          // Mark the event time of this update as relevant to this render pass.
          // TODO: This should ideally use the true event time of this update rather than
          // its priority which is a derived and not reverseable value.
          // TODO: We should skip this update if it was already committed but currently
          // we have no way of detecting the difference between a committed and suspended
          // update here.
          markRenderEventTimeAndConfig(
            updateExpirationTime,
            update.suspenseConfig,
          );

          // Process this update.
          newState = getStateFromUpdate(
            workInProgress,
            queue,
            update,
            newState,
            props,
            instance,
          );
          const callback = update.callback;
          if (callback !== null) {
            workInProgress.effectTag |= Callback;
            let effects = queue.effects;
            if (effects === null) {
              queue.effects = [update];
            } else {
              effects.push(update);
            }
          }
        }
        update = update.next;
        if (update === null || update === first) {
          pendingQueue = queue.shared.pending;
          if (pendingQueue === null) {
            break;
          } else {
            // An update was scheduled from inside a reducer. Add the new
            // pending updates to the end of the list and keep processing.
            update = baseQueue.next = pendingQueue.next;
            pendingQueue.next = first;
            queue.baseQueue = baseQueue = pendingQueue;
            queue.shared.pending = null;
          }
        }
      } while (true);
    }

    if (newBaseQueueLast === null) {
      newBaseState = newState;
    } else {
      newBaseQueueLast.next = (newBaseQueueFirst: any);
    }

    queue.baseState = ((newBaseState: any): State);
    queue.baseQueue = newBaseQueueLast;

    // Set the remaining expiration time to be whatever is remaining in the queue.
    // This should be fine because the only two other things that contribute to
    // expiration time are props and context. We're already in the middle of the
    // begin phase by the time we start processing the queue, so we've already
    // dealt with the props. Context in components that specify
    // shouldComponentUpdate is tricky; but we'll have to account for
    // that regardless.
    markUnprocessedUpdateTime(newExpirationTime);
    workInProgress.expirationTime = newExpirationTime;
    workInProgress.memoizedState = newState;
  }

  if (__DEV__) {
    currentlyProcessingQueue = null;
  }
}

function callCallback(callback, context) {
  invariant(
    typeof callback === 'function',
    'Invalid argument passed as callback. Expected a function. Instead ' +
      'received: %s',
    callback,
  );
  callback.call(context);
}

export function resetHasForceUpdateBeforeProcessing() {
  hasForceUpdate = false;
}

export function checkHasForceUpdateAfterProcessing(): boolean {
  return hasForceUpdate;
}

export function commitUpdateQueue<State>(
  finishedWork: Fiber,
  finishedQueue: UpdateQueue<State>,
  instance: any,
): void {
  // Commit the effects
  const effects = finishedQueue.effects;
  finishedQueue.effects = null;
  if (effects !== null) {
    for (let i = 0; i < effects.length; i++) {
      const effect = effects[i];
      const callback = effect.callback;
      if (callback !== null) {
        effect.callback = null;
        callCallback(callback, instance);
      }
    }
  }
}
