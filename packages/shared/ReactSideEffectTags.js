/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

export type SideEffectTag = number;
//effectTag采用了复合类型方案设计。通过将二进制0的不同位上的数字置为1来表示不同的tag。
// 1）|运算可以将不同tag组合成为复合类型。
// 2）&运算可以用于判断复合类型中是否含有某个Tag.
// 3）通过A&=~B的方式，可以从复合类型A中去掉某个tagB。

// Don't change these two values. They're used by React Dev Tools.
// 初始值
export const NoEffect = /*              */ 0b0000000000000;
// 开始处理后置为 PerformedWork
export const PerformedWork = /*         */ 0b0000000000001;

// You can change the rest (and add more).
// 插入、移动 dom 节点
export const Placement = /*             */ 0b0000000000010;
// 更新 dom 节点的类型或内容
export const Update = /*                */ 0b0000000000100;
// 移动并更新 dom 节点
export const PlacementAndUpdate = /*    */ 0b0000000000110;
// 删除 dom 节点
export const Deletion = /*              */ 0b0000000001000;
// 将只包含字符串的 dom 节点替换成其他节点
export const ContentReset = /*          */ 0b0000000010000;
// setState 的回调类型
export const Callback = /*              */ 0b0000000100000;
// 渲染出错，捕获到错误信息
export const DidCapture = /*            */ 0b0000001000000;
// ref 的回调类型
export const Ref = /*                   */ 0b0000010000000;
// 执行 getSnapshotBeforeUpdate 后赋值
export const Snapshot = /*              */ 0b0000100000000;
export const Passive = /*               */ 0b0001000000000;
export const Hydrating = /*             */ 0b0010000000000;
export const HydratingAndUpdate = /*    */ 0b0010000000100;

// Passive & Update & Callback & Ref & Snapshot
export const LifecycleEffectMask = /*   */ 0b0001110100100;

// Union of all host effects
export const HostEffectMask = /*        */ 0b0011111111111;

// 任何造成 fiber 的 work 无法完成的情况
export const Incomplete = /*            */ 0b0100000000000;
// 需要处理错误
export const ShouldCapture = /*         */ 0b1000000000000;
