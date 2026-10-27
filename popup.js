import { scrapeDouban } from './scraper.js';
import { collectSubjects } from './collector.js';
import { STATUS_LABELS } from './config.js';

const $ = (id) => document.getElementById(id);
const show = (el, visible = true) => {
  el.hidden = !visible;
};

let info = null; // 页面上抓到的条目
let mark = ''; // 我的标记：'' / mark / doing / done
let stars = 0; // 我的评分：0 = 不评
let markedOnDouban = false; // 标记是不是从豆瓣页面上读来的
let saved = null; // 保存后的结果；改了标记之后清空
let existingUrl = null;

async function callBackground(action, payload = {}) {
  const res = await chrome.runtime.sendMessage({ action, ...payload });
  if (!res) throw new Error('后台没有响应，请重新打开弹窗再试。');
  if (!res.success) throw new Error(res.error);
  return res.data;
}

function link(text, href) {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  return a;
}

function showOnly(id) {
  for (const s of ['loading', 'empty', 'subject', 'list']) show($(s), s === id);
}

function showEmpty(text) {
  $('emptyText').textContent = text;
  showOnly('empty');
}

// ---------- 单个条目 ----------

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderCard() {
  $('title').textContent = info.title;
  $('subtitle').textContent = [info.original_title || info.subtitle, info.year].filter(Boolean).join(' · ');
  const people = info.author || info.director;
  $('meta').textContent = [info.rating ? `豆瓣 ${info.rating}` : '暂无评分', people].filter(Boolean).join(' · ');
  $('cover').onerror = () => show($('cover'), false);
  if (info.cover) $('cover').src = info.cover;
  show($('cover'), !!info.cover);

  // 豆瓣偶尔把剧集当电影（或反过来），允许切换；图书不需要
  show($('typeSwitch'), info.type !== 'book');
  renderTypeSwitch();
}

function renderTypeSwitch() {
  for (const b of $('typeSwitch').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.type === info.type));
}

function renderStatusSwitch() {
  const labels = STATUS_LABELS[info.type];
  const options = [['', '不标记'], ['mark', labels.mark], ['doing', labels.doing], ['done', labels.done]];
  $('statusSwitch').replaceChildren(
    ...options.map(([value, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(value === mark));
      b.textContent = label;
      b.addEventListener('click', () => {
        mark = value;
        if (!mark) stars = 0;
        markChanged();
      });
      return b;
    }),
  );
  show($('ratingRow'), !!mark);
  renderStars();
}

function renderStars() {
  $('stars').replaceChildren(
    ...[1, 2, 3, 4, 5].map((n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(n === stars));
      b.setAttribute('aria-label', `${n} 星`);
      b.className = n <= stars ? 'on' : '';
      b.textContent = '★';
      // 再点一次同一颗星 = 取消评分
      b.addEventListener('click', () => {
        stars = stars === n ? 0 : n;
        markChanged();
      });
      return b;
    }),
  );
}

function markChanged() {
  markedOnDouban = false;
  show($('markedFrom'), false);
  renderStatusSwitch();
  if (saved) {
    // 保存后又改了标记：回到“保存”状态，让用户再存一次
    saved = null;
    show($('result'), false);
    renderActions(true);
  }
}

// 要写进 Notion 的信息：页面数据 + 弹窗里选的标记。
// 选“不标记”时不带这几个字段，Notion 里原有的标记保持不变。
function payload() {
  const data = { ...info };
  for (const k of ['mark', 'status', 'my_rating', 'marked_date']) delete data[k];
  if (mark) {
    data.status = STATUS_LABELS[info.type][mark];
    data.my_rating = stars ? String(stars) : '';
    data.marked_date = (markedOnDouban && info.marked_date) || today();
  }
  return data;
}

function renderActions(exists) {
  const done = !!saved;
  show($('sync'), !done);
  show($('openNotion'), done);
  if (done) {
    $('openNotion').href = saved.url;
    return;
  }
  $('sync').disabled = false;
  $('sync').textContent = exists ? '更新 Notion 里的这一条' : '保存到 Notion';
}

async function checkExisting() {
  show($('existing'), false);
  try {
    const { exists, url, dbTitle } = await callBackground('checkExisting', { info });
    existingUrl = exists ? url : null;
    if (exists) {
      $('existing').replaceChildren(`「${dbTitle}」里已经有这一条，保存会更新它。`, link('查看', url));
      show($('existing'));
    } else if (dbTitle) {
      $('existing').textContent = `会保存到「${dbTitle}」。`;
      show($('existing'));
    }
    renderActions(exists);
  } catch {
    // 查重失败不影响保存，保存时会给出具体错误
    renderActions(false);
  }
}

