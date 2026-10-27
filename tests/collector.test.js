import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceLabel } from '../collector.js';
import { mergeDetail } from '../douban.js';
import { mapProperties } from '../notion.js';
import { SCHEMAS } from '../config.js';

test('sourceLabel 给来源起短名字', () => {
  assert.equal(sourceLabel('https://www.douban.com/doulist/250576/', '｜五颗星经典系列｜'), '豆列：｜五颗星经典系列｜');
  assert.equal(sourceLabel('https://book.douban.com/tag/科幻', '豆瓣图书标签: 科幻'), '标签：科幻');
  assert.equal(sourceLabel('https://book.douban.com/top250?start=25', '豆瓣读书 Top 250'), '豆瓣读书 Top250');
  assert.equal(sourceLabel('https://movie.douban.com/top250', '豆瓣电影 Top 250'), '豆瓣电影 Top250');
  assert.equal(sourceLabel('https://book.douban.com/people/ahbei/wish', '阿北想读的书(81)'), '阿北想读的书(81)');
  assert.ok(sourceLabel('https://www.douban.com/doulist/1/', 'x'.repeat(80)).length < 50);
});

test('列表里分不清电影/剧集时，用详情页的判断', () => {
  const fromList = { type: 'movie', typeGuess: true, title: '火花', url: 'u', source: '豆列：日剧' };
  const merged = mergeDetail(fromList, { type: 'tv', title: '火花', episodes: '10' });
  assert.equal(merged.type, 'tv');
  assert.equal(merged.episodes, '10');
  assert.equal(merged.source, '豆列：日剧', '来源保留列表里的');
  assert.ok(!('typeGuess' in merged));
});

test('列表已确定类型时，不被详情页改掉', () => {
  const merged = mergeDetail({ type: 'tv', title: 'x' }, { type: 'movie', title: 'x' });
  assert.equal(merged.type, 'tv');
});

test('来源写进「来源」字段', () => {
  const props = Object.fromEntries(Object.entries(SCHEMAS.book.properties).map(([k, v]) => [k, { type: Object.keys(v)[0] }]));
  const { properties } = mapProperties({ type: 'book', title: '三体', source: '标签：科幻' }, props, 'book');
  assert.deepEqual(properties['来源'], { multi_select: [{ name: '标签：科幻' }] });
});

test('从列表页导入时，详情页上你自己的标记会带进来；我的标记列表里已有的不被覆盖', () => {
  const page = { type: 'book', title: '三体', mark: 'done', status: '读过', my_rating: '5', marked_date: '2020-01-01' };
  const fromDoulist = mergeDetail({ type: 'book', title: '三体', source: '豆列：x' }, page);
  assert.equal(fromDoulist.status, '读过');
  assert.equal(fromDoulist.my_rating, '5');
  const fromMine = mergeDetail({ type: 'book', title: '三体', status: '在读', my_rating: '3' }, page);
  assert.equal(fromMine.status, '在读');
  assert.equal(fromMine.my_rating, '3');
});
