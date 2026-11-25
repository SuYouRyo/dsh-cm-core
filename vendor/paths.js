// 路径判定的唯一真源（丙方案，2026-11-21）。
//
// 为什么要有这个文件：life 那一层从 2026-11-21 起**不写进被 git 追踪的文件**，
// 改落到本机专属、被 .gitignore 挡住的路径。理由是硬的：
//   · 远端 memory.git 的 pre-receive 门禁拒绝任何被追踪文件里出现 "scope":"life"
//     字面量（远端全历史必须 life=0，这条是 11/4 事故之后立的，不许为了推上去而删）；
//   · 而生活侧会话**一直在实时灌库**，只要它写进 raw/events/*.jsonl（被追踪），
//     写完就走不了 push —— 2026-11-21 就是这么回潮的（本地领先 14 个 commit，每个都含 life）。
//   一次性历史重写追不上「今天还在长的文件」，所以只能在**写入侧**分开。
//
// 分流规则（单向门不变，仍按 rec.scope 判可见性）：
//   raw/events/                        ← shared / work（被追踪，进同步仓）
//   raw/events-life/                   ← life（本机专属，不进同步仓）
//   impressions/impressions.jsonl      ← shared / work 印象
//   impressions/impressions-life.jsonl ← life 印象
//   raw/session-scope.jsonl            ← shared / work 会话落定
//   raw/session-scope-life.jsonl       ← life 会话落定
//
// 三个新路径必须同时出现在 bin/cm-remote.js 的 LOCAL_ONLY 里（那边是 .gitignore 的来源），
// 否则它们会被 git add -A 推上去，等于白做。tests/cases/life-local.mjs 钉住这条。
//
// 这里只依赖 node 内置模块：store.js / impressions.js / ingest.js / search.js 都要 import 它，
// 任何一方都不能反向依赖（ingest → store 已经是一条既有依赖，再让 store → ingest 就成环）。

import path from 'node:path';

/** life 那一层的原文层目录名（挂在 raw/ 下）。 */
export const LIFE_EVENTS_DIRNAME = 'events-life';
/** life 印象文件名（挂在 impressions/ 下）。 */
export const LIFE_IMPRESSIONS_NAME = 'impressions-life.jsonl';
/** life 会话落定文件名（挂在 raw/ 下）。 */
export const LIFE_SESSION_SCOPE_NAME = 'session-scope-life.jsonl';

/** raw/ 层。 */
export function rawDirOf(dir) {
  return path.join(dir, 'raw');
}

/** shared / work 的原文层目录（被 git 追踪的那一个）。 */
export function eventsDirOf(dir) {
  return path.join(rawDirOf(dir), 'events');
}

/** life 的原文层目录（本机专属，不进同步仓）。 */
export function lifeEventsDirOf(dir) {
  return path.join(rawDirOf(dir), LIFE_EVENTS_DIRNAME);
}

/**
 * 按 scope 选原文层目录。
 * 只认 'life' 走单独目录，其余（shared / work / 空值）一律走被追踪的那个 ——
 * 这样任何既有调用方传 undefined 时行为与改造前一模一样，不会因为少传参数就把数据写丢。
 */
export function eventsDirForScope(dir, scope) {
  return scope === 'life' ? lifeEventsDirOf(dir) : eventsDirOf(dir);
}

/** shared / work 的印象文件。 */
export function impressionsFileOf(dir) {
  return path.join(dir, 'impressions', 'impressions.jsonl');
}

/** life 印象文件。 */
export function lifeImpressionsFileOf(dir) {
  return path.join(dir, 'impressions', LIFE_IMPRESSIONS_NAME);
}

/** 按 scope 选印象文件。 */
export function impressionsFileForScope(dir, scope) {
  return scope === 'life' ? lifeImpressionsFileOf(dir) : impressionsFileOf(dir);
}

/** shared / work 的会话落定表。 */
export function sessionScopeFileOf(dir) {
  return path.join(rawDirOf(dir), 'session-scope.jsonl');
}

/** life 的会话落定表。 */
export function lifeSessionScopeFileOf(dir) {
  return path.join(rawDirOf(dir), LIFE_SESSION_SCOPE_NAME);
}

/** 按 scope 选会话落定表。 */
export function sessionScopeFileForScope(dir, scope) {
  return scope === 'life' ? lifeSessionScopeFileOf(dir) : sessionScopeFileOf(dir);
}

/** 两条流水线各自会碰到的全部原文层目录（读侧要并读）。 */
export function allEventsDirsOf(dir) {
  return [eventsDirOf(dir), lifeEventsDirOf(dir)];
}

/** 这些路径必须进 .gitignore / LOCAL_ONLY，且与 bin/cm-remote.js 的常量同源。 */
export function localOnlyPaths() {
  return [
    'raw/' + LIFE_EVENTS_DIRNAME + '/',
    'impressions/' + LIFE_IMPRESSIONS_NAME,
    'raw/' + LIFE_SESSION_SCOPE_NAME
  ];
}
