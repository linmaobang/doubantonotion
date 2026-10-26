import { scrapeDouban } from './scraper.js';
import { TYPE_LABELS } from './config.js';

const $ = (id) => document.getElementById(id);
const els = {
  message: $('message'),
  card: $('card'),
  cover: $('cover'),
  title: $('title'),
  subtitle: $('subtitle'),
  meta: $('meta'),
  itemType: $('itemType'),
  existing: $('existing'),
  sync: $('sync'),
  goSettings: $('goSettings'),
  result: $('result'),
};

let info = null;

function show(el, visible = true) {
  el.hidden = !visible;
}

function setMessage(text, kind = 'info') {
  els.message.textContent = text;
  els.message.className = `message ${kind}`;
  show(els.message, !!text);
}

function setResult(text, link, kind = 'success') {
  els.result.replaceChildren(document.createTextNode(text));
  if (link) {
    const a = document.createElement('a');
    a.href = link;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = '在 Notion 中打开 →';
    els.result.append(' ', a);
  }
  els.result.className = `result ${kind}`;
  show(els.result);
}

async function callBackground(action, payload = {}) {
  const res = await chrome.runtime.sendMessage({ action, ...payload });
  if (!res) throw new Error('后台没有响应，请重新打开弹窗再试。');
  if (!res.success) throw new Error(res.error);
  return res.data;
}

function renderCard() {
  els.title.textContent = info.title;
  els.subtitle.textContent = [info.original_title || info.subtitle, info.year].filter(Boolean).join(' · ');
  const people = info.author || info.director;
  const rating = info.rating ? `豆瓣 ${info.rating}` : '暂无评分';
  els.meta.textContent = [rating, people].filter(Boolean).join(' · ');
  if (info.cover) els.cover.src = info.cover;
  show(els.cover, !!info.cover);

  els.itemType.value = info.type;
  // 图书只能存为图书；电影和剧集可以互换（豆瓣偶尔分类不准）
  for (const opt of els.itemType.options) {
    opt.disabled = info.type === 'book' ? opt.value !== 'book' : opt.value === 'book';
  }
  show(els.card);
}

function updateSyncLabel(exists) {
  els.sync.textContent = exists ? '更新 Notion 中的条目' : `保存到 Notion（${TYPE_LABELS[info.type]}库）`;
}

async function checkExisting() {
  show(els.existing, false);
  updateSyncLabel(false);
  try {
    const { exists, url, dbTitle } = await callBackground('checkExisting', { info });
    updateSyncLabel(exists);
    if (exists) {
      els.existing.replaceChildren(document.createTextNode(`「${dbTitle}」里已经有这条，再次保存会更新它。`));
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '查看';
      els.existing.append(' ', a);
      show(els.existing);
    }
  } catch {
    // 查重失败不影响保存，保存时会给出具体错误
  }
}

async function onSync() {
  els.sync.disabled = true;
  els.sync.textContent = '正在保存…';
  show(els.result, false);
  try {
    const r = await callBackground('sync', { info });
    const verb = r.updated ? '已更新' : '已保存';
    const note = r.coverUploaded ? '' : '（封面没能上传，用了外链）';
    setResult(`${verb}到「${r.dbTitle}」，写入 ${r.matched.length} 个字段${note}。`, r.url);
    updateSyncLabel(true);
    show(els.existing, false);
  } catch (err) {
    setResult(err.message, null, 'error');
    updateSyncLabel(false);
  } finally {
    els.sync.disabled = false;
  }
}

async function init() {
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('openImport').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('import.html') }));
  els.goSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());
  els.sync.addEventListener('click', onSync);
  els.itemType.addEventListener('change', () => {
    info.type = els.itemType.value;
    checkExisting();
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!/^https:\/\/(book|movie)\.douban\.com\/subject\/\d+/.test(tab?.url || '')) {
    setMessage('请在豆瓣图书、电影或剧集的详情页打开我。');
    return;
  }

  setMessage('正在读取页面…');
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapeDouban });
    if (!result || result.error) throw new Error(result?.error || '读取页面失败');
    info = result;
  } catch (err) {
    setMessage(`读取页面失败：${err.message}。可以刷新页面后再试。`, 'error');
    return;
  }
  setMessage('');
  renderCard();

  const settings = await chrome.storage.local.get(['notionToken', `${info.type}DatabaseId`]);
  if (!settings.notionToken) {
    setMessage('第一次使用：先在设置页填写 Notion Token 并连接数据库。', 'warn');
    show(els.goSettings);
    return;
  }
  show(els.sync);
  checkExisting();
}

init();
