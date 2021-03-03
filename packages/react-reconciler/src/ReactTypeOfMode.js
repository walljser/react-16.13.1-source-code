/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

export type TypeOfMode = number;

// 默认是NoMode 0
export const NoMode = 0b0000; // 0
export const StrictMode = 0b0001; // 1 严格模式 一般用于开发中
// TODO: Remove BlockingMode and ConcurrentMode by reading from the root
// tag instead
export const BlockingMode = 0b0010; // 2 阻塞模式
export const ConcurrentMode = 0b0100; // 4 异步模式
export const ProfileMode = 0b1000; // 8 分析模式 一般用于开发中
