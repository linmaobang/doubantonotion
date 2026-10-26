import { TYPE_LABELS, STATUS_LABELS } from './config.js';
import { infoFromInterest, mergeDetail, parseUserId, subjectKey } from './douban.js';
import { scrapeDouban } from './scraper.js';

// ---------- 节奏控制 ----------
// 实测约 1.5 秒一个详情页没有触发验证；这里取得更保守，并加随机抖动。
const LIST_GAP_MS = 1500; // 列表接口两次请求之间
const DETAIL_GAP_MS = 3000; // 详情页两次请求之间（再加 0~2 秒随机）
const DETAIL_JITTER_MS = 2000;
const BLOCK_BACKOFF_MS = [60 * 1000, 3 * 60 * 1000]; // 被拦后的等待时间，用完就暂停交给用户
const PAGE_SIZE = 50;
const JOB_KEY = 'importJob';

const $ = (id) => document.getElementById(id);

// ---------- 和后台通信 ----------

async function bg(action, payload = {}) {
  const res = await chrome.runtime.sendMessage({ action, ...payload });
  if (!res) throw Object.assign(new Error('后台没有响应'), { code: 'NO_RESPONSE' });
  if (!res.success) throw Object.assign(new Error(res.error), { code: res.code });
  return res.data;
}

// 在后台等待，避免页面切到后台后定时器被限流
async function sleep(ms) {
  let left = ms;
  while (left > 0) {
    const chunk = Math.min(left, 4 * 60 * 1000);
    await bg('sleep', { ms: chunk });
    left -= chunk;
  }
}

let lastDoubanAt = 0;
async function doubanGap(gap) {
  const wait = lastDoubanAt + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastDoubanAt = Date.now();
}

// ---------- 任务状态（存在本地，关掉页面也能接着导） ----------

let job = null;
let running = false;
let pauseRequested = false;

async function saveJob() {
  await chrome.storage.local.set({ [JOB_KEY]: job });
}

async function clearJob() {
  job = null;
  await chrome.storage.local.remove(JOB_KEY);
}

// ---------- 第一步：读取列表 ----------

function readConfig() {
  const checked = (name) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
  return {
    uid: parseUserId($('uid').value),
    kinds: { book: checked('book'), movie: checked('movie') },
    detail: checked('detail')[0] === 'full',
    onExisting: checked('existing')[0],
  };
}

function scanStatus(text, kind = 'info') {
  $('scanStatus').textContent = text;
  $('scanStatus').className = `row-status ${kind}`;
}

async function fetchInterests(uid, kind, status) {
  const label = STATUS_LABELS[kind][status];
  const all = [];
  let total = Infinity;
  for (let start = 0; start < total; start += PAGE_SIZE) {
    await doubanGap(LIST_GAP_MS);
    const page = await bg('doubanInterests', { uid, kind, status, start, count: PAGE_SIZE });
    total = page.total;
    all.push(...page.interests);
    scanStatus(`正在读取「${label}」：${all.length} / ${total}`);
    if (page.interests.length === 0) break;
  }
  return all;
}

