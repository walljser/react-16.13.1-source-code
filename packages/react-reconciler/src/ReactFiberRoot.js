/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactFiber';
import type {ExpirationTime} from './ReactFiberExpirationTime';
import type {RootTag} from 'shared/ReactRootTags';
import type {TimeoutHandle, NoTimeout} from './ReactFiberHostConfig';
import type {Thenable} from './ReactFiberWorkLoop';
import type {Interaction} from 'scheduler/src/Tracing';
import type {SuspenseHydrationCallbacks} from './ReactFiberSuspenseComponent';
import type {ReactPriorityLevel} from './SchedulerWithReactIntegration';

import {noTimeout} from './ReactFiberHostConfig';
import {createHostRootFiber} from './ReactFiber';
import {NoWork} from './ReactFiberExpirationTime';
import {
  enableSchedulerTracing,
  enableSuspenseCallback,
} from 'shared/ReactFeatureFlags';
import {unstable_getThreadID} from 'scheduler/tracing';
import {NoPriority} from './SchedulerWithReactIntegration';
import {initializeUpdateQueue} from './ReactUpdateQueue';

export type PendingInteractionMap = Map<ExpirationTime, Set<Interaction>>;

// FiberRoot数据结构
type BaseFiberRootProperties = {|
  // The type of root (legacy, batched, concurrent, etc.)
  tag: RootTag,

  // root节点
  // 即：ReactDom.render(<App />, document.getElementById('root'))中的第二个参数，container
  containerInfo: any,

  // Used only by persistent updates.
  // 在持久更新中才会被用到
  // 也就是说不支持增量更新的平台会用到，react-dom不会用到。
  // 不支持增量更新的意思是：不更新某一块地方，而是整个应用完全更新
  pendingChildren: any,

  // The currently active root fiber. This is the mutable root of the tree.
  // 当前应用对应的Fiber对象，是 Root Fiber
  current: Fiber,

  pingCache:
    | WeakMap<Thenable, Set<ExpirationTime>>
    | Map<Thenable, Set<ExpirationTime>>
    | null,

  // 任务优先级：
  // 1. 没有提交的任务
  // 2. 没有提交的被挂起的任务
  // 3. 没有提交的可能被挂起的任务

  // 当前更新对应的过期时间
  finishedExpirationTime: ExpirationTime,

  // 已经完成任务的FiberRoot对象，如果只有一个Root，那么该对象就是Root对应的Fiber或者null
  finishedWork: Fiber | null,

  // 任务在被挂起的时候通过setTimeout设置后返回的id
  // 用于下一次如果有新的任务被挂起时清理还没有触发的timeout
  timeoutHandle: TimeoutHandle | NoTimeout,

  // Top context object, used by renderSubtreeIntoContainer
  // 顶层context对象，只有主动调用renderSubtreeIntoContainer时才会被使用
  context: Object | null,

  pendingContext: Object | null,

  // 用于判断，第一次渲染是否需要融合（是否是ssr）
  +hydrate: boolean,

  // Node returned by Scheduler.scheduleCallback
  callbackNode: *,

  // Expiration of the callback associated with this root
  // 跟root有关联的回调函数过期时间
  callbackExpirationTime: ExpirationTime,

  // Priority of the callback associated with this root
  // 跟root有关联的回调函数优先级
  callbackPriority: ReactPriorityLevel,

  // 最旧的不确定是否会挂起的优先级（所有任务进来一开始都是这个状态）
  firstPendingTime: ExpirationTime,

  // The earliest suspended expiration time that exists in the tree
  // 最旧和新的在提交的时候被挂起的任务
  firstSuspendedTime: ExpirationTime,
  lastSuspendedTime: ExpirationTime,

  // The next known expiration time after the suspended range
  // 挂起之后的下一个已知过期时间
  nextKnownPendingLevel: ExpirationTime,

  // The latest time at which a suspended component pinged the root to
  // render again
  lastPingedTime: ExpirationTime,
  lastExpiredTime: ExpirationTime,
|};

