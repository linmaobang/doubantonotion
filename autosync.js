// 自动同步：定时检查豆瓣上“我的标记”最近的变化，同步到 Notion。
//
// 做法：每次只看每个列表的第一页（最近 50 条），和上次记下的“快照”比较，
// 新出现的、状态/评分/短评/标签变了的条目进入队列；每次最多处理 MAX_PER_RUN 条，
// 剩下的过一会儿接着做。第一次运行只记快照、不导入（以前的标记请用批量导入）。

import { infoFromInterest, subjectKey } from './douban.js';

export const STATE_KEY = 'autoSync';
export const MAX_PER_RUN = 30;
export const PERIODS = { 360: '每 6 小时', 720: '每 12 小时', 1440: '每天' };

export const DEFAULT_STATE = {
  enabled: false,
  uid: '',
  kinds: { book: ['mark', 'doing', 'done'], movie: ['mark', 'doing', 'done'] },
  period: 1440,
  snapshot: {}, // subjectKey -> 签名
  baselined: false, // 第一次运行已经记过快照
  queue: [], // [{ info, sig, attempts }]
  lastRun: 0,
  lastResult: null, // { created, updated, failed, pending, error, errorCode, at }
};

// 一条标记的“签名”：这几样有变化就要同步
export function signature(info) {
  return [info.status, info.my_rating, info.comment, (info.my_tags || []).join(',')].join('|');
}

// 比较最新一页标记和快照，找出要同步的条目
export function findChanges(infos, snapshot) {
  const changes = [];
  for (const info of infos) {
    const key = subjectKey(info.url);
    if (!key) continue;
    const sig = signature(info);
    if (snapshot[key] === sig) continue;
    changes.push({ key, sig, info, isNew: !(key in snapshot) });
  }
  return changes;
}

// 把新变化并进队列：同一条只保留最新的一次
export function mergeQueue(queue, changes) {
  const map = new Map(queue.map((q) => [subjectKey(q.info.url), q]));
  for (const c of changes) map.set(c.key, { info: c.info, sig: c.sig, attempts: 0 });
  return [...map.values()];
}

/**
 * 跑一次自动同步。所有和外部打交道的操作都从 deps 传进来，方便测试：
 *   deps.interests({ uid, kind, status })  -> { interests }
 *   deps.detail(info)                      -> 详情页抓到的信息（失败返回 null）
 *   deps.sync(info)                        -> { updated }
 *   deps.wait(ms)
 *   deps.now()
 */
export async function runOnce(state, deps, { maxPerRun = MAX_PER_RUN } = {}) {
  const result = { created: 0, updated: 0, failed: 0, pending: 0, error: '', errorCode: '', at: deps.now() };
  const next = { ...state, snapshot: { ...state.snapshot }, queue: [...state.queue] };

  // 1. 读最近的标记
  const latest = [];
  try {
    for (const kind of ['book', 'movie']) {
      for (const status of next.kinds[kind] || []) {
        const page = await deps.interests({ uid: next.uid, kind, status });
        latest.push(...page.interests.map(infoFromInterest));
        await deps.wait(1500);
      }
    }
  } catch (err) {
    return { state: { ...next, lastRun: deps.now(), lastResult: { ...result, error: err.message, errorCode: err.code || '' } }, result };
  }

  // 2. 第一次：只记快照
  if (!next.baselined) {
    for (const info of latest) {
      const key = subjectKey(info.url);
      if (key) next.snapshot[key] = signature(info);
    }
    next.baselined = true;
    return { state: { ...next, lastRun: deps.now(), lastResult: { ...result, baseline: latest.length } }, result };
  }

  next.queue = mergeQueue(next.queue, findChanges(latest, next.snapshot));

  // 3. 处理队列
  let done = 0;
  while (next.queue.length && done < maxPerRun) {
    const item = next.queue[0];
    const key = subjectKey(item.info.url);
    try {
      const full = (await deps.detail(item.info)) || item.info;
      const r = await deps.sync(full);
      if (r.updated) result.updated++;
      else result.created++;
      next.snapshot[key] = item.sig;
      next.queue.shift();
    } catch (err) {
      // 豆瓣要验证 / 太频繁：这次先停，下次再来
      if (err.code === 'DOUBAN_CHALLENGE' || err.code === 'DOUBAN_BLOCKED') {
        result.error = err.message;
        result.errorCode = err.code;
        break;
      }
      item.attempts = (item.attempts || 0) + 1;
      next.queue.shift();
      if (item.attempts < 3) next.queue.push(item); // 失败的放到队尾，最多试 3 次
      else next.snapshot[key] = item.sig; // 放弃，免得每次都卡在这条
      result.failed++;
      result.lastFailure = `${item.info.title}：${err.message}`;
    }
    done++;
  }
  result.pending = next.queue.length;
  return { state: { ...next, lastRun: deps.now(), lastResult: result }, result };
}

export function timeAgo(ts, now = Date.now()) {
  const min = Math.round((now - ts) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

// 给设置页（text）和弹窗（short）用的状态
export function describeStatus(state, now = Date.now()) {
  if (!state?.enabled) return { kind: 'muted', text: '自动同步没有打开。', short: '自动同步没有打开' };
  const r = state.lastResult;
  if (!state.lastRun || !r) return { kind: 'info', text: '已打开，等待第一次运行（大约 1 分钟后）。', short: '自动同步：等待第一次运行' };
  const when = timeAgo(state.lastRun, now);
  if (r.errorCode === 'DOUBAN_CHALLENGE') {
    return {
      kind: 'error',
      text: `${when}同步时豆瓣要求安全验证。打开豆瓣让页面正常显示后，点「立即同步一次」。`,
      short: '自动同步暂停：豆瓣要求验证，打开豆瓣看一眼就好',
      needsDouban: true,
    };
  }
  if (r.errorCode === 'DOUBAN_BLOCKED') {
    return { kind: 'warn', text: `${when}同步时豆瓣认为请求太频繁，下次会自动重试。`, short: '自动同步：豆瓣限流，稍后自动重试' };
  }
  if (r.error) return { kind: 'error', text: `${when}同步失败：${r.error}`, short: `自动同步失败：${r.error}` };
  if (r.skipped) return { kind: 'info', text: `${when}：${r.skipped}。`, short: `自动同步：${when}跳过` };
  if (r.baseline !== undefined) {
    return { kind: 'success', text: `✓ ${when}记下了现在的 ${r.baseline} 条标记，之后的新变化会自动同步。`, short: `自动同步已就绪（${when}）` };
  }
  const parts = [];
  if (r.created) parts.push(`新增 ${r.created} 条`);
  if (r.updated) parts.push(`更新 ${r.updated} 条`);
  if (r.failed) parts.push(`失败 ${r.failed} 条`);
  const summary = parts.length ? parts.join('，') : '没有新变化';
  const pending = r.pending ? `，还有 ${r.pending} 条稍后继续` : '';
  return {
    kind: r.failed ? 'warn' : 'success',
    text: `✓ ${when}同步过，${summary}${pending}。`,
    short: `自动同步：${when} · ${summary}`,
  };
}
