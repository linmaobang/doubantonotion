import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingFields, pickChildDatabase, resolveDatabase } from '../databases.js';
import { NotionError } from '../notion.js';
import { SCHEMAS } from '../config.js';

const PAGE = '11111111-1111-1111-1111-111111111111';
const DB = '22222222-2222-2222-2222-222222222222';
const OTHER = '33333333-3333-3333-3333-333333333333';

const propsOf = (schema) =>
  Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, { type: Object.keys(v)[0] }]));
const title = (text) => [{ plain_text: text, text: { content: text } }];

// 一个假的 Notion：记录所有写操作
function fakeClient({ databases = {}, children = [] } = {}) {
  const calls = [];
  return {
    calls,
    async getDatabase(id) {
      if (!databases[id]) throw new NotionError(404, 'object_not_found', 'not found');
      return { id, ...databases[id] };
    },
    async listChildren(pageId) {
      calls.push(['listChildren', pageId]);
      return children;
    },
    async createDatabase(pageId, schema) {
      calls.push(['createDatabase', pageId, schema.title[0].text.content]);
      return { id: 'new-db', title: title(schema.title[0].text.content), properties: propsOf(schema) };
    },
    async updateDatabase(id, body) {
      calls.push(['updateDatabase', id, Object.keys(body.properties)]);
      return { id, title: databases[id].title, properties: { ...databases[id].properties, ...body.properties } };
    },
  };
}

test('空白页面：自动新建数据库', async () => {
  const client = fakeClient();
  const r = await resolveDatabase(client, { parentPageId: PAGE }, 'book');
  assert.equal(r.how, 'created');
  assert.equal(r.databaseId, 'new-db');
  assert.deepEqual(client.calls.at(-1), ['createDatabase', PAGE, '我的书库']);
});

test('页面里已有同名数据库：沿用，不新建', async () => {
  const client = fakeClient({
    databases: { [DB]: { title: title('Movies'), properties: propsOf(SCHEMAS.movie) } },
    children: [
      { id: OTHER, type: 'child_database', archived: true, child_database: { title: '我的影院' } },
      { id: 'p', type: 'paragraph' },
      { id: DB, type: 'child_database', child_database: { title: 'Movies' } },
    ],
  });
  const r = await resolveDatabase(client, { parentPageId: PAGE }, 'movie');
  assert.equal(r.how, 'found');
  assert.equal(r.databaseId, DB);
  assert.ok(!client.calls.some(([c]) => c === 'createDatabase'));
  assert.ok(!client.calls.some(([c]) => c === 'updateDatabase'), '字段齐全时不应修改数据库');
});

test('已有数据库缺字段：只补缺的，已有字段不动', async () => {
  const old = { 书名: { type: 'title' }, 作者: { type: 'rich_text' }, 出版日期: { type: 'rich_text' }, 评分: { type: 'number' } };
  const client = fakeClient({ databases: { [DB]: { title: title('我的书'), properties: old } } });
  const r = await resolveDatabase(client, { bookDatabaseId: DB }, 'book');
  assert.equal(r.how, 'configured');
  const [, id, added] = client.calls.find(([c]) => c === 'updateDatabase');
  assert.equal(id, DB);
  for (const kept of ['书名', '作者', '出版日期', '评分']) assert.ok(!added.includes(kept), `不应改动已有字段 ${kept}`);
  for (const want of ['封面', '状态', '我的评分', '标记日期', 'ISBN', '链接']) assert.ok(added.includes(want), `应补上 ${want}`);
  assert.deepEqual(r.added, added);
});

test('指定的数据库被删了：退回到页面里自动处理', async () => {
  const client = fakeClient();
  const r = await resolveDatabase(client, { tvDatabaseId: DB, parentPageId: PAGE }, 'tv');
  assert.equal(r.how, 'created');
  assert.deepEqual(client.calls.at(-1), ['createDatabase', PAGE, '我的剧集']);
});

test('指定的数据库被删了，又没有页面：报错，不乱建', async () => {
  const client = fakeClient();
  await assert.rejects(resolveDatabase(client, { tvDatabaseId: DB }, 'tv'), /not found/);
});

test('什么都没设置：提示选页面', async () => {
  await assert.rejects(resolveDatabase(fakeClient(), {}, 'book'), /Notion 页面/);
});

test('预览模式只看不动', async () => {
  const client = fakeClient({ databases: { [DB]: { title: title('x'), properties: { 名称: { type: 'title' } } } } });
  const a = await resolveDatabase(client, { parentPageId: PAGE }, 'book', { create: false });
  assert.equal(a.how, 'create');
  assert.equal(a.dbTitle, '我的书库');
  const b = await resolveDatabase(client, { movieDatabaseId: DB }, 'movie', { create: false });
  assert.ok(b.missing.includes('导演'));
  assert.ok(!client.calls.some(([c]) => c === 'createDatabase' || c === 'updateDatabase'));
});

test('missingFields：同名但类型不同的字段也算已有，不重复添加', () => {
  const props = { 片名: { type: 'title' }, 上映日期: { type: 'rich_text' }, 状态: { type: 'status' } };
  const missing = missingFields(props, 'movie');
  assert.ok(!('上映日期' in missing));
  assert.ok(!('状态' in missing));
  assert.ok('导演' in missing);
});

test('pickChildDatabase 只认对应类型的名字', () => {
  const blocks = [{ id: 'a', type: 'child_database', child_database: { title: '我的影院' } }];
  assert.equal(pickChildDatabase(blocks, 'book'), null);
  assert.equal(pickChildDatabase(blocks, 'movie').id, 'a');
});
