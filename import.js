import { TYPE_ICONS, TYPE_LABELS, STATUS_LABELS } from './config.js';
import { infoFromInterest, mergeDetail, parseUserId, subjectKey } from './douban.js';
import {
  EMPTY_FILTERS,
  defaultSelection,
  filterItems,
  rangeBetween,
  sortItems,
  summarizeSelection,
  yearsOf,
} from './selection.js';
import { scrapeDouban } from './scraper.js';
import { collectNotes, collectSubjects, parseNote, sourceLabel } from './collector.js';
import { openMappingDialog } from './mapping.js';
import { icon } from './icons.js';
import { fieldForError, missingFrom, onSettingsChange, setupCallout } from './setup.js';

// ---------- 节奏控制 ----------
// 实测约 1.5 秒一个详情页没有触发验证；这里取得更保守，并加随机抖动。
const LIST_GAP_MS = 1500; // 列表接口两次请求之间
const DETAIL_GAP_MS = 3000; // 详情页两次请求之间（再加 0~2 秒随机）
const DETAIL_JITTER_MS = 2000;
const BLOCK_BACKOFF_MS = [60 * 1000, 3 * 60 * 1000]; // 被拦后的等待时间，用完就暂停交给用户
const PAGE_SIZE = 50;
const HTML_PAGE_GAP_MS = 2000; // 列表页（豆列、标签……）两次请求之间
const PENDING_KEY = 'pendingPage'; // 弹窗交过来的“当前页面”数据
const MEMORY_KEY = 'targetMemory'; // 每个来源上次选的数据库
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
  job.heartbeat = Date.now(); // 让自动同步知道批量导入还在进行
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
    writings: mode === 'mine' && $('withWritings').checked,
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
  let note = '';
  if (config.writings) note = await attachWritings(config, items);
  return { items, note };
}

// 读我写的书评 / 影评和读书笔记，挂到对应的条目上（全文在导入时再逐篇读）
async function attachWritings(config, items) {
  const byKey = new Map(items.map((i) => [subjectKey(i.url), i]));
  const add = (w) => {
    const item = byKey.get(subjectKey(w.subjectUrl));
    if (!item) return false; // 写了评论但没标记过的条目，不单独导入
    item.writings = item.writings || [];
    if (item.writings.some((x) => x.url === w.url)) return false; // 同一条在列表页和单本书的笔记页都出现
    item.writings.push(w);
    return true;
  };
  let reviews = 0;
  let notes = 0;

  for (const kind of ['book', 'movie']) {
    if (!config.kinds[kind].length) continue;
    for (let start = 0, total = Infinity; start < total; start += PAGE_SIZE) {
      await doubanGap(LIST_GAP_MS);
      const page = await bg('doubanReviews', { uid: config.uid, kind, start, count: PAGE_SIZE });
      total = page.total;
      for (const r of page.reviews) if (add(r)) reviews++;
      scanStatus(`正在读取你写的${kind === 'book' ? '书评' : '影评'}：${Math.min(start + PAGE_SIZE, total)} / ${total}`);
      if (!page.reviews.length) break;
    }
  }

  if (config.kinds.book.length) {
    const seenBooks = new Set();
    let url = `https://book.douban.com/people/${encodeURIComponent(config.uid)}/annotation/`;
    const extra = []; // 笔记多、列表里没显示全的书
    while (url) {
      await doubanGap(HTML_PAGE_GAP_MS);
      const { html, url: finalUrl } = await bg('doubanHtml', { url });
      const r = collectNotes(new DOMParser().parseFromString(html, 'text/html'), finalUrl);
      for (const book of r.books) {
        seenBooks.add(book.sid);
        for (const n of book.notes) if (add(n)) notes++;
        if (book.count > book.notes.length && book.moreUrl) extra.push(book.moreUrl);
      }
      scanStatus(`正在读取你的读书笔记：已找到 ${notes} 条`);
      url = r.next;
    }
    for (let more of extra) {
      while (more) {
        await doubanGap(HTML_PAGE_GAP_MS);
        const { html, url: finalUrl } = await bg('doubanHtml', { url: more });
        const r = collectNotes(new DOMParser().parseFromString(html, 'text/html'), finalUrl);
        for (const book of r.books) for (const n of book.notes) if (add(n)) notes++;
        more = r.next;
      }
    }
  }
  if (!reviews && !notes) return '没有找到你写的书评 / 影评或读书笔记（只能读到公开的）。';
  return `另外找到你写的 ${reviews} 篇评论、${notes} 条读书笔记，会放进对应条目的页面正文。`;
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
  const missing = missingFrom(settings);
  if (missing) return showSetup($('setupBox'), missing, scan, '继续读取列表');
  hideSetup($('setupBox'));

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
    const targets = {};
    const existingKeys = {};
    for (const type of needTypes) {
      const r = await bg('listExisting', { type });
      targets[type] = r;
      existingKeys[type] = r.keys;
    }
    for (const item of items) {
      item.key = subjectKey(item.url);
      item.exists = typesOf(item).some((t) => (existingKeys[t] || []).includes(item.key));
    }
    const memory = (await chrome.storage.local.get(MEMORY_KEY))[MEMORY_KEY] || {};

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
      // 默认库的情况（用于“默认”选项的名字）
      targets: Object.fromEntries(Object.entries(targets).map(([t, r]) => [t, { how: r.how, dbTitle: r.dbTitle, missing: r.missing }])),
      // 用户为每种类型选的库；先用这个来源上次的选择
      choice: memory[sourceKey(config)] || {},
      existingKeys,
      targetInfo: Object.fromEntries(
        Object.entries(targets).map(([t, r]) => [t, { how: r.how, dbTitle: r.dbTitle, missing: r.missing, count: r.keys.length, databaseId: r.databaseId }]),
      ),
      createdAt: Date.now(),
    };
    await saveJob();
    await chrome.storage.local.remove(PENDING_KEY);
    scanStatus('');
    showReview();
  } catch (err) {
    const field = fieldForError(err.message);
    if (field) {
      scanStatus('');
      showSetup($('setupBox'), field, scan, '继续读取列表', err.message);
    } else {
      scanStatus(scanError(err), 'error');
    }
  } finally {
    $('scanBtn').disabled = false;
  }
}

