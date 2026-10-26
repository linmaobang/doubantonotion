import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blockKind, infoFromInterest, mergeDetail, parseUserId, subjectKey } from '../douban.js';
import { mapProperties } from '../notion.js';
import { SCHEMAS } from '../config.js';

// 真实的豆瓣移动端接口返回（一本书、一部电影、一部剧，略有裁剪）
const [book, movie, tv] = JSON.parse(readFileSync(new URL('./fixtures/interests.json', import.meta.url)));

test('parseUserId 支持各种主页链接', () => {
  assert.equal(parseUserId('https://www.douban.com/people/ahbei/'), 'ahbei');
  assert.equal(parseUserId('https://book.douban.com/people/1234567/collect?start=15'), '1234567');
  assert.equal(parseUserId('  ahbei '), 'ahbei');
  assert.equal(parseUserId('https://www.douban.com/'), '');
  assert.equal(parseUserId(''), '');
});

test('subjectKey 只看域名和编号', () => {
  assert.equal(subjectKey('https://movie.douban.com/subject/26752088/'), 'movie:26752088');
  assert.equal(subjectKey('http://movie.douban.com/subject/26752088?from=x'), 'movie:26752088');
  assert.equal(subjectKey('https://book.douban.com/subject/1084336/'), 'book:1084336');
  assert.equal(subjectKey('https://example.com'), null);
});

test('图书：列表数据 + 我的标记', () => {
  const info = infoFromInterest(book);
  assert.equal(info.type, 'book');
  assert.equal(info.title, 'Quiet');
  assert.equal(info.author, 'Susan Cain');
  assert.equal(info.publisher, 'Crown Publishing Group (NY)');
  assert.equal(info.pubdate, '2012-1-24');
  assert.equal(info.pages, '333');
  assert.equal(info.rating, '8.3');
  assert.equal(info.status, '读过');
  assert.equal(info.my_rating, '4');
  assert.equal(info.marked_date, '2016-02-21');
  assert.deepEqual(info.my_tags, ['心理学']);
  assert.match(info.cover, /\/subject\/l\//);
});

test('电影和剧集用 subtype 区分', () => {
  const m = infoFromInterest(movie);
  const t = infoFromInterest(tv);
  assert.equal(m.type, 'movie');
  assert.equal(t.type, 'tv');
  assert.equal(m.director, '文牧野');
  assert.equal(m.release_date, '2018-07-05(中国大陆)');
  assert.equal(t.first_air_date, '2016-06-03(日本)');
  assert.equal(t.status, '看过');
  assert.deepEqual(m.genres, ['剧情', '喜剧']);
});

test('想看 / 在看 的状态文字', () => {
  assert.equal(infoFromInterest({ ...movie, status: 'mark' }).status, '想看');
  assert.equal(infoFromInterest({ ...book, status: 'doing' }).status, '在读');
  assert.equal(infoFromInterest({ ...movie, rating: null }).my_rating, '');
});

test('mergeDetail：详情页补全字段，但不覆盖我的标记', () => {
  const fromList = infoFromInterest(movie);
  const fromPage = {
    type: 'movie',
    title: '我不是药神',
    screenwriter: '韩家女 / 钟伟 / 文牧野',
    imdb: 'tt7362036',
    summary: '完整简介',
    tags: [],
    status: '不该出现',
  };
  const merged = mergeDetail(fromList, fromPage);
  assert.equal(merged.screenwriter, '韩家女 / 钟伟 / 文牧野');
  assert.equal(merged.imdb, 'tt7362036');
  assert.equal(merged.summary, '完整简介');
  assert.equal(merged.status, '看过');
  assert.equal(merged.director, '文牧野', '详情页没有的字段保留列表数据');
});

test('blockKind 区分验证页和限流，404 不算', () => {
  assert.equal(blockKind({ status: 200, finalUrl: 'https://sec.douban.com/c?r=x', html: '' }), 'challenge');
  assert.equal(blockKind({ status: 200, finalUrl: 'https://movie.douban.com/subject/1/', html: '<html>' }), 'challenge');
  assert.equal(blockKind({ status: 403, finalUrl: '', html: '' }), 'rate');
  assert.equal(blockKind({ status: 418, finalUrl: '', html: '' }), 'rate');
  assert.equal(blockKind({ status: 200, finalUrl: 'https://movie.douban.com/subject/1/', html: '<div id="info">' }), null);
  assert.equal(blockKind({ status: 404, finalUrl: '', html: '' }), null);
});

test('批量导入的数据能写进自动创建的数据库，包括我的标记', () => {
  const props = (type) =>
    Object.fromEntries(Object.entries(SCHEMAS[type].properties).map(([k, v]) => [k, { type: Object.keys(v)[0] }]));
  const { properties } = mapProperties(infoFromInterest(tv), props('tv'), 'tv');
  assert.deepEqual(properties['状态'], { select: { name: '看过' } });
  assert.deepEqual(properties['我的评分'], { number: 5 });
  assert.deepEqual(properties['标记日期'], { date: { start: '2017-11-05' } });
  assert.equal(properties['短评'].rich_text[0].text.content, '10小时长的电影。超赞不多说。');
  assert.deepEqual(properties['我的标签'], { multi_select: [{ name: '日本' }] });
  assert.deepEqual(properties['首播日期'], { date: { start: '2016-06-03' } });
});
