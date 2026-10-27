import { scrapeDouban } from './scraper.js';
import { collectSubjects } from './collector.js';
import { STATUS_LABELS, TYPE_LABELS } from './config.js';
import { STATE_KEY, describeStatus } from './autosync.js';
import { hydrateIcons } from './icons.js';

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
let target = { kind: 'default' }; // 这次保存写进哪个库；每次打开弹窗都从默认库开始
let defaultDbTitle = '';
let dbList = null;
let currentList = null; // 列表页读到的条目
let currentTab = null; // 正在显示的标签页
let renderedUrl = ''; // 已经读过的地址：没变就不重读，免得打断正在进行的操作
let renderSeq = 0; // 页面切得快时，只认最后一次读取的结果

// 侧边栏和弹窗共用这份代码；侧边栏一直开着，要跟着页面变化
const IS_PANEL = document.body.classList.contains('panel');

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

function changeLink() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'text-btn';
  b.textContent = $('targetPicker').hidden ? '换一个库' : '收起';
  b.addEventListener('click', toggleTargetPicker);
  return b;
}

async function checkExisting() {
  existingUrl = null;
  if (target.kind === 'new') {
    const name = $('newDbName').value.trim() || '新数据库';
    $('existing').replaceChildren(`会新建「${name}」并保存进去。`, ' ', changeLink());
    show($('existing'));
    renderActions(false);
    return;
  }
  try {
    const { exists, url, dbTitle } = await callBackground('checkExisting', { info, target });
    if (target.kind === 'default') defaultDbTitle = dbTitle;
    existingUrl = exists ? url : null;
    if (exists) {
      $('existing').replaceChildren(`「${dbTitle}」里已经有这一条，保存会更新它。`, link('查看', url), ' ', changeLink());
    } else {
      $('existing').replaceChildren(`会保存到「${dbTitle || '默认数据库'}」。`, ' ', changeLink());
    }
    show($('existing'));
    renderActions(exists);
  } catch (err) {
    // 查重失败不影响保存，保存时会给出具体错误
    if (target.kind !== 'default') {
      $('existing').replaceChildren(err.message, ' ', changeLink());
      show($('existing'));
    }
    renderActions(false);
  }
}

// ---------- 换一个库 ----------

async function toggleTargetPicker() {
  const open = $('targetPicker').hidden;
  show($('targetPicker'), open);
  for (const b of $('existing').querySelectorAll('.text-btn')) b.textContent = open ? '收起' : '换一个库';
  if (!open) return;
  renderTargetSelect();
  if (!dbList) {
    try {
      dbList = await callBackground('listDatabases');
    } catch {
      dbList = [];
    }
    renderTargetSelect();
  }
}

function renderTargetSelect() {
  const sel = $('targetSelect');
  sel.replaceChildren(
    new Option(`默认：${defaultDbTitle ? `「${defaultDbTitle}」` : '按设置自动选'}`, 'default'),
    new Option('新建一个数据库…', 'new'),
  );
  const group = document.createElement('optgroup');
  group.label = '已有的数据库';
  if (!dbList) group.append(Object.assign(new Option('正在读取…', ''), { disabled: true }));
  for (const db of dbList || []) group.append(new Option(`${db.icon || '🗂'} ${db.title}`, `db:${db.id}`));
  sel.append(group);
  sel.value = target.kind === 'existing' ? `db:${target.databaseId}` : target.kind;
}

function onTargetSelect() {
  const v = $('targetSelect').value;
  if (v === 'default') target = { kind: 'default' };
  else if (v === 'new') {
    if (!$('newDbName').value) $('newDbName').value = `豆瓣${TYPE_LABELS[info.type]}`;
    target = { kind: 'new', title: $('newDbName').value.trim() };
  } else target = { kind: 'existing', databaseId: v.slice(3) };
  show($('newDbName'), target.kind === 'new');
  if (target.kind === 'new') $('newDbName').focus();
  saved = null;
  show($('result'), false);
  checkExisting();
}

async function onSync() {
  $('sync').disabled = true;
  $('sync').textContent = '正在保存…';
  show($('result'), false);
  try {
    if (target.kind === 'new') target.title = $('newDbName').value.trim() || `豆瓣${TYPE_LABELS[info.type]}`;
    const r = await callBackground('sync', { info: payload(), target });
    saved = r;
    existingUrl = r.url;
    // 新建的库建好了：之后（比如“重新保存”）就写进这个库，不再新建
    if (target.kind === 'new') {
      target = { kind: 'existing', databaseId: r.databaseId };
      dbList = null;
      show($('newDbName'), false);
      show($('targetPicker'), false);
    }
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

async function initSubject(tab, seq) {
  let result;
  try {
    [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapeDouban });
    if (!result || result.error) throw new Error(result?.error || '读取页面失败');
  } catch (err) {
    if (seq === renderSeq) showEmpty(`读取页面失败：${err.message}。可以刷新豆瓣页面后再试。`);
    return;
  }
  if (seq !== renderSeq) return;
  info = result;

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
  if (seq !== renderSeq) return;
  if (!settings.notionToken || !(settings.parentPageId || settings[`${info.type}DatabaseId`])) {
    show($('setupNeeded'));
    return;
  }
  renderActions(false);
  checkExisting();
}

// ---------- 列表页 ----------

async function initListPage(tab, seq) {
  let list;
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectSubjects });
    list = result;
  } catch (err) {
    if (seq === renderSeq) showEmpty(`读取页面失败：${err.message}`);
    return;
  }
  if (seq !== renderSeq) return;
  currentList = list;
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
    $('listHint').textContent = IS_PANEL
      ? '这个页面是滚动加载的，只能导入已经显示出来的条目。想要更多，先在页面上点几次「加载更多」，再点右上角的 ↻ 重新读取。'
      : '这个页面是滚动加载的，只能导入已经显示出来的条目。想要更多，先在页面上点几次「加载更多」，再打开我。';
    show($('listHint'));
  }
  showOnly('list');
}

