/**
 * 用户可控的对象键。
 *
 * JSON / YAML 里的键名会被原样拿来当对象属性（模型 id、厂家 id、请求头名、
 * 台账里的模型名）。`{ }` 的 `__proto__` 是一个 setter——`out['__proto__'] = x`
 * 不会新增属性，而是改掉这个对象的原型；`constructor` / `prototype` 则常在
 * 后续的合并、展开里被当成普通键传播。结果通常是「配置看着保存了，读回来
 * 却少了字段」，极端情况下能污染共享对象的原型。
 *
 * 这里不做「转义」，直接拒绝：这三个名字没有一个是合法的模型 id 或 HTTP 头。
 */

/** 永远不能当数据键用的名字。 */
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/** 这个键能不能安全地写进普通对象。 */
export function isSafeRecordKey(key: string): boolean {
  return key !== '' && !UNSAFE_KEYS.has(key)
}
