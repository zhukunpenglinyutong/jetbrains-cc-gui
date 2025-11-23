import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const distFile = path.resolve(cwd, 'dist/index.html');
const targetFile = path.resolve(cwd, '../src/main/resources/html/claude-chat.html');

const main = async () => {
  const html = await readFile(distFile, 'utf-8');
  await mkdir(path.dirname(targetFile), { recursive: true });
  await writeFile(targetFile, html, 'utf-8');
  console.log(`[copy-dist] 已同步 ${distFile} -> ${targetFile}`);
};

main().catch((error) => {
  console.error('[copy-dist] 复制构建产物失败', error);
  process.exit(1);
});