async function scan() {
  const config = readConfig();
  if (!config.uid) return scanStatus('请填写豆瓣个人主页链接或用户 ID。', 'error');
  if (!config.kinds.book.length && !config.kinds.movie.length) {
    return scanStatus('至少勾选一项要导入的内容。', 'error');
  }

  const settings = await chrome.storage.local.get(['notionToken', 'parentPageId', 'bookDatabaseId', 'movieDatabaseId', 'tvDatabaseId']);
  const needTypes = [
    ...(config.kinds.book.length ? ['book'] : []),
    ...(config.kinds.movie.length ? ['movie', 'tv'] : []),
  ];
  if (!settings.notionToken) return scanStatus('还没有填写 Notion Token，请先到设置页完成设置。', 'error');
  const noTarget = needTypes.filter((t) => !settings.parentPageId && !settings[`${t}DatabaseId`]);
  if (noTarget.length) return scanStatus('还没有选择 Notion 页面，请先到设置页填一个页面链接。', 'error');

  $('scanBtn').disabled = true;
  try {
    // 1. 拉豆瓣列表
    const items = [];
    const seen = new Set();
    for (const kind of ['book', 'movie']) {
      for (const status of config.kinds[kind]) {
        for (const interest of await fetchInterests(config.uid, kind, status)) {
          const info = infoFromInterest(interest);
          const key = subjectKey(info.url);
          if (key && !seen.has(key)) {
            seen.add(key);
            items.push(info);
          }
        }
      }
    }

    // 2. 查 Notion 里已有的条目，顺便看每类会写进哪个数据库
    scanStatus('正在检查 Notion 里已有的条目…');
    const existing = new Set();
    const targets = {};
    for (const type of needTypes) {
      const r = await bg('listExisting', { type });
      targets[type] = r;
      r.keys.forEach((k) => existing.add(k));
    }
    const alreadyIn = items.filter((i) => existing.has(subjectKey(i.url)));
    const todo = config.onExisting === 'skip' ? items.filter((i) => !existing.has(subjectKey(i.url))) : items;

    job = {
      config,
      phase: 'review',
      items: todo,
      next: 0,
      stats: { created: 0, updated: 0, failed: 0 },
      failures: [],
      found: items.length,
      alreadyIn: alreadyIn.length,
      noDedupe: Object.entries(targets).filter(([, r]) => !r.canDedupe).map(([t]) => t),
      targets: Object.fromEntries(Object.entries(targets).map(([t, r]) => [t, { how: r.how, dbTitle: r.dbTitle, missing: r.missing }])),
      createdAt: Date.now(),
    };
    await saveJob();
    scanStatus('');
    showReview();
  } catch (err) {
    scanStatus(scanError(err), 'error');
  } finally {
    $('scanBtn').disabled = false;
  }
}

function scanError(err) {
  if (err.code === 'DOUBAN_CHALLENGE') {
    return `豆瓣要求做一次安全验证。请在浏览器里打开 https://m.douban.com/people/${readConfig().uid}/ ，等页面正常显示后再点「读取列表」。`;
  }
  if (err.code === 'DOUBAN_BLOCKED') return '豆瓣认为请求太频繁，请过一会儿再试。';
  return err.message;
}

// ---------- 第二步：确认 ----------

function minutes(n) {
  const perItem = job.config.detail ? 5 : 1.2; // 秒，包含写 Notion 的时间
  const m = Math.ceil((n * perItem) / 60);
  return m < 60 ? `约 ${m} 分钟` : `约 ${(m / 60).toFixed(1)} 小时`;
}

function li(text) {
  const el = document.createElement('li');
  el.textContent = text;
  return el;
}

function showReview() {
  show('review');
  const byType = {};
  for (const i of job.items) byType[i.type] = (byType[i.type] || 0) + 1;
  const parts = Object.entries(byType).map(([t, n]) => `${TYPE_LABELS[t]} ${n}`);
  const lines = [`豆瓣上共读到 ${job.found} 条标记。`];
  if (job.alreadyIn) {
    lines.push(
      job.config.onExisting === 'skip'
        ? `其中 ${job.alreadyIn} 条已经在 Notion 里，会跳过。`
        : `其中 ${job.alreadyIn} 条已经在 Notion 里，会更新。`,
    );
  }
  lines.push(
    job.items.length
      ? `本次要处理 ${job.items.length} 条（${parts.join('，')}），${minutes(job.items.length)}。`
      : '没有需要导入的新条目。',
  );
  for (const t of job.noDedupe) {
    lines.push(`⚠ ${TYPE_LABELS[t]}数据库没有「链接」字段，无法判断是否重复，可能会导入重复条目。`);
  }
  $('summary').replaceChildren(...lines.map(li));

  // 每类条目会写进哪个数据库
  const used = new Set(job.items.map((i) => i.type));
  const targetLines = Object.entries(job.targets || {})
    .filter(([t]) => used.has(t))
    .map(([t, r]) => {
      const head = `${TYPE_LABELS[t]}会写进`;
      if (r.how === 'create') return `${head}自动新建的「${r.dbTitle}」。`;
      const extra = r.missing.length ? `，并补上缺少的字段：${r.missing.join('、')}` : '';
      return `${head}「${r.dbTitle}」${extra}。`;
    });
  $('targets').replaceChildren(...targetLines.map(li));
  $('targets').hidden = targetLines.length === 0;
  $('startBtn').disabled = job.items.length === 0;
}

