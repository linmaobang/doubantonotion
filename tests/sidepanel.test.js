import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('sidepanel.html 和 popup.html 的内容保持一致（只差 body 的 panel）', () => {
  const panel = read('sidepanel.html')
    .replace(/<!-- 侧边栏：[^>]*-->\n/, '')
    .replace('<body class="popup panel">', '<body class="popup">')
    .replace(' · 侧边栏</title>', '</title>');
  assert.equal(panel, read('popup.html'));
});

test('manifest 注册了侧边栏', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.side_panel.default_path, 'sidepanel.html');
  assert.ok(m.permissions.includes('sidePanel'));
});