async function onSync() {
  $('sync').disabled = true;
  $('sync').textContent = '正在保存…';
  show($('result'), false);
  try {
    const r = await callBackground('sync', { info: payload() });
    saved = r;
    existingUrl = r.url;
    const notes = [];
    if (r.dbCreated) notes.push(`新建了数据库「${r.dbTitle}」`);
    if (r.fieldsAdded.length) notes.push(`补上了 ${r.fieldsAdded.length} 个字段`);
    if (!r.coverUploaded) notes.push('封面用了外链');
    const head = `✓ ${r.updated ? '已更新' : '已保存'}到「${r.dbTitle}」`;
    const again = document.createElement('button');
    again.className = 'text-btn';
    again.textContent = '重新保存';
    again.addEventListener('click', () => {
      saved = null;
      onSync();
    });
    $('result').replaceChildren(head + (notes.length ? `（${notes.join('，')}）` : ''), ' ', again);
    $('result').className = 'result success';
    show($('result'));
    show($('existing'), false);
    renderActions(true);
  } catch (err) {
    $('result').textContent = err.message;
    $('result').className = 'result error';
    show($('result'));
    renderActions(!!existingUrl);
  }
}

async function initSubject(tab) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapeDouban });
    if (!result || result.error) throw new Error(result?.error || '读取页面失败');
    info = result;
  } catch (err) {
    showEmpty(`读取页面失败：${err.message}。可以刷新豆瓣页面后再试。`);
    return;
  }

  // 你在豆瓣上已经标记过的，直接带过来
  mark = info.mark || '';
  stars = Number(info.my_rating) || 0;
  markedOnDouban = !!info.mark;
  if (markedOnDouban) {
    $('markedFrom').textContent = `已带上你在豆瓣的标记${info.marked_date ? `（${info.marked_date}）` : ''}`;
    show($('markedFrom'));
  }

  renderCard();
  renderStatusSwitch();
  showOnly('subject');

  const settings = await chrome.storage.local.get(['notionToken', 'parentPageId', 'bookDatabaseId', 'movieDatabaseId', 'tvDatabaseId']);
  if (!settings.notionToken || !(settings.parentPageId || settings[`${info.type}DatabaseId`])) {
    show($('setupNeeded'));
    return;
  }
  renderActions(false);
  checkExisting();
}

// ---------- 列表页 ----------

async function initListPage(tab) {
  let list;
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectSubjects });
    list = result;
  } catch (err) {
    showEmpty(`读取页面失败：${err.message}`);
    return;
  }
  if (!list?.items.length) {
    showEmpty('这个页面上没有找到图书或影视条目。打开一本书、一部电影，或者一个豆列、标签页、Top250 再试试。');
    return;
  }
  $('listName').textContent = list.name || '豆瓣页面';
  const books = list.items.filter((i) => i.type === 'book').length;
  const screen = list.items.length - books;
  const parts = [books && `图书 ${books}`, screen && `影视 ${screen}`].filter(Boolean).join('，');
  $('listMeta').textContent = `这一页 ${list.items.length} 个条目（${parts}）${list.next ? ` · 共 ${list.totalPages} 页` : ''}`;
  if (list.hasLoadMore) {
    $('listHint').textContent = '这个页面是滚动加载的，只能导入已经显示出来的条目。想要更多，先在页面上点几次「加载更多」，再打开我。';
    show($('listHint'));
  }
  showOnly('list');
  $('importPage').addEventListener('click', async () => {
    await chrome.storage.local.set({ pendingPage: { ...list, at: Date.now() } });
    await chrome.tabs.create({ url: chrome.runtime.getURL('import.html') });
    window.close();
  });
}

// ---------- 入口 ----------

async function init() {
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('goSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('openImport').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('import.html') }));
  $('sync').addEventListener('click', onSync);
  for (const b of $('typeSwitch').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      if (info.type === b.dataset.type) return;
      info.type = b.dataset.type;
      saved = null;
      show($('result'), false);
      renderTypeSwitch();
      renderStatusSwitch();
      checkExisting();
    });
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  if (/^https:\/\/(book|movie)\.douban\.com\/subject\/\d+/.test(url)) return initSubject(tab);
  if (/^https:\/\/(www|book|movie)\.douban\.com\//.test(url)) return initListPage(tab);
  showEmpty('在豆瓣的书、电影、剧集页面打开我，可以一键保存；在豆列、标签、Top250 这类列表页打开我，可以批量导入。');
}

init();