// ---------- 第三步：导入 ----------

function log(text, kind = '') {
  const el = li(text);
  el.className = kind;
  $('log').prepend(el);
  while ($('log').children.length > 50) $('log').lastChild.remove();
}

function renderProgress() {
  const { next, items, stats } = job;
  $('bar').style.width = `${items.length ? (next / items.length) * 100 : 100}%`;
  const parts = [`${next} / ${items.length}`, `新增 ${stats.created}`];
  if (stats.updated) parts.push(`更新 ${stats.updated}`);
  if (stats.failed) parts.push(`失败 ${stats.failed}`);
  if (next < items.length) parts.push(`剩余${minutes(items.length - next)}`);
  $('counts').textContent = parts.join(' · ');

  $('failBox').hidden = job.failures.length === 0;
  $('failSummary').textContent = `失败的条目（${job.failures.length}）`;
  $('failList').replaceChildren(
    ...job.failures.map((f) => {
      const el = li('');
      const a = document.createElement('a');
      a.href = f.info.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = f.info.title;
      el.append(a, `：${f.error}`);
      return el;
    }),
  );

  const done = next >= items.length;
  $('pauseBtn').hidden = !running;
  $('continueBtn').hidden = running || done;
  $('retryBtn').hidden = running || !done || job.failures.length === 0;
  $('newBtn').hidden = running || !done;
}

// 取一条的完整信息：列表数据 +（可选）详情页
async function collectInfo(item) {
  if (!job.config.detail) return item;
  await doubanGap(DETAIL_GAP_MS + Math.random() * DETAIL_JITTER_MS);
  try {
    const { html, url } = await bg('doubanPage', { url: item.url });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const page = scrapeDouban(doc, url);
    return page.error ? item : mergeDetail(item, page);
  } catch (err) {
    if (err.code === 'DOUBAN_NOT_FOUND') return item; // 详情页没了，用列表里的信息
    throw err;
  }
}

async function run() {
  if (running) return;
  running = true;
  pauseRequested = false;
  job.phase = 'running';
  await saveJob();
  show('progress');
  $('blocked').hidden = true;
  renderProgress();

  let blockedTimes = 0;
  let noResponseTimes = 0;
  while (job.next < job.items.length && !pauseRequested) {
    const item = job.items[job.next];
    $('current').textContent = `正在处理：${item.title}`;
    try {
      const info = await collectInfo(item);
      const r = await bg('sync', { info });
      blockedTimes = 0;
      noResponseTimes = 0;
      if (r.updated) job.stats.updated++;
      else job.stats.created++;
      log(`${r.updated ? '已更新' : '已新增'}：${item.title}`, 'success');
    } catch (err) {
      if (err.code === 'DOUBAN_CHALLENGE') {
        // 验证页只能在浏览器里通过，等待没用：直接暂停，请用户打开这一条的豆瓣页面
        pauseRequested = true;
        $('blocked').hidden = false;
        $('blockedLink').href = item.url;
        $('blockedText').textContent =
          '豆瓣要求做一次安全验证，导入已暂停。请点下面的链接打开豆瓣，等页面正常显示（如有验证就按提示完成），再回来点「继续」。';
        log('已暂停：需要在豆瓣完成安全验证', 'error');
        break;
      }
      if (err.code === 'DOUBAN_BLOCKED') {
        if (blockedTimes < BLOCK_BACKOFF_MS.length) {
          const wait = BLOCK_BACKOFF_MS[blockedTimes++];
          $('blocked').hidden = false;
          $('blockedLink').href = item.url;
          $('blockedText').textContent = `豆瓣认为请求太频繁，${wait / 60000} 分钟后自动重试。`;
          log(`豆瓣拦下了请求，等待 ${wait / 60000} 分钟`, 'warn');
          await sleep(wait);
          $('blocked').hidden = true;
          continue; // 重试同一条
        }
        pauseRequested = true;
        $('blocked').hidden = false;
        $('blockedLink').href = item.url;
        $('blockedText').textContent = '豆瓣一直拒绝请求，导入已暂停。建议过半小时再点「继续」，或先打开豆瓣看看是否需要验证。';
        log('已暂停：需要在豆瓣完成安全验证', 'error');
        break;
      }
      if (err.code === 'NO_RESPONSE' && noResponseTimes++ < 3) {
        continue; // 后台脚本刚被浏览器回收，重试同一条
      }
      job.stats.failed++;
      job.failures.push({ info: item, error: err.message });
      log(`失败：${item.title}（${err.message}）`, 'error');
      // Token 失效、数据库无权限这类错误，后面的也一定失败，直接停
      if (/Token 无效|找不到这个数据库/.test(err.message)) {
        pauseRequested = true;
        job.next++;
        break;
      }
    }
    job.next++;
    await saveJob();
    renderProgress();
  }

  running = false;
  job.phase = job.next >= job.items.length ? 'done' : 'paused';
  await saveJob();
  $('current').textContent =
    job.phase === 'done'
      ? `完成：新增 ${job.stats.created} 条，更新 ${job.stats.updated} 条，失败 ${job.stats.failed} 条。`
      : '已暂停。';
  renderProgress();
}

