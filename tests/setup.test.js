import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldForError, missingFrom } from '../setup.js';

test('还缺哪一步', () => {
  assert.equal(missingFrom({}), 'token');
  assert.equal(missingFrom({ notionToken: 'x' }), 'page');
  assert.equal(missingFrom({ notionToken: 'x', parentPageId: 'p' }), null);
  assert.equal(missingFrom({ notionToken: 'x', bookDatabaseId: 'd' }, ['book']), null, '只导图书时，有图书库就够了');
  assert.equal(missingFrom({ notionToken: 'x', bookDatabaseId: 'd' }, ['movie', 'tv']), 'page');
});

test('从报错看出该去哪一栏', () => {
  assert.equal(fieldForError('Notion Token 无效，请到设置页重新填写。'), 'token');
  assert.equal(fieldForError('还没有填写 Notion Token，请先打开设置页。'), 'token');
  assert.equal(fieldForError('找不到这个数据库或页面。请确认 ID 正确……'), 'page');
  assert.equal(fieldForError('还没有选择 Notion 页面。请在设置页填一个页面链接……'), 'page');
  assert.equal(fieldForError('网络请求失败'), null);
});