// The following attributes are only used by interaction tracing builds.
// They enable interactions to be associated with their async work,
// And expose interaction metadata to the React DevTools Profiler plugin.
// Note that these attributes are only defined when the enableSchedulerTracing flag is enabled.
type ProfilingOnlyFiberRootProperties = {|
  interactionThreadID: number,
  memoizedInteractions: Set<Interaction>,
  pendingInteractionMap: PendingInteractionMap,
|};

// The follow fields are only used by enableSuspenseCallback for hydration.
type SuspenseCallbackOnlyFiberRootProperties = {|
  hydrationCallbacks: null | SuspenseHydrationCallbacks,
|};

// Exported FiberRoot type includes all properties,
// To avoid requiring potentially error-prone :any casts throughout the project.
// Profiling properties are only safe to access in profiling builds (when enableSchedulerTracing is true).
// The types are defined separately within this file to ensure they stay in sync.
// (We don't have to use an inline :any cast when enableSchedulerTracing is disabled.)
export type FiberRoot = {
  ...BaseFiberRootProperties,
  ...ProfilingOnlyFiberRootProperties,
  ...SuspenseCallbackOnlyFiberRootProperties,
  ...
};

// 创建FiberRoot对象
function FiberRootNode(containerInfo, tag, hydrate) {
  this.tag = tag;
  this.current = null;
  this.containerInfo = containerInfo;
  this.pendingChildren = null;
  this.pingCache = null;
  this.finishedExpirationTime = NoWork;
  this.finishedWork = null;
  this.timeoutHandle = noTimeout;
  this.context = null;
  this.pendingContext = null;
  this.hydrate = hydrate;
  this.callbackNode = null;
  this.callbackPriority = NoPriority;
  this.firstPendingTime = NoWork;
  this.firstSuspendedTime = NoWork;
  this.lastSuspendedTime = NoWork;
  this.nextKnownPendingLevel = NoWork;
  this.lastPingedTime = NoWork;
  this.lastExpiredTime = NoWork;

  if (enableSchedulerTracing) {
    this.interactionThreadID = unstable_getThreadID();
    this.memoizedInteractions = new Set();
    this.pendingInteractionMap = new Map();
  }
  if (enableSuspenseCallback) {
    this.hydrationCallbacks = null;
  }
}

// 创建根节点对应的 fiber 对象， FiberRoot
// FiberRoot:
// * 整个应用的七点
// * 包含应用挂载的目标节点，
// * 记录整个应用更新过程的各种信息
export function createFiberRoot(
  containerInfo: any,
  tag: RootTag,
  hydrate: boolean,
  hydrationCallbacks: null | SuspenseHydrationCallbacks,
): FiberRoot {
  // containerInfo => <div id="root"></div>
  // tag => 0
  // hydrate => false
  // hydrateCallbacks => null
  // 这里的参数备注都忽略了服务端渲染相关内容

  // 创建FiberRoot对象
  const root: FiberRoot = (new FiberRootNode(containerInfo, tag, hydrate): any);
  if (enableSuspenseCallback) {
    root.hydrationCallbacks = hydrationCallbacks;
  }

  // Cyclic construction. This cheats the type system right now because
  // stateNode is any.
  // 创建根节点对应的rootFiber：  createHostRootFiber() -> createFiber() -> new FiberNode()
  const uninitializedFiber = createHostRootFiber(tag);
  // 为 FiberRoot 添加current属性为 rootFiber
  // 注意：这里的root是FiberRoot对象，uninitializedFiber是Fiber对象
  // root: FiberRoot
  // uninitlizedFiber: Fiber
  // 以下两句是互相引用
  // FirberRoot.current = rootFiber
  root.current = uninitializedFiber;
  // rootFiber.stateNode = FiberRoot
  uninitializedFiber.stateNode = root;

  // 初始化rootFiber的更新队列
  initializeUpdateQueue(uninitializedFiber);

  // 返回FiberRoot
  return root;
}

