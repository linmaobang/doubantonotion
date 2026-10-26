import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeId, parseDate, parseNumber, richText, formatValue, mapProperties, buildChildren, findField,
} from '../notion.js';
import { MAPPINGS, SCHEMAS } from '../config.js';

const ID = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';
const UUID = '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';

test('normalizeId 支持各种写法', () => {
  assert.equal(normalizeId(ID), UUID);
  assert.equal(normalizeId(UUID), UUID);
  assert.equal(normalizeId(`https://www.notion.so/ws/My-Books-${ID}`), UUID);
  assert.equal(normalizeId(`https://www.notion.so/Cafe-${ID}`), UUID);
  assert.equal(normalizeId(`https://www.notion.so/${ID}?v=ffffffffffffffffffffffffffffffff`), UUID);
  assert.equal(normalizeId(''), '');
  assert.equal(normalizeId('not-an-id'), 'not-an-id');
});

test('parseDate 取最早的日期并补全', () => {
  assert.equal(parseDate('2003-8'), '2003-08-01');
  assert.equal(parseDate('2003'), '2003-01-01');
  assert.equal(parseDate('2019年7月'), '2019-07-01');
  assert.equal(parseDate('2026-08-28(中国大陆) / 1994-09-10(多伦多电影节) / 1994-10-14(美国)'), '1994-09-10');
  assert.equal(parseDate('未知'), null);
});

test('parseNumber', () => {
  assert.equal(parseNumber('22.00元'), 22);
  assert.equal(parseNumber('1,024'), 1024);
  assert.equal(parseNumber('9.7'), 9.7);
  assert.equal(parseNumber(''), null);
});

test('richText 按 2000 字分段', () => {
  const parts = richText('字'.repeat(4500));
  assert.equal(parts.length, 3);
  assert.equal(parts[0].text.content.length, 2000);
  assert.equal(parts[2].text.content.length, 500);
});

test('multi_select 拆分并去掉逗号', () => {
  assert.deepEqual(formatValue('剧情 / 喜剧 / 剧情', 'multi_select'), {
    multi_select: [{ name: '剧情' }, { name: '喜剧' }],
  });
  assert.deepEqual(formatValue(['a,b'], 'multi_select'), { multi_select: [{ name: 'a，b' }] });
  assert.equal(formatValue([], 'multi_select'), null);
});

test('number / date 解析失败时跳过而不是报错', () => {
  assert.equal(formatValue('暂无', 'number'), null);
  assert.equal(formatValue('暂无', 'date'), null);
});

test('封面优先用上传的文件', () => {
  assert.deepEqual(formatValue('http://x/a.jpg', 'files', 'cover', { coverUploadId: 'u1' }).files[0].file_upload, { id: 'u1' });
  assert.equal(formatValue('http://x/a.jpg', 'files', 'cover').files[0].external.url, 'http://x/a.jpg');
  assert.equal(formatValue('x', 'files', 'other'), null);
});

test('标题字段名对不上时用数据库的 title 字段', () => {
  const props = { 我的标题: { type: 'title' }, 链接: { type: 'url' } };
  assert.equal(findField('title', props, MAPPINGS.book), '我的标题');
});

const dbFromSchema = (schema) =>
  Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, { type: Object.keys(v)[0] }]));

test('自动创建的数据库：每个字段都能被映射到', () => {
  for (const type of ['book', 'movie', 'tv']) {
    const props = dbFromSchema(SCHEMAS[type]);
    const reachable = new Set(Object.keys(MAPPINGS[type]).map((k) => findField(k, props, MAPPINGS[type])));
    for (const name of Object.keys(props)) {
      if (name === '状态') continue; // 用户自己填
      assert.ok(reachable.has(name), `${type}: 字段「${name}」没有映射`);
    }
  }
});

test('电影条目映射到自动创建的电影库', () => {
  const info = {
    type: 'movie', title: '肖申克的救赎', url: 'https://movie.douban.com/subject/1292052/',
    cover: 'https://img/x.webp', rating: '9.7', year: '1994', director: '弗兰克·德拉邦特',
    genres: ['剧情', '犯罪'], country: '美国', release_date: '1994-09-10(多伦多电影节)', runtime: '142分钟',
    imdb: 'tt0111161', tags: [], summary: '很长的简介',
  };
  const { properties } = mapProperties(info, dbFromSchema(SCHEMAS.movie), 'movie');
  assert.equal(properties['片名'].title[0].text.content, '肖申克的救赎');
  assert.deepEqual(properties['评分'], { number: 9.7 });
  assert.deepEqual(properties['年份'], { number: 1994 });
  assert.deepEqual(properties['上映日期'], { date: { start: '1994-09-10' } });
  assert.equal(properties['类型'].multi_select.length, 2);
  assert.equal(properties['链接'].url, info.url);
  assert.ok(!('标签' in properties), '空标签不应写入');
});

test('旧版数据库（出版日期是文本）也能写入', () => {
  const props = { 书名: { type: 'title' }, 出版日期: { type: 'rich_text' }, 评分: { type: 'number' } };
  const { properties } = mapProperties({ type: 'book', title: 'x', pubdate: '2003-8', rating: '' }, props, 'book');
  assert.equal(properties['出版日期'].rich_text[0].text.content, '2003-8');
  assert.ok(!('评分' in properties));
});

test('正文：简介按段落拆成块', () => {
  const blocks = buildChildren({ summary: '第一段\n\n第二段', author_intro: '作者' });
  assert.deepEqual(blocks.map((b) => b.type), ['heading_2', 'paragraph', 'paragraph', 'heading_2', 'paragraph']);
});
