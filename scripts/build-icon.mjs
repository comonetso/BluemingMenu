/**
 * 아이콘 빌드 — SVG 하나에서 Windows .ico 전 해상도를 만든다.
 *
 *   npm run icon
 *
 * 아이콘을 고칠 때는 SVG 원본만 수정하고 이 스크립트를 다시 돌린다.
 * 래스터를 직접 손대면 해상도별로 어긋나므로 SVG 가 유일한 원본이다.
 */
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'assets', 'icons', 'd-rising.svg');
const BUILD_DIR = path.join(ROOT, 'assets', 'icons', 'build');
const ICO_OUT = path.join(ROOT, 'assets', 'icons', 'icon.ico');
const PNG_OUT = path.join(ROOT, 'assets', 'icons', 'icon.png');

/** Windows .ico 표준 해상도. 16 은 컨텍스트 메뉴, 32 는 작업표시줄, 256 은 큰 아이콘 보기. */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  const svg = await readFile(SRC);
  await mkdir(BUILD_DIR, { recursive: true });

  // 각 해상도를 SVG 에서 개별 렌더한다. 큰 PNG 를 축소하면 작은 크기가 뭉개진다.
  const pngPaths = [];
  for (const size of SIZES) {
    const out = path.join(BUILD_DIR, `icon-${size}.png`);
    await sharp(svg, { density: 384 })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(out);
    pngPaths.push(out);
    console.log(`  ${String(size).padStart(3)}px  →  ${path.relative(ROOT, out)}`);
  }

  await writeFile(ICO_OUT, await pngToIco(pngPaths));
  console.log(`\n  .ico  →  ${path.relative(ROOT, ICO_OUT)}  (${SIZES.length}종 해상도 포함)`);

  // 개발 중 BrowserWindow 아이콘용. 패키징 전에는 .ico 가 적용되지 않는다.
  await sharp(svg, { density: 384 }).resize(256, 256).png().toFile(PNG_OUT);
  console.log(`  .png  →  ${path.relative(ROOT, PNG_OUT)}  (개발용 256px)`);
}

main().catch((err) => {
  console.error('아이콘 빌드 실패:', err);
  process.exit(1);
});
