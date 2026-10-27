import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_STATE, findChanges, mergeQueue, runOnce, signature } from '../autosync.js';
import { infoFromInterest } from '../douban.js';

const raw = JSON.parse(readFileSync(new URL('./fixtures/interests.json', import.meta.url)));
const [book, movie] = raw;

function deps({ pages = {}, failOn = {}, details = {} } = {}) {
  const synced = [];
  return {
    synced,
    interests: async ({ kind, status }) => ({ interests: pages[`${kind}:${status}`] || [] }),
    detail: async (info) => details[info.title] ?? { ...info, isbn: 'X' },
    sync: async (info) => {
      if (failOn[info.title]) throw Object.assign(new Error(failOn[info.title].message), { code: failOn[info.title].code });
      synced.push(info);
      return { updated: false };
    },
    wait: async () => {},
    now: () => 1000,
  };
}
const state = (over) => ({ ...DEFAULT_STATE, uid: 'u', kinds: { book: ['done'], movie: ['done'] }, ...over });

test('签名只看我的标记', () => {
  const a = infoFromInterest(book);
  assert.equal(signature(a), signature({ ...a, title: '别的名字' }));
  assert.notEqual(signature(a), signature({ ...a, my_rating: '5' }));
});

test('第一次运行只记快照，不导入', async () => {
  const d = deps({ pages: { 'book:done': [book], 'movie:done': [movie] } });
  const { state: s } = await runOnce(state(), d);
  assert.equal(d.synced.length, 0);
  assert.equal(s.baselined, true);
  assert.equal(Object.keys(s.snapshot).length, 2);
  assert.equal(s.lastResult.baseline, 2);
});

test('之后：新标记和改过的标记会同步，没变的跳过', async () => {
  const first = await runOnce(state(), deps({ pages: { 'book:done': [book] } }));
  const changedBook = { ...book, rating: { value: 5 } };
  const d = deps({ pages: { 'book:done': [changedBook], 'movie:done': [movie] } });
  const { state: s, result } = await runOnce(first.state, d);
  assert.deepEqual(d.synced.map((i) => i.title).sort(), ['Quiet', '我不是药神']);
  assert.equal(d.synced.find((i) => i.title === 'Quiet').isbn, 'X', '用的是详情页补全后的信息');
  assert.equal(result.created, 2);
  assert.equal(s.queue.length, 0);
  // 再跑一次：没有变化
  const d2 = deps({ pages: { 'book:done': [changedBook], 'movie:done': [movie] } });
  await runOnce(s, d2);
  assert.equal(d2.synced.length, 0);
});

test('每次最多处理 N 条，剩下的留到下次', async () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ ...book, subject: { ...book.subject, id: String(i), url: `https://book.douban.com/subject/${i}/`, title: `书${i}` } }));
  const base = state({ baselined: true });
  const { state: s, result } = await runOnce(base, deps({ pages: { 'book:done': many } }), { maxPerRun: 2 });
  assert.equal(result.created, 2);
  assert.equal(result.pending, 3);
  const { result: r2 } = await runOnce(s, deps({ pages: { 'book:done': many } }), { maxPerRun: 10 });
  assert.equal(r2.created, 3);
});

test('豆瓣要求验证：停下，队列保留，下次继续', async () => {
  const base = state({ baselined: true });
  const d = deps({ pages: { 'book:done': [book], 'movie:done': [movie] }, failOn: { Quiet: { code: 'DOUBAN_CHALLENGE', message: '豆瓣弹出了安全验证。' } } });
  const { state: s, result } = await runOnce(base, d);
  assert.equal(result.errorCode, 'DOUBAN_CHALLENGE');
  assert.equal(s.queue.length, 2);
  assert.equal(d.synced.length, 0);
});

test('普通失败：最多试 3 次，之后放弃', async () => {
  let s = state({ baselined: true });
  const d = deps({ pages: { 'book:done': [book] }, failOn: { Quiet: { message: 'Notion 出错' } } });
  for (let i = 0; i < 3; i++) s = (await runOnce(s, d)).state;
  assert.equal(s.queue.length, 0);
  assert.ok(s.snapshot['book:6896459'], '放弃后记进快照，不再重试');
});

test('读列表就失败：记下错误', async () => {
  const d = deps();
  d.interests = async () => { throw Object.assign(new Error('豆瓣要求做一次安全验证。'), { code: 'DOUBAN_CHALLENGE' }); };
  const { state: s } = await runOnce(state({ baselined: true }), d);
  assert.equal(s.lastResult.errorCode, 'DOUBAN_CHALLENGE');
});

test('mergeQueue 同一条只留最新', () => {
  const a = infoFromInterest(book);
  const q = mergeQueue([{ info: a, sig: 'old', attempts: 2 }], findChanges([{ ...a, my_rating: '5' }], {}));
  assert.equal(q.length, 1);
  assert.equal(q[0].attempts, 0);
});

import { describeStatus, timeAgo } from '../autosync.js';

test('状态文字', () => {
  const now = 10 * 3600 * 1000;
  assert.equal(timeAgo(now - 3 * 3600 * 1000, now), '3 小时前');
  assert.match(describeStatus({ enabled: false }).text, /没有打开/);
  assert.match(describeStatus({ enabled: true }).text, /等待第一次运行/);
  assert.match(describeStatus({ enabled: true, lastRun: now, lastResult: { baseline: 12 } }, now).text, /记下了现在的 12 条/);
  assert.match(describeStatus({ enabled: true, lastRun: now, lastResult: { created: 2, updated: 1, pending: 3 } }, now).text, /新增 2 条，更新 1 条，还有 3 条稍后继续/);
  const s = describeStatus({ enabled: true, lastRun: now, lastResult: { errorCode: 'DOUBAN_CHALLENGE' } }, now);
  assert.equal(s.kind, 'error');
  assert.ok(s.needsDouban);
});
