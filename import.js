import { TYPE_ICONS, TYPE_LABELS, STATUS_LABELS } from './config.js';
import { infoFromInterest, mergeDetail, parseUserId, subjectKey } from './douban.js';
import { EMPTY_FILTERS, defaultSelection, filterItems, summarizeSelection, yearsOf } from './selection.js';
import { scrapeDouban } from './scraper.js';
import { collectSubjects, sourceLabel } from './collector.js';

// ---------- 节奏控制 ----------
// 实测约 1.5 秒一个详情页没有触发验证；这里取得更保守，并加随机抖动。
const LIST_GAP_MS = 1500; // 列表接口两次请求之间
const DETAIL_GAP_MS = 3000; // 详情页两次请求之间（再加 0~2 秒随机）
const DETAIL_JITTER_MS = 2000;
const BLOCK_BACKOFF_MS = [60 * 1000, 3 * 60 * 1000]; // 被拦后的等待时间，用完就暂停交给用户
const PAGE_SIZE = 50;
const HTML_PAGE_GAP_MS = 2000; // 列表页（豆列、标签……）两次请求之间
const PENDING_KEY = 'pendingPage'; // 弹窗交过来的“当前页面”数据
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

let mode = 'mine'; // mine：我的豆瓣标记；page：豆瓣上的列表
let preload = null; // 弹窗从当前页面读到的第一页（可能含“加载更多”后的条目）