async function importCurrentList() {
  if (!currentList) return;
  await chrome.storage.local.set({ pendingPage: { ...currentList, at: Date.now() } });
  await chrome.tabs.create({ url: chrome.runtime.getURL('import.html') });
  if (!IS_PANEL) window.close();
}

// ---------- 自动同步状态 ----------

async function renderAutoFooter() {
  const state = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
  show($('autoAction'), false);
  if (!state?.enabled) {
    show($('autoFooter'), false);
    return;
  }
  const { short, text, kind, needsDouban } = describeStatus(state);
  $('autoText').textContent = short;
  $('autoFooter').title = text;
  $('autoFooter').className = `auto-footer ${kind}`;
  show($('autoFooter'));
  if (needsDouban) {
    $('autoAction').textContent = '打开豆瓣';
    $('autoAction').onclick = () => chrome.tabs.create({ url: 'https://www.douban.com/' });
    show($('autoAction'));
  } else if (kind === 'error') {
    $('autoAction').textContent = '去设置';
    $('autoAction').onclick = () => chrome.runtime.openOptionsPage();
    show($('autoAction'));
  }
}

// ---------- 读取当前页面 ----------

// 换页面时把上一页留下的状态清干净
function resetView() {
  info = null;
  mark = '';
  stars = 0;
  markedOnDouban = false;
  saved = null;
  existingUrl = null;
  target = { kind: 'default' };
  currentList = null;
  $('newDbName').value = '';
  for (const id of ['result', 'existing', 'targetPicker', 'newDbName', 'setupNeeded', 'sync', 'openNotion', 'markedFrom', 'listHint']) {
    show($(id), false);
  }
}

async function render(tab, { force = false } = {}) {
  const url = tab?.url || '';
  if (!force && tab?.id === currentTab?.id && url === renderedUrl) return;
  currentTab = tab;
  renderedUrl = url;
  const seq = ++renderSeq;
  resetView();
  showOnly('loading');
  if (/^https:\/\/(book|movie)\.douban\.com\/subject\/\d+/.test(url)) return initSubject(tab, seq);
  if (/^https:\/\/(www|book|movie)\.douban\.com\//.test(url)) return initListPage(tab, seq);
  showEmpty(
    IS_PANEL
      ? '打开豆瓣的书、电影、剧集页面，这里会显示它，可以一键保存；打开豆列、标签、Top250 这类列表页，可以批量导入。'
      : '在豆瓣的书、电影、剧集页面打开我，可以一键保存；在豆列、标签、Top250 这类列表页打开我，可以批量导入。',
  );
}

// 侧边栏：跟着切标签页、跟着页面跳转
async function followTabs() {
  const win = await chrome.windows.getCurrent();
  chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    if (windowId !== win.id) return;
    render(await chrome.tabs.get(tabId));
  });
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (tabId !== currentTab?.id) return;
    // 页面加载完再读；只有地址变了才重读（同一页里的刷新不打断你）
    if (change.status === 'complete' && tab.url !== renderedUrl) render(tab);
    else if (change.url && change.url !== renderedUrl) showOnly('loading');
  });
}

// ---------- 入口 ----------

function setupOnce() {
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('goSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('openImport').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('import.html') }));
  $('importPage').addEventListener('click', importCurrentList);
  $('sync').addEventListener('click', onSync);
  $('targetSelect').addEventListener('change', onTargetSelect);
  $('newDbName').addEventListener('input', () => {
    target.title = $('newDbName').value.trim();
    checkExisting();
  });
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

  if (IS_PANEL) {
    // 侧边栏：手动重新读取（比如“加载更多”之后）
    show($('refresh'));
    $('refresh').addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      render(tab, { force: true });
    });
  } else {
    // 弹窗：一键固定到侧边栏。sidePanel.open 必须在点击里同步调用
    show($('pinPanel'));
    $('pinPanel').addEventListener('click', () => {
      chrome.sidePanel
        .open({ windowId: currentTab.windowId })
        .then(() => chrome.storage.local.set({ openMode: 'panel' }))
        .then(() => window.close())
        .catch((err) => {
          $('emptyText').textContent = `打不开侧边栏：${err.message}（需要 Chrome 116 或更新的版本）`;
          showOnly('empty');
        });
    });
  }
}

async function init() {
  hydrateIcons();
  setupOnce();
  renderAutoFooter();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  render(tab, { force: true });
  if (IS_PANEL) {
    followTabs();
    // 侧边栏一直开着：自动同步的状态变了就更新底栏
    chrome.storage.onChanged.addListener((changes) => {
      if (changes[STATE_KEY]) renderAutoFooter();
    });
  }
}

init();
