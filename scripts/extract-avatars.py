#!/usr/bin/env python3
"""
从「AI MODEL RANKING 2026-10」榜单 PDF 的页面图里裁出**每家厂商一张** AI 娘头像。

产品决定：头像按厂商取（该厂商排名最高的那张立绘），同一家的所有模型共用一张；
没有立绘的厂商（如豆包 / Agnes）走面板里的字母 + 几何兜底。

来源（用户提供）：
  .cache/claude-opus-5-5.pdf        （40 页榜单）
  .cache/opus-transcript.json       （PDF 文本抽取：页码 → 模型名/厂商/评分）
  .cache/opus-pages/pNN.png         （已渲染的页面图）

输出：
  assets/avatars/vendor-<vendorId>.png   128×128，面板 40×40 头像用
  src/core/avatar-assets.ts              有内置头像的厂商 id 清单

用法：python scripts/extract-avatars.py
依赖：Pillow
"""
import io
import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = os.path.join(ROOT, '.cache', 'opus-pages')
TRANSCRIPT = os.path.join(ROOT, '.cache', 'opus-transcript.json')
OUT_DIR = os.path.join(ROOT, 'assets', 'avatars')
OUT_TS = os.path.join(ROOT, 'src', 'core', 'avatar-assets.ts')

# 人物立绘在页面右侧；按榜单模板固定取「脸部偏上」的方形区域。
SIDE_RATIO = 0.40
CENTER_X_RATIO = 0.79
CENTER_Y_RATIO = 0.27

# 榜单里的厂商名 → provider-templates 的 vendorId。
VENDOR_IDS = {
    'ANTHROPIC': 'anthropic',
    'OPENAI': 'openai',
    'GOOGLE': 'google',
    'META': 'meta',
    'MOONSHOT AI': 'moonshot',
    'DEEPSEEK': 'deepseek',
    'XIAOMI': 'xiaomi',
    'ALIBABA QWEN': 'alibaba',
    'MINIMAX': 'minimax',
    'XAI': 'xai',
    'Z.AI': 'zhipu',
    'STEPFUN': 'stepfun',
    'MISTRAL AI': 'mistral',
    'INKLING': 'inkling',
}


def crop_avatar(source: str) -> Image.Image:
    image = Image.open(source).convert('RGB')
    width, height = image.size
    side = int(height * SIDE_RATIO)
    cx = int(width * CENTER_X_RATIO)
    cy = int(height * CENTER_Y_RATIO)
    box = (
        max(0, cx - side // 2),
        max(0, cy - side // 2),
        min(width, cx + side // 2),
        min(height, cy + side // 2),
    )
    return image.crop(box).resize((128, 128), Image.Resampling.LANCZOS)


def main() -> int:
    if not os.path.isdir(PAGES):
        print('missing rendered pages: ' + PAGES, file=sys.stderr)
        return 1
    transcript = json.load(io.open(TRANSCRIPT, encoding='utf-8'))
    os.makedirs(OUT_DIR, exist_ok=True)

    # 每家厂商取排名最高（rank 最小）的一张立绘。
    best: dict[str, dict] = {}
    for card in transcript.get('cards', []):
        vendor_id = VENDOR_IDS.get(str(card.get('vendor', '')).upper())
        if vendor_id is None:
            continue
        current = best.get(vendor_id)
        if current is None or int(card['rank']) < int(current['rank']):
            best[vendor_id] = card

    # 清掉旧产物（历史版本曾按模型逐个出图）。
    for name in os.listdir(OUT_DIR):
        if name.endswith('.png'):
            os.remove(os.path.join(OUT_DIR, name))

    written: list[str] = []
    for vendor_id, card in sorted(best.items()):
        source = os.path.join(PAGES, 'p%02d.png' % int(card['page']))
        if not os.path.exists(source):
            print('skipped: %s (missing %s)' % (vendor_id, source), file=sys.stderr)
            continue
        crop_avatar(source).save(os.path.join(OUT_DIR, 'vendor-' + vendor_id + '.png'), optimize=True)
        written.append(vendor_id)
        print('%-10s <- p%02d %s' % (vendor_id, card['page'], card['model']))

    lines = [
        '/**',
        ' * 内置头像清单（由 scripts/extract-avatars.py 生成，请勿手改）。',
        ' *',
        ' * 每家厂商一张，取自用户提供的「AI MODEL RANKING 2026-10」榜单中',
        ' * 该厂商排名最高的立绘；存于 assets/avatars/vendor-<id>.png，',
        ' * 由宿主路由 api/token-steward/avatar?id=vendor-<id> 提供。',
        ' */',
        '',
        'export const BUNDLED_VENDOR_AVATARS: ReadonlySet<string> = new Set([',
    ]
    for vendor_id in written:
        lines.append("  '" + vendor_id + "',")
    lines.extend([
        '])',
        '',
        '/** 一个厂商的内置头像 URL；没有时 undefined（组件走字母几何兜底）。 */',
        'export function bundledAvatarUrl(vendorId: string): string | undefined {',
        "  return BUNDLED_VENDOR_AVATARS.has(vendorId) ? 'api/token-steward/avatar?id=' + encodeURIComponent('vendor-' + vendorId) : undefined",
        '}',
        '',
    ])
    io.open(OUT_TS, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines))
    print('vendors written: %d' % len(written))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
