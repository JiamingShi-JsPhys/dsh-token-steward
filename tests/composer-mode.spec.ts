/**
 * 输入框里的模型名 → 档位。
 *
 * 这是「点完模型选择、悬浮球立刻跟着变」的那条判断链：
 * 只认管家自己的模型名，且「自动」「子代理」都不改档。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modeOfModelLabel, readComposerMode } from '../src/client/composer-mode.ts'

test('四个档位的模型名都认得', () => {
  assert.equal(modeOfModelLabel('管家·极致便宜'), 'frugal')
  assert.equal(modeOfModelLabel('管家·效率优先'), 'balanced')
  assert.equal(modeOfModelLabel('管家·最强火力'), 'max_power')
  assert.equal(modeOfModelLabel('管家·免费档'), 'free')
})

test('自动与子代理不改档：前者跟全局，后者不是模式', () => {
  assert.equal(modeOfModelLabel('管家·自动'), undefined)
  assert.equal(modeOfModelLabel('管家·子代理'), undefined)
})

test('虚拟 id 与英文写法也认', () => {
  assert.equal(modeOfModelLabel('steward:freeload'), 'free')
  assert.equal(modeOfModelLabel('steward:frugal'), 'frugal')
  assert.equal(modeOfModelLabel('Steward Max Power'), 'max_power')
})

test('不是管家的模型名一律不认（设置页的「免费档」按钮不能误判）', () => {
  assert.equal(modeOfModelLabel('免费档'), undefined)
  assert.equal(modeOfModelLabel('DeepSeek Flash'), undefined)
  assert.equal(modeOfModelLabel(''), undefined)
})

test('readComposerMode 取最靠下的那个（输入框在页面底部）', () => {
  const doc = {
    querySelectorAll: () => [
      { textContent: '管家·免费档', getBoundingClientRect: () => ({ width: 80, height: 28, y: 120 }) },
      { textContent: '管家·最强火力', getBoundingClientRect: () => ({ width: 80, height: 28, y: 760 }) },
      { textContent: '管家·自动', getBoundingClientRect: () => ({ width: 80, height: 28, y: 790 }) },
    ],
  } as unknown as Document
  assert.equal(readComposerMode(doc), 'max_power')
})

test('readComposerMode 在极简宿主里不炸', () => {
  assert.equal(readComposerMode({} as unknown as Document), undefined)
})