export function isRootSuspendedAtTime(
  root: FiberRoot,
  expirationTime: ExpirationTime,
): boolean {
  const firstSuspendedTime = root.firstSuspendedTime;
  const lastSuspendedTime = root.lastSuspendedTime;
  return (
    firstSuspendedTime !== NoWork &&
    firstSuspendedTime >= expirationTime &&
    lastSuspendedTime <= expirationTime
  );
}

export function markRootSuspendedAtTime(
  root: FiberRoot,
  expirationTime: ExpirationTime,
): void {
  const firstSuspendedTime = root.firstSuspendedTime;
  const lastSuspendedTime = root.lastSuspendedTime;
  if (firstSuspendedTime < expirationTime) {
    root.firstSuspendedTime = expirationTime;
  }
  if (lastSuspendedTime > expirationTime || firstSuspendedTime === NoWork) {
    root.lastSuspendedTime = expirationTime;
  }

  if (expirationTime <= root.lastPingedTime) {
    root.lastPingedTime = NoWork;
  }

  if (expirationTime <= root.lastExpiredTime) {
    root.lastExpiredTime = NoWork;
  }
}

export function markRootUpdatedAtTime(
  root: FiberRoot,
  expirationTime: ExpirationTime,
): void {
  // Update the range of pending times
  const firstPendingTime = root.firstPendingTime;
  if (expirationTime > firstPendingTime) {
    root.firstPendingTime = expirationTime;
  }

  // Update the range of suspended times. Treat everything lower priority or
  // equal to this update as unsuspended.
  const firstSuspendedTime = root.firstSuspendedTime;
  if (firstSuspendedTime !== NoWork) {
    if (expirationTime >= firstSuspendedTime) {
      // The entire suspended range is now unsuspended.
      root.firstSuspendedTime = root.lastSuspendedTime = root.nextKnownPendingLevel = NoWork;
    } else if (expirationTime >= root.lastSuspendedTime) {
      root.lastSuspendedTime = expirationTime + 1;
    }

    // This is a pending level. Check if it's higher priority than the next
    // known pending level.
    if (expirationTime > root.nextKnownPendingLevel) {
      root.nextKnownPendingLevel = expirationTime;
    }
  }
}

export function markRootFinishedAtTime(
  root: FiberRoot,
  finishedExpirationTime: ExpirationTime,
  remainingExpirationTime: ExpirationTime,
): void {
  // Update the range of pending times
  root.firstPendingTime = remainingExpirationTime;

  // Update the range of suspended times. Treat everything higher priority or
  // equal to this update as unsuspended.
  if (finishedExpirationTime <= root.lastSuspendedTime) {
    // The entire suspended range is now unsuspended.
    root.firstSuspendedTime = root.lastSuspendedTime = root.nextKnownPendingLevel = NoWork;
  } else if (finishedExpirationTime <= root.firstSuspendedTime) {
    // Part of the suspended range is now unsuspended. Narrow the range to
    // include everything between the unsuspended time (non-inclusive) and the
    // last suspended time.
    root.firstSuspendedTime = finishedExpirationTime - 1;
  }

  if (finishedExpirationTime <= root.lastPingedTime) {
    // Clear the pinged time
    root.lastPingedTime = NoWork;
  }

  if (finishedExpirationTime <= root.lastExpiredTime) {
    // Clear the expired time
    root.lastExpiredTime = NoWork;
  }
}

export function markRootExpiredAtTime(
  root: FiberRoot,
  expirationTime: ExpirationTime,
): void {
  const lastExpiredTime = root.lastExpiredTime;
  if (lastExpiredTime === NoWork || lastExpiredTime > expirationTime) {
    root.lastExpiredTime = expirationTime;
  }
}