function setMode(next) {
  mode = next;
  for (const tab of document.querySelectorAll('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
  $('mineFields').hidden = mode !== 'mine';
  $('pageFields').hidden = mode !== 'page';
  $('detailField').hidden = mode === 'page';
  $('pageDetailNote').hidden = mode !== 'page';
  scanStatus('');
}

function readConfig() {
  const checked = (name) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
  return {
    mode,
    uid: parseUserId($('uid').value),
    kinds: { book: checked('book'), movie: checked('movie') },
    // 列表页只有标题和评分，必须逐条抓详情页
    detail: mode === 'page' || checked('detail')[0] === 'full',
    pageUrl: $('pageUrl').value.trim(),
    maxPages: Number($('maxPages').value),
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

// 我的豆瓣标记：移动版接口
async function collectMine(config) {
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
  return { items, note: '' };
}

// 豆瓣上的列表：一页页读，顺着“后页”往下翻
async function collectPage(config) {
  const items = [];
  const seen = new Set();
  const add = (list) => {
    for (const item of list) {
      if (!seen.has(item.key)) {
        seen.add(item.key);
        items.push({ ...item });
      }
    }
  };
  const limit = config.maxPages || Infinity;
  let url = config.pageUrl;
  let pages = 0;
  let name = '';
  let totalPages = 1;
  let hasLoadMore = false;

  // 弹窗已经从页面上读到了第一页，就不用再请求一次
  if (preload && samePage(preload.url, config.pageUrl)) {
    add(preload.items);
    ({ name, totalPages, hasLoadMore } = preload);
    url = preload.next;
    pages = 1;
  }
  while (url && pages < limit) {
    await doubanGap(HTML_PAGE_GAP_MS);
    const { html, url: finalUrl } = await bg('doubanHtml', { url });
    const r = collectSubjects(new DOMParser().parseFromString(html, 'text/html'), finalUrl);
    if (!pages) ({ name, totalPages, hasLoadMore } = r);
    add(r.items);
    pages++;
    url = r.next;
    const of = Number.isFinite(limit) ? Math.min(totalPages, limit) : totalPages;
    scanStatus(`正在读取「${name}」：第 ${pages} / ${of} 页，${items.length} 条`);
    if (!r.items.length) break;
  }

  if (!items.length) {
    throw new Error(
      hasLoadMore || !pages
        ? '这个页面的内容是滚动加载的，插件直接读不到。请在浏览器里打开它，点几次「加载更多」，再点插件图标里的「批量导入这个页面」。'
        : '这个页面上没有找到图书或影视条目。',
    );
  }
  const source = sourceLabel(config.pageUrl, name);
  for (const item of items) item.source = source;

  let note = `从「${name}」读了 ${pages} 页`;
  if (url) note += `（共 ${totalPages} 页，还有没读的，可以返回把「最多读取」调大）`;
  if (hasLoadMore && !url) note += '（页面是滚动加载的，只包含你在页面上已经加载出来的条目）';
  return { items, note: `${note}。` };
}

function samePage(a, b) {
  const norm = (u) => String(u || '').replace(/#.*$/, '').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

function validate(config) {
  if (config.mode === 'mine') {
    if (!config.uid) return '请填写豆瓣个人主页链接或用户 ID。';
    if (!config.kinds.book.length && !config.kinds.movie.length) return '至少勾选一项要导入的内容。';
  } else if (!/^https?:\/\/(www|book|movie)\.douban\.com\//.test(config.pageUrl)) {
    return '请粘贴一个豆瓣列表页的链接（www / book / movie.douban.com）。';
  }
  return '';
}

async function scan() {
  const config = readConfig();
  const problem = validate(config);
  if (problem) return scanStatus(problem, 'error');

  const settings = await chrome.storage.local.get(['notionToken', 'parentPageId', 'bookDatabaseId', 'movieDatabaseId', 'tvDatabaseId']);
  if (!settings.notionToken) return scanStatus('还没有填写 Notion Token，请先到设置页完成设置。', 'error');
  if (!settings.parentPageId && !settings.bookDatabaseId && !settings.movieDatabaseId && !settings.tvDatabaseId) {
    return scanStatus('还没有选择 Notion 页面，请先到设置页填一个页面链接。', 'error');
  }

  $('scanBtn').disabled = true;
  try {
    // 1. 读豆瓣
    const { items, note } = config.mode === 'mine' ? await collectMine(config) : await collectPage(config);

    // 2. 查 Notion 里已有的条目，顺便看每类会写进哪个数据库
    scanStatus('正在检查 Notion 里已有的条目…');
    const needTypes = new Set();
    for (const i of items) {
      if (i.type === 'book') needTypes.add('book');
      else needTypes.add('movie').add('tv'); // 电影域名下的条目可能是剧集
    }
    const existing = new Set();
    const targets = {};
    for (const type of needTypes) {
      const r = await bg('listExisting', { type });
      targets[type] = r;
      r.keys.forEach((k) => existing.add(k));
    }
    for (const item of items) {
      item.key = subjectKey(item.url);
      item.exists = existing.has(item.key);
    }

    job = {
      config,
      phase: 'review',
      note,
      all: items, // 豆瓣上读到的全部条目
      selected: [...defaultSelection(items)], // 勾选的条目（subjectKey）
      filters: { ...EMPTY_FILTERS },
      items: [], // 开始导入时按勾选生成
      next: 0,
      stats: { created: 0, updated: 0, failed: 0 },
      failures: [],
      noDedupe: Object.entries(targets).filter(([, r]) => !r.canDedupe).map(([t]) => t),
      targets: Object.fromEntries(Object.entries(targets).map(([t, r]) => [t, { how: r.how, dbTitle: r.dbTitle, missing: r.missing }])),
      createdAt: Date.now(),
    };
    await saveJob();
    await chrome.storage.local.remove(PENDING_KEY);
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
    const c = readConfig();
    const where = c.mode === 'page' ? c.pageUrl : `https://m.douban.com/people/${c.uid}/`;
    return `豆瓣要求做一次安全验证。请在浏览器里打开 ${where} ，等页面正常显示后再点「读取列表」。`;
  }
  if (err.code === 'DOUBAN_BLOCKED') return '豆瓣认为请求太频繁，请过一会儿再试。';
  return err.message;
}

// ---------- 第二步：挑选 ----------

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

let selected = new Set();

// 勾选变化很频繁，存盘稍微攒一下
let saveTimer = null;
function saveSelectionSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    job.selected = [...selected];
    saveJob();
  }, 400);
}

function chip(group, value, label, checked) {
  const el = document.createElement('label');
  el.className = 'chip';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.value = value;
  box.checked = checked;
  box.addEventListener('change', () => {
    job.filters[group] = [...el.parentElement.querySelectorAll('input:checked')].map((i) => i.value);
    renderList();
    saveSelectionSoon();
  });
  el.append(box, label);
  return el;
}

function buildFilters() {
  const f = job.filters;
  const types = ['book', 'movie', 'tv'].filter((t) => job.all.some((i) => i.type === t));
  $('typeFilter').replaceChildren(...types.map((t) => chip('types', t, `${TYPE_ICONS[t]} ${TYPE_LABELS[t]}`, f.types.includes(t))));
  $('typeFilter').hidden = types.length < 2;

  const hasBook = job.all.some((i) => i.type === 'book');
  const hasScreen = job.all.some((i) => i.type !== 'book');
  const markLabel = (m) => {
    const b = STATUS_LABELS.book[m];
    const v = STATUS_LABELS.movie[m];
    return hasBook && hasScreen ? `${b}/${v}` : hasBook ? b : v;
  };
  const marks = ['mark', 'doing', 'done'].filter((m) => job.all.some((i) => i.mark === m));
  $('markFilter').replaceChildren(...marks.map((m) => chip('marks', m, markLabel(m), f.marks.includes(m))));
  $('markFilter').hidden = marks.length < 2;

  $('yearFilter').replaceChildren(
    new Option('全部年份', ''),
    ...yearsOf(job.all).map((y) => new Option(`${y} 年标记`, y)),
  );
  $('yearFilter').value = f.year;
  $('yearFilter').hidden = yearsOf(job.all).length === 0;
  $('ratingFilter').hidden = !job.all.some((i) => i.my_rating);
  $('ratingFilter').value = f.rating;
  $('showFilter').value = f.show;
  $('queryFilter').value = f.query;
}

function stars(n) {
  return n ? '★'.repeat(Number(n)) : '';
}

function itemRow(item) {
  const row = document.createElement('li');
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = selected.has(item.key);
  box.dataset.key = item.key;

  const body = document.createElement('span');
  body.className = 'item-body';
  const title = document.createElement('a');
  title.href = item.url;
  title.target = '_blank';
  title.rel = 'noopener';
  title.textContent = item.title;
  title.addEventListener('click', (e) => e.stopPropagation());
  const meta = document.createElement('span');
  meta.className = 'muted item-meta';
  meta.textContent = [
    item.typeGuess ? '🎬 影视' : `${TYPE_ICONS[item.type]} ${TYPE_LABELS[item.type]}`,
    item.status,
    stars(item.my_rating),
    !item.my_rating && item.rating ? `豆瓣 ${item.rating}` : '',
    item.marked_date,
    item.author || item.director,
  ]
    .filter(Boolean)
    .join(' · ');
  body.append(title, meta);

  label.append(box, body);
  if (item.exists) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '已在 Notion';
    badge.title = '勾选后会用豆瓣的最新信息更新它';
    label.append(badge);
  }
  row.append(label);
  return row;
}

function visibleItems() {
  return filterItems(job.all, job.filters);
}

function renderList() {
  const items = visibleItems();
  const frag = document.createDocumentFragment();
  for (const item of items) frag.append(itemRow(item));
  $('itemList').replaceChildren(frag);
  $('visibleCount').textContent =
    items.length === job.all.length ? `共 ${items.length} 条` : `筛选出 ${items.length} / ${job.all.length} 条`;
  if (!items.length) $('itemList').append(li('没有符合条件的条目'));
  renderSelection();
}

function renderSelection() {
  const { total, toCreate, toUpdate } = summarizeSelection(job.all, selected);
  const parts = [];
  if (toCreate) parts.push(`新增 ${toCreate}`);
  if (toUpdate) parts.push(`更新 ${toUpdate}`);
  $('selectionText').textContent = total
    ? `已选 ${total} 条（${parts.join('，')}），${minutes(total)}`
    : '还没有选择条目';
  $('startBtn').disabled = total === 0;

  // 每类条目会写进哪个数据库（只说选中的类型）
  const used = new Set(job.all.filter((i) => selected.has(i.key)).map((i) => i.type));
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
}

function setVisible(checked) {
  for (const item of visibleItems()) {
    if (checked) selected.add(item.key);
    else selected.delete(item.key);
  }
  for (const box of $('itemList').querySelectorAll('input[type=checkbox]')) box.checked = checked;
  renderSelection();
  saveSelectionSoon();
}

function showReview() {
  show('review');
  selected = new Set(job.selected || []);
  job.filters = { ...EMPTY_FILTERS, ...(job.filters || {}) };

  const existing = job.all.filter((i) => i.exists).length;
  const what = job.config.mode === 'page' ? '个条目' : '条标记';
  const lines = [];
  if (job.note) lines.push(job.note);
  lines.push(`共读到 ${job.all.length} ${what}${existing ? `，其中 ${existing} 条已经在 Notion 里` : ''}。`);
  lines.push('默认勾选了所有还没导入的。勾选「已在 Notion」的条目，会用豆瓣的最新信息更新它。');
  if (job.config.mode === 'page') lines.push(`导入后会在「来源」字段记上「${job.all[0]?.source}」。`);
  for (const t of job.noDedupe) {
    lines.push(`⚠ ${TYPE_LABELS[t]}数据库的「链接」字段不是网址类型，无法判断是否重复。`);
  }
  $('summary').replaceChildren(...lines.map(li));

  buildFilters();
  renderList();
}

async function startImport() {
  clearTimeout(saveTimer);
  job.selected = [...selected];
  job.items = job.all.filter((i) => selected.has(i.key));
  job.next = 0;
  job.stats = { created: 0, updated: 0, failed: 0 };
  job.failures = [];
  await saveJob();
  run();
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
  setMode(config.mode || 'mine');
  $('uid').value = config.uid || '';
  for (const kind of ['book', 'movie']) {
    for (const box of document.querySelectorAll(`input[name="${kind}"]`)) box.checked = (config.kinds?.[kind] || []).includes(box.value);
  }
  document.querySelector(`input[name="detail"][value="${config.detail ? 'full' : 'fast'}"]`).checked = true;
  $('pageUrl').value = config.pageUrl || '';
  if (config.maxPages !== undefined) $('maxPages').value = String(config.maxPages);
}

// 弹窗点了“批量导入这个页面”：切到列表模式，带上已经读到的第一页
async function takePendingPage() {
  const pending = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY];
  if (!pending || Date.now() - pending.at > 30 * 60 * 1000) return false;
  preload = pending;
  setMode('page');
  $('pageUrl').value = pending.url;
  $('preloadNote').textContent =
    `已从页面「${pending.name}」读到 ${pending.items.length} 个条目` +
    (pending.next ? `（共 ${pending.totalPages} 页）。` : '。') +
    '选好要读几页，点「读取列表」。';
  $('preloadNote').hidden = false;
  if (!pending.next) $('maxPages').value = '1';
  return true;
}

async function init() {
  for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => setMode(tab.dataset.mode));
  $('pageUrl').addEventListener('input', () => {
    $('preloadNote').hidden = !preload || !samePage(preload.url, $('pageUrl').value.trim());
  });
  $('scanBtn').addEventListener('click', scan);
  $('startBtn').addEventListener('click', startImport);
  $('selectVisible').addEventListener('click', () => setVisible(true));
  $('clearVisible').addEventListener('click', () => setVisible(false));
  $('itemList').addEventListener('change', (e) => {
    const key = e.target.dataset?.key;
    if (!key) return;
    if (e.target.checked) selected.add(key);
    else selected.delete(key);
    renderSelection();
    saveSelectionSoon();
  });
  for (const [id, field] of [['yearFilter', 'year'], ['ratingFilter', 'rating'], ['showFilter', 'show']]) {
    $(id).addEventListener('change', () => {
      job.filters[field] = $(id).value;
      renderList();
      saveSelectionSoon();
    });
  }
  let queryTimer = null;
  $('queryFilter').addEventListener('input', () => {
    clearTimeout(queryTimer);
    queryTimer = setTimeout(() => {
      job.filters.query = $('queryFilter').value;
      renderList();
    }, 150);
  });
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
    if (!preload) fillForm(config); // 从弹窗带过来的页面优先
    show('setup');
  });

  // 记住上次填的用户 ID
  const { lastImportUid } = await chrome.storage.local.get('lastImportUid');
  if (lastImportUid) $('uid').value = lastImportUid;
  $('uid').addEventListener('change', () => chrome.storage.local.set({ lastImportUid: $('uid').value.trim() }));

  const stored = (await chrome.storage.local.get(JOB_KEY))[JOB_KEY];
  const fromPopup = await takePendingPage();
  if (stored && stored.phase !== 'done') {
    job = stored;
    // 旧版本存下的任务没有完整列表：把待导入的条目当作全部，并全部勾上
    if (!job.all) {
      job.all = job.items.map((i) => ({ ...i, key: subjectKey(i.url), exists: false }));
      job.selected = job.all.map((i) => i.key);
    }
    if (!fromPopup) fillForm(job.config);
    $('resumeText').textContent =
      job.phase === 'review'
        ? `上次读取了 ${job.all.length} 条标记，还没开始导入。`
        : `上次的导入还没完成：已处理 ${job.next} / ${job.items.length} 条。`;
    $('resume').hidden = false;
  } else if (stored && !fromPopup) {
    fillForm(stored.config);
  }
}

init();