async function retryFailures() {
  job.items = job.failures.map((f) => f.info);
  job.failures = [];
  job.next = 0;
  job.stats.failed = 0;
  await saveJob();
  run();
}

// ---------- 页面切换 ----------

function show(section) {
  for (const id of ['setup', 'review', 'progress']) $(id).hidden = id !== section;
  $('resume').hidden = true;
}

function fillForm(config) {
  $('uid').value = config.uid;
  for (const kind of ['book', 'movie']) {
    for (const box of document.querySelectorAll(`input[name="${kind}"]`)) box.checked = config.kinds[kind].includes(box.value);
  }
  document.querySelector(`input[name="detail"][value="${config.detail ? 'full' : 'fast'}"]`).checked = true;
  document.querySelector(`input[name="existing"][value="${config.onExisting}"]`).checked = true;
}

async function init() {
  $('scanBtn').addEventListener('click', scan);
  $('startBtn').addEventListener('click', run);
  $('backBtn').addEventListener('click', () => show('setup'));
  $('pauseBtn').addEventListener('click', () => {
    pauseRequested = true;
    $('pauseBtn').disabled = true;
    $('current').textContent = '处理完当前这条后暂停…';
  });
  $('continueBtn').addEventListener('click', () => {
    $('pauseBtn').disabled = false;
    run();
  });
  $('retryBtn').addEventListener('click', retryFailures);
  $('newBtn').addEventListener('click', async () => {
    const config = job.config;
    await clearJob();
    fillForm(config);
    show('setup');
  });
  $('resumeBtn').addEventListener('click', () => (job.phase === 'review' ? showReview() : run()));
  $('discardBtn').addEventListener('click', async () => {
    const config = job.config;
    await clearJob();
    fillForm(config);
    show('setup');
  });

  // 记住上次填的用户 ID
  const { lastImportUid } = await chrome.storage.local.get('lastImportUid');
  if (lastImportUid) $('uid').value = lastImportUid;
  $('uid').addEventListener('change', () => chrome.storage.local.set({ lastImportUid: $('uid').value.trim() }));

  const stored = (await chrome.storage.local.get(JOB_KEY))[JOB_KEY];
  if (stored && stored.phase !== 'done') {
    job = stored;
    fillForm(job.config);
    $('resumeText').textContent =
      job.phase === 'review'
        ? `上次读取了 ${job.items.length} 条待导入的标记，还没开始。`
        : `上次的导入还没完成：已处理 ${job.next} / ${job.items.length} 条。`;
    $('resume').hidden = false;
  } else if (stored) {
    fillForm(stored.config);
  }
}

init();