// ---------- 还没设置好：直接带去设置页 ----------

let myTabId = null;
chrome.tabs?.getCurrent?.().then((t) => (myTabId = t?.id ?? null));

// 显示“还差一步”；设置改好后自动变成“设置好了 + 继续”按钮
function showSetup(box, field, resume, resumeLabel, message = '') {
  box.replaceChildren(setupCallout(field, { from: '批量导入', returnTabId: myTabId, message }));
  box.hidden = false;
  box.dataset.waiting = field;
  box._resume = resume;
  box._resumeLabel = resumeLabel;
}

function hideSetup(box) {
  box.hidden = true;
  delete box.dataset.waiting;
}

async function recheckSetup() {
  const settings = await chrome.storage.local.get(['notionToken', 'parentPageId', 'bookDatabaseId', 'movieDatabaseId', 'tvDatabaseId']);
  for (const box of [$('setupBox'), $('runSetupBox')]) {
    if (!box.dataset.waiting) continue;
    // 只有“缺 Token / 缺页面”能这样直接判断；Token 无效这类，等用户改了设置就让他再试一次
    if (missingFrom(settings)) continue;
    delete box.dataset.waiting;
    const done = document.createElement('div');
    done.className = 'setup-callout ok';
    const text = document.createElement('p');
    text.textContent = '✓ 设置好了。';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary';
    btn.textContent = box._resumeLabel;
    btn.addEventListener('click', () => {
      hideSetup(box);
      box._resume();
    });
    done.append(text, btn);
    box.replaceChildren(done);
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

function minutes(n, writings = 0) {
  const perItem = job.config.detail ? 5 : 1.2; // 秒，包含写 Notion 的时间
  const m = Math.ceil((n * perItem + writings * 4.5) / 60);
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
  $('sortBy').value = f.sort || '';
  // 从列表页导入的条目没有“我的”标记，这两种排序没意义
  const hasMine = job.all.some((i) => i.marked_date);
  for (const v of ['marked', 'mine']) $('sortBy').querySelector(`option[value="${v}"]`).hidden = !hasMine;
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

  const thumb = document.createElement('img');
  thumb.className = 'thumb';
  thumb.alt = '';
  thumb.loading = 'lazy';
  thumb.onerror = () => thumb.classList.add('broken');
  if (item.cover) thumb.src = thumbUrl(item.cover);
  else thumb.classList.add('broken');

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

  label.append(box, thumb, body);
  if (item.writings?.length) {
    const w = document.createElement('span');
    w.className = 'badge writing';
    w.textContent = `📝 ${item.writings.length}`;
    w.title = '会把你写的评论 / 笔记一起放进页面';
    label.append(w);
  }
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

// 列表里用小图就够了
function thumbUrl(url) {
  return url.replace(/\/[lm]_ratio_poster\//, '/s_ratio_poster/').replace(/\/subject\/[lm]\//, '/subject/s/');
}

let shownOrder = []; // 当前列表的显示顺序，Shift 连选用
let lastClicked = null;

function visibleItems() {
  return filterItems(job.all, job.filters);
}

function renderList() {
  const items = sortItems(visibleItems(), job.filters.sort);
  shownOrder = items;
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
  const writings = job.all.filter((i) => selected.has(i.key)).reduce((n, i) => n + (i.writings?.length || 0), 0);
  if (writings) parts.push(`含 ${writings} 篇评论 / 笔记`);
  $('selectionText').textContent = total
    ? `已选 ${total} 条（${parts.join('，')}），${minutes(total, writings)}`
    : '还没有选择条目';
  $('startBtn').disabled = total === 0;
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
  job.choice = job.choice || {};
  job.targetInfo = job.targetInfo || {};
  job.existingKeys = job.existingKeys || {};
  renderTargets();
  loadDbList().then(renderTargets);
  // 上次为这个来源选过别的库：按那个库重新判断“已在 Notion”
  for (const type of neededTypes()) {
    const c = job.choice[type];
    if (c && c.kind !== 'default' && !(type === 'tv' && c.kind === 'same' && !job.choice.movie)) refreshTarget(type);
  }
}

// ---------- 写进哪个数据库 ----------

let dbList = null; // 插件能访问的数据库

async function loadDbList() {
  if (dbList) return dbList;
  try {
    dbList = await bg('listDatabases');
  } catch {
    dbList = [];
  }
  return dbList;
}

// 一个条目可能写进的类型：从列表页来的影视还分不清电影/剧集，两个都算
function typesOf(item) {
  if (item.type === 'book') return ['book'];
  return item.typeGuess ? ['movie', 'tv'] : [item.type];
}

function neededTypes() {
  const set = new Set(job.all.flatMap(typesOf));
  return ['book', 'movie', 'tv'].filter((t) => set.has(t));
}

function choiceOf(type) {
  return job.choice?.[type] || { kind: 'default' };
}

// “和电影用同一个库”展开成电影的选择
function effectiveChoice(type) {
  const c = choiceOf(type);
  return c.kind === 'same' ? choiceOf('movie') : c;
}

function sourceKey(config) {
  if (config.mode === 'mine') return `mine:${config.uid}`;
  try {
    const u = new URL(config.pageUrl);
    return `page:${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return `page:${config.pageUrl}`;
  }
}

function suggestedTitle(type) {
  const source = job.all.find((i) => i.source)?.source;
  if (source) return type === 'tv' && job.choice?.movie ? `${source}（剧集）` : source;
  return `豆瓣${TYPE_LABELS[type]}`;
}

function targetNote(type) {
  const c = choiceOf(type);
  if (c.kind === 'same') return { text: '和电影写进同一个库（会补上剧集特有的字段）。' };
  const info = job.targetInfo?.[type];
  if (!info) return { text: '' };
  if (info.loading) return { text: '正在检查…' };
  if (info.error) return { text: info.error, kind: 'error' };
  if (c.kind === 'new' || info.how === 'create') {
    return { text: `开始导入时会新建「${c.kind === 'new' ? c.title || suggestedTitle(type) : info.dbTitle}」。` };
  }
  const parts = [`「${info.dbTitle || c.title || '这个库'}」里已有 ${info.count || 0} 条`];
  if (info.missing?.length) {
    const list = info.missing.length > 5 ? `${info.missing.slice(0, 5).join('、')} 等 ${info.missing.length} 个` : info.missing.join('、');
    parts.push(`会补上 ${list} 字段`);
  }
  return { text: `${parts.join('，')}。` };
}

function targetRow(type) {
  const c = choiceOf(type);
  const row = document.createElement('div');
  row.className = 'target-row';

  const label = document.createElement('span');
  label.className = 'target-label';
  label.textContent = `${TYPE_ICONS[type]} ${TYPE_LABELS[type]}`;

  const select = document.createElement('select');
  select.setAttribute('aria-label', `${TYPE_LABELS[type]}写进哪个数据库`);
  const defaultName = job.targets?.[type]?.dbTitle;
  select.append(new Option(`默认：${defaultName ? `「${defaultName}」` : '按设置自动选'}`, 'default'));
  if (type === 'tv' && neededTypes().includes('movie')) select.append(new Option('和电影用同一个库', 'same'));
  select.append(new Option('新建一个数据库…', 'new'));
  const group = document.createElement('optgroup');
  group.label = '已有的数据库';
  if (!dbList) group.append(Object.assign(new Option('正在读取…', ''), { disabled: true }));
  else if (!dbList.length) group.append(Object.assign(new Option('（插件还没有可以访问的数据库）', ''), { disabled: true }));
  for (const db of dbList || []) group.append(new Option(`${db.icon || '🗂'} ${db.title}`, `db:${db.id}`));
  select.append(group);
  select.value = c.kind === 'existing' ? `db:${c.databaseId}` : c.kind;
  // 记住的库已经不在列表里（被删了或断开了连接）
  if (c.kind === 'existing' && select.value !== `db:${c.databaseId}`) {
    select.append(new Option(`🗂 ${c.title || '之前选的库'}`, `db:${c.databaseId}`));
    select.value = `db:${c.databaseId}`;
  }
  select.addEventListener('change', () => onTargetChange(type, select.value));

  row.append(label, select);

  if (c.kind === 'new') {
    const name = document.createElement('input');
    name.type = 'text';
    name.value = c.title ?? suggestedTitle(type);
    name.placeholder = '新数据库的名字';
    name.setAttribute('aria-label', '新数据库的名字');
    name.addEventListener('input', () => {
      c.title = name.value;
      row.querySelector('.target-note').textContent = targetNote(type).text;
      saveSelectionSoon();
    });
    if (c.title === undefined) c.title = name.value;
    row.append(name);
  }

  const note = document.createElement('p');
  const { text, kind } = targetNote(type);
  note.className = `target-note muted small-text ${kind || ''}`;
  note.textContent = text;
  // 库已经存在：可以调整字段对应（剧集和电影共用时在电影那一行调）
  const dbId = job.targetInfo?.[type]?.databaseId;
  if (dbId && c.kind !== 'same' && c.kind !== 'new' && !job.targetInfo[type].loading) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-btn';
    b.append(icon('arrow-left-right', 13), '字段对应');
    b.title = '调整这个数据库的每一列放豆瓣的哪项信息';
    b.addEventListener('click', () => editMapping(type, dbId));
    note.append(' ', b);
  }
  row.append(note);
  return row;
}

function renderTargets() {
  $('targetRows').replaceChildren(...neededTypes().map(targetRow));
}

function onTargetChange(type, value) {
  const prev = choiceOf(type);
  let next;
  if (value === 'default' || value === 'same') next = { kind: value };
  else if (value === 'new') next = { kind: 'new', title: undefined };
  else {
    const id = value.slice(3);
    next = { kind: 'existing', databaseId: id, title: dbList?.find((d) => d.id === id)?.title || '' };
  }
  job.choice[type] = next;
  const pickedExisting = next.kind === 'existing';
  // 电影换了库、剧集还在默认库：多半是想放在一起
  if (type === 'movie' && next.kind !== 'default' && choiceOf('tv').kind === 'default' && neededTypes().includes('tv')) {
    job.choice.tv = { kind: 'same' };
  }
  if (type === 'movie' && next.kind === 'default' && prev.kind !== 'default' && choiceOf('tv').kind === 'same') {
    job.choice.tv = { kind: 'default' };
  }
  refreshTarget(type).then(() => pickedExisting && offerMapping(type));
}

async function editMapping(type, databaseId) {
  if (await openMappingDialog({ databaseId, type })) refreshTarget(type);
}

// 选了一个已有的库、而且还没设过字段对应：直接弹出来让用户对一下
async function offerMapping(type) {
  const info = job.targetInfo?.[type];
  if (!info?.databaseId || info.error) return;
  const { fieldMaps = {} } = await chrome.storage.local.get('fieldMaps');
  const id = info.databaseId.replace(/-/g, '');
  const known = Object.keys(fieldMaps).some((k) => k.replace(/-/g, '') === id);
  if (!known) editMapping(type, info.databaseId);
}

// 换了库之后，重新判断哪些条目已经在这个库里
async function refreshTarget(type) {
  const types = [type];
  if (type === 'movie' && neededTypes().includes('tv')) types.push('tv');
  for (const t of types) job.targetInfo[t] = { loading: true };
  renderTargets();
  await Promise.all(
    types.map(async (t) => {
      const target = effectiveChoice(t);
      if (target.kind === 'new') {
        job.existingKeys[t] = [];
        job.targetInfo[t] = { how: 'create', dbTitle: target.title || suggestedTitle(t), missing: [], count: 0 };
        return;
      }
      try {
        const r = await bg('listExisting', { type: t, target });
        job.existingKeys[t] = r.keys;
        job.targetInfo[t] = { how: r.how, dbTitle: r.dbTitle, missing: r.missing, count: r.keys.length, databaseId: r.databaseId };
      } catch (err) {
        job.existingKeys[t] = [];
        job.targetInfo[t] = { error: err.message };
      }
    }),
  );
  applyExisting();
  renderTargets();
  renderList();
  saveSelectionSoon();
}

// 按当前选的库更新“已在 Notion”标记；只改状态变了的条目的勾选，其余保持用户的选择
function applyExisting() {
  const sets = Object.fromEntries(['book', 'movie', 'tv'].map((t) => [t, new Set(job.existingKeys[t] || [])]));
  for (const item of job.all) {
    const now = typesOf(item).some((t) => sets[t].has(item.key));
    if (now === item.exists) continue;
    item.exists = now;
    if (now) selected.delete(item.key);
    else selected.add(item.key);
  }
}

// 开始前：把要新建的库建好、已有库补好字段，之后每条直接写入
async function prepareTargets(types) {
  const resolved = {};
  const order = ['book', 'movie', 'tv'];
  // 剧集和电影共用时，要先确定电影的库
  const need = new Set(types);
  if (need.has('tv') && choiceOf('tv').kind === 'same') need.add('movie');
  for (const t of order.filter((x) => need.has(x))) {
    $('startBtn').textContent = `正在准备${TYPE_LABELS[t]}数据库…`;
    const target = t === 'tv' && choiceOf('tv').kind === 'same' ? { kind: 'existing', databaseId: resolved.movie.databaseId } : effectiveChoice(t);
    const r = await bg('prepareTarget', { type: t, target });
    resolved[t] = { kind: 'existing', databaseId: r.databaseId, title: r.dbTitle };
  }
  return resolved;
}

// 记住这个来源的选择；新建的库记成“已有库”，下次直接写进去
async function rememberChoice(resolved) {
  const memory = (await chrome.storage.local.get(MEMORY_KEY))[MEMORY_KEY] || {};
  const choice = {};
  for (const t of ['book', 'movie', 'tv']) {
    const c = choiceOf(t);
    if (c.kind === 'default' || c.kind === 'same') choice[t] = { kind: c.kind };
    else if (resolved[t]) choice[t] = resolved[t];
  }
  const key = sourceKey(job.config);
  delete memory[key];
  memory[key] = choice;
  // 只留最近 50 个来源
  const keys = Object.keys(memory);
  for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete memory[k];
  await chrome.storage.local.set({ [MEMORY_KEY]: memory });
}

async function startImport() {
  clearTimeout(saveTimer);
  job.selected = [...selected];
  job.items = job.all.filter((i) => selected.has(i.key));
  $('startError').hidden = true;
  $('startBtn').disabled = true;
  try {
    const types = [...new Set(job.items.flatMap(typesOf))];
    job.resolved = await prepareTargets(types);
    await rememberChoice(job.resolved);
  } catch (err) {
    $('startError').textContent = `没能准备好数据库：${err.message}`;
    $('startError').hidden = false;
    $('startBtn').textContent = '开始导入';
    $('startBtn').disabled = false;
    return;
  }
  $('startBtn').textContent = '开始导入';
  $('startBtn').disabled = false;
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
  const done = next >= items.length;
  $('bar').style.width = `${items.length ? (next / items.length) * 100 : 100}%`;
  $('statDone').textContent = `${next} / ${items.length}`;
  $('statCreated').textContent = stats.created;
  $('statUpdated').textContent = stats.updated;
  $('statFailed').textContent = stats.failed;
  const leftWritings = items.slice(next).reduce((n, i) => n + (i.writings?.length || 0), 0);
  $('statLeft').textContent = done ? '—' : minutes(items.length - next, leftWritings).replace('约 ', '');

  // 切到别的标签页时，从标签页标题就能看到进度
  $('progressTitle').textContent = running ? '3. 导入中' : done ? '3. 导入完成' : '3. 已暂停';
  document.title = running
    ? `(${next}/${items.length}) 导入中 · 豆瓣同步到 Notion`
    : done
      ? '✓ 导入完成 · 豆瓣同步到 Notion'
      : '已暂停 · 豆瓣同步到 Notion';
  $('progressHint').hidden = done;
  renderDone(done);

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

  $('pauseBtn').hidden = !running;
  $('continueBtn').hidden = running || done;
  $('retryBtn').hidden = running || !done || job.failures.length === 0;
  $('newBtn').hidden = running || !done;
}

// 取一条的完整信息：列表数据 +（可选）详情页
// 逐篇读书评 / 笔记的全文
async function collectWritings(item) {
  const out = [];
  for (const w of item.writings || []) {
    await doubanGap(DETAIL_GAP_MS + Math.random() * DETAIL_JITTER_MS);
    try {
      if (w.kind === 'review') {
        const r = await bg('doubanReviewContent', { id: w.id });
        out.push({ ...w, html: r.html, title: r.title || w.title, date: r.date || w.date });
      } else {
        const { html, url } = await bg('doubanHtml', { url: w.url });
        const n = parseNote(new DOMParser().parseFromString(html, 'text/html'));
        out.push({ ...w, url, html: n.html, title: n.title || w.title, date: n.date });
      }
    } catch (err) {
      if (err.code === 'DOUBAN_NOT_FOUND') continue; // 删掉了就跳过
      throw err;
    }
  }
  return out;
}

async function collectInfo(item) {
  const info = await collectDetail(item);
  if (item.writings?.length) info.writings = await collectWritings(item);
  return info;
}

async function collectDetail(item) {
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

// 完成后：一句话总结 + 直接打开用到的 Notion 数据库
function renderDone(done) {
  $('doneBox').hidden = !done;
  if (!done) return;
  const { created, updated, failed } = job.stats;
  const parts = [`新增 ${created} 条`];
  if (updated) parts.push(`更新 ${updated} 条`);
  if (failed) parts.push(`${failed} 条失败，可以点下面的按钮重试`);
  $('doneText').textContent = `✓ 全部处理完了：${parts.join('，')}。`;
  $('dbLinks').replaceChildren(
    ...Object.entries(job.dbLinks || {}).map(([title, url]) => {
      const a = document.createElement('a');
      a.className = 'secondary as-button';
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `打开「${title}」↗`;
      return a;
    }),
  );
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
      const r = await bg('sync', { info, target: job.resolved?.[info.type] });
      blockedTimes = 0;
      noResponseTimes = 0;
      if (r.updated) job.stats.updated++;
      else job.stats.created++;
      if (r.dbUrl) job.dbLinks = { ...(job.dbLinks || {}), [r.dbTitle]: r.dbUrl };
      const extra = r.writingsAdded ? `（放进了 ${r.writingsAdded} 篇评论 / 笔记）` : '';
      log(`${r.updated ? '已更新' : '已新增'}：${item.title}${extra}`, 'success');
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
      const field = fieldForError(err.message);
      if (field) {
        // 这条算失败，暂停，带用户去设置；设置好之后从下一条继续
        pauseRequested = true;
        job.next++;
        showSetup($('runSetupBox'), field, () => run(), '继续导入', err.message);
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
  $('current').textContent = job.phase === 'done' ? '' : '已暂停。点「继续」接着导。';
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

const STEPS = ['setup', 'review', 'progress'];

function markStep(section) {
  const cur = STEPS.indexOf(section);
  for (const el of document.querySelectorAll('#steps li')) {
    const i = STEPS.indexOf(el.dataset.step);
    el.className = cur < 0 ? '' : i < cur ? 'done' : i === cur ? 'current' : '';
    if (i === cur) el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
  }
}

function show(section) {
  for (const id of STEPS) $(id).hidden = id !== section;
  $('resume').hidden = true;
  markStep(section);
  if (section !== 'progress') document.title = '批量导入 · 豆瓣同步到 Notion';
}

// 有没做完的导入时，只显示“继续”卡片，不把表单也摆出来
function showResume() {
  for (const id of STEPS) $(id).hidden = true;
  $('resume').hidden = false;
  markStep(null);
}

function fillForm(config) {
  setMode(config.mode || 'mine');
  $('uid').value = config.uid || '';
  for (const kind of ['book', 'movie']) {
    for (const box of document.querySelectorAll(`input[name="${kind}"]`)) box.checked = (config.kinds?.[kind] || []).includes(box.value);
  }
  document.querySelector(`input[name="detail"][value="${config.detail ? 'full' : 'fast'}"]`).checked = true;
  $('withWritings').checked = !!config.writings;
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

// 识别当前登录的豆瓣账号，省得用户自己找主页链接
async function detectMe(byUser) {
  $('useMe').disabled = true;
  if (byUser) $('meHint').textContent = '正在识别…';
  try {
    const { uid, name } = await bg('doubanMe');
    if (uid) {
      $('uid').value = uid;
      chrome.storage.local.set({ lastImportUid: uid });
      $('meHint').textContent = `✓ 已识别当前登录的豆瓣账号${name ? `「${name}」` : ''}。会连同你的状态、评分、短评一起导入。`;
    } else if (byUser) {
      $('meHint').textContent = '没有检测到登录的豆瓣账号。请先在浏览器里登录豆瓣，或者直接粘贴个人主页链接。';
    }
  } catch (err) {
    if (byUser) $('meHint').textContent = `识别失败：${err.message}`;
  } finally {
    $('useMe').disabled = false;
  }
}

async function init() {
  onSettingsChange(recheckSetup);
  for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => setMode(tab.dataset.mode));
  $('pageUrl').addEventListener('input', () => {
    $('preloadNote').hidden = !preload || !samePage(preload.url, $('pageUrl').value.trim());
  });
  $('scanBtn').addEventListener('click', scan);
  $('startBtn').addEventListener('click', startImport);
  $('selectVisible').addEventListener('click', () => setVisible(true));
  $('clearVisible').addEventListener('click', () => setVisible(false));
  // Shift + 点击：把上次点的和这次点的之间全部设成同样的勾选状态
  $('itemList').addEventListener('click', (e) => {
    const box = e.target.closest('input[type=checkbox]');
    if (!box) return;
    const key = box.dataset.key;
    if (e.shiftKey && lastClicked && lastClicked !== key) {
      const keys = new Set(rangeBetween(shownOrder, lastClicked, key).map((i) => i.key));
      for (const k of keys) {
        if (box.checked) selected.add(k);
        else selected.delete(k);
      }
      for (const other of $('itemList').querySelectorAll('input[type=checkbox]')) {
        if (keys.has(other.dataset.key)) other.checked = box.checked;
      }
      renderSelection();
      saveSelectionSoon();
    }
    lastClicked = key;
  });
  $('sortBy').addEventListener('change', () => {
    job.filters.sort = $('sortBy').value;
    renderList();
    saveSelectionSoon();
  });
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

  $('useMe').addEventListener('click', () => detectMe(true));

  // 记住上次填的用户 ID
  const { lastImportUid } = await chrome.storage.local.get('lastImportUid');
  if (lastImportUid) $('uid').value = lastImportUid;
  else detectMe(false); // 没填过就自动识别一次
  $('uid').addEventListener('change', () => chrome.storage.local.set({ lastImportUid: $('uid').value.trim() }));

  markStep('setup');
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
    showResume();
  } else if (stored && !fromPopup) {
    fillForm(stored.config);
  }
}

init();
