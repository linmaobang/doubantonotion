import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChildren, mapProperties, pageDecorations, resolveFieldMap } from '../notion.js';
import { missingFields } from '../databases.js';

// 一个用户自己的英文书库
const db = {
  Name: { type: 'title' },
  Author: { type: 'rich_text' },
  评分: { type: 'number' }, // 用户拿来给自己打分
  Status: { type: 'status', status: { options: [{ name: '想读' }, { name: '读过' }] } },
  Finished: { type: 'date' },
  Douban: { type: 'url' },
};
const info = { type: 'book', title: '三体', author: '刘慈欣', rating: '8.9', my_rating: '5', status: '读过', marked_date: '2020-01-01', url: 'https://book.douban.com/subject/2567698/', summary: '简介', author_intro: '作者简介', cover: 'http://x/c.jpg' };

test('没有手动设置时：按候选名自动匹配（原来的行为）', () => {
  const r = resolveFieldMap(db, 'book');
  assert.equal(r.title, 'Name');
  assert.equal(r.rating, '评分');
  assert.equal(r.author, 'Author', '候选名不区分大小写');
  assert.equal(r.marked_date, undefined, '“Finished” 不在候选名里，要手动对应');
});

test('手动对应：Author ← 作者，评分 ← 我的评分，Status ← 我的状态，Finished ← 标记日期，Douban ← 豆瓣链接', () => {
  const fm = { map: { author: 'Author', my_rating: '评分', status: 'Status', marked_date: 'Finished', url: 'Douban' } };
  const { properties } = mapProperties(info, db, 'book', {}, fm);
  assert.equal(properties.Author.rich_text[0].text.content, '刘慈欣');
  assert.deepEqual(properties['评分'], { number: 5 }, '是我的评分，不是豆瓣评分');
  assert.deepEqual(properties.Status, { status: { name: '读过' } });
  assert.deepEqual(properties.Finished, { date: { start: '2020-01-01' } });
  assert.equal(properties.Douban.url, info.url);
});

test('“不写入”的列：自动匹配也不会用它', () => {
  const fm = { map: {}, ignored: ['评分'] };
  const { properties } = mapProperties(info, db, 'book', {}, fm);
  assert.ok(!('评分' in properties));
});

test('Notion 状态列：选项里没有的值不写，免得整页失败', () => {
  const fm = { map: { status: 'Status' } };
  const { properties } = mapProperties({ ...info, status: '在读' }, db, 'book', {}, fm);
  assert.ok(!('Status' in properties));
});

test('手动指定的列被删了：退回自动匹配，不报错', () => {
  const fm = { map: { title: '已删除的列' } };
  assert.equal(resolveFieldMap(db, 'book', fm).title, 'Name');
});

test('补列：不碰同名的已有列；选了“不新建”就什么都不加', () => {
  const fm = { map: {}, ignored: ['评分'] };
  const missing = missingFields(db, 'book', fm);
  assert.ok(!('评分' in missing), '“评分”列已存在（只是不写入），不能再建一个同名的');
  assert.ok('ISBN' in missing);
  assert.deepEqual(missingFields(db, 'book', { ...fm, addMissing: false }), {});
});

test('手动对应过的字段不再补列', () => {
  assert.ok('标记日期' in missingFields(db, 'book', { map: {} }));
  assert.ok(!('标记日期' in missingFields(db, 'book', { map: { marked_date: 'Finished' } })));
});

test('正文和页面封面可以关掉', () => {
  const blocks = buildChildren(info, { body: { summary: true, author_intro: false } });
  assert.equal(blocks.filter((b) => b.type === 'heading_2').length, 1);
  assert.ok(!('cover' in pageDecorations(info, null, { pageCover: false })));
  assert.ok('cover' in pageDecorations(info, null, {}));
});
