import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EMPTY_FILTERS, defaultSelection, filterItems, summarizeSelection, yearsOf } from '../selection.js';
import { infoFromInterest, subjectKey } from '../douban.js';

const raw = JSON.parse(readFileSync(new URL('./fixtures/interests.json', import.meta.url)));
// Quiet（书，2016，4 星）、我不是药神（电影，2018，5 星）、火花（剧，2017，5 星，已在 Notion）
const items = raw.map(infoFromInterest).map((i) => ({ ...i, key: subjectKey(i.url), exists: i.title === '火花' }));
const titles = (list) => list.map((i) => i.title);
const f = (over) => ({ ...EMPTY_FILTERS, ...over });

test('不筛选时全部显示', () => {
  assert.equal(filterItems(items, EMPTY_FILTERS).length, 3);
});

test('按类型', () => {
  assert.deepEqual(titles(filterItems(items, f({ types: ['book'] }))), ['Quiet']);
  assert.deepEqual(titles(filterItems(items, f({ types: ['movie', 'tv'] }))), ['我不是药神', '火花']);
});

test('按状态', () => {
  const mixed = [...items, { ...items[0], key: 'book:x', mark: 'mark', title: '想读的书' }];
  assert.deepEqual(titles(filterItems(mixed, f({ marks: ['mark'] }))), ['想读的书']);
});

test('按标记年份、我的评分', () => {
  assert.deepEqual(yearsOf(items), ['2018', '2017', '2016']);
  assert.deepEqual(titles(filterItems(items, f({ year: '2018' }))), ['我不是药神']);
  assert.deepEqual(titles(filterItems(items, f({ rating: '4' }))), ['Quiet']);
  const unrated = [...items, { ...items[1], key: 'movie:x', my_rating: '', title: '没打分' }];
  assert.deepEqual(titles(filterItems(unrated, f({ rating: 'none' }))), ['没打分']);
});

test('按导入情况', () => {
  assert.deepEqual(titles(filterItems(items, f({ show: 'new' }))), ['Quiet', '我不是药神']);
  assert.deepEqual(titles(filterItems(items, f({ show: 'existing' }))), ['火花']);
});

test('搜索标题、作者、导演，不区分大小写', () => {
  assert.deepEqual(titles(filterItems(items, f({ query: 'quiet' }))), ['Quiet']);
  assert.deepEqual(titles(filterItems(items, f({ query: 'susan' }))), ['Quiet']);
  assert.deepEqual(titles(filterItems(items, f({ query: '文牧野' }))), ['我不是药神']);
});

test('默认只勾选还没导入的；统计新增和更新', () => {
  const sel = defaultSelection(items);
  assert.deepEqual([...sel].sort(), ['book:6896459', 'movie:26752088']);
  assert.deepEqual(summarizeSelection(items, sel), { total: 2, toCreate: 2, toUpdate: 0 });
  sel.add('movie:26635329');
  assert.deepEqual(summarizeSelection(items, sel), { total: 3, toCreate: 2, toUpdate: 1 });
});
