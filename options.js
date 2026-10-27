import { TYPE_ICONS, TYPE_LABELS } from './config.js';
import { normalizeId } from './notion.js';

const $ = (id) => document.getElementById(id);
const DB_KEYS = ['bookDatabaseId', 'movieDatabaseId', 'tvDatabaseId'];

async function callBackground(action, payload) {
  const res = await chrome.runtime.sendMessage({ action, ...payload });
  if (!res) throw new Error('后台没有响应，请刷新本页再试。');
  if (!res.success) throw new Error(res.error);
  return res.data;
}

// ---------- 自动保存 ----------

// 页面链接存两份：原样（显示给用户看）和解析出的 ID（插件用）
function readForm() {
  const page = $('parentPage').value.trim();
  const values = { notionToken: $('notionToken').value.trim(), parentPageUrl: page, parentPageId: normalizeId(page) };
  for (const key of DB_KEYS) values[key] = normalizeId($(key).value.trim());
  return values;
}

async function save() {
  await chrome.storage.local.set(readForm());
  $('saveStatus').textContent = `已自动保存 · ${new Date().toLocaleTimeString()}`;
}

let checkTimer = null;
function onEdit() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    await save();
    check(false);
  }, 700);
}

// ---------- 检查 ----------

function line(el, kind, text) {
  el.textContent = text;
  el.className = `check ${kind}`;
  el.hidden = !text;
}

function li(text, kind = '') {
  const el = document.createElement('li');
  el.textContent = text;
  el.className = kind;
  return el;
}

function describe(type, r) {
  const head = `${TYPE_ICONS[type]} ${TYPE_LABELS[type]}：`;
  if (r.error) return li(head + r.error, 'error');
  const fields = (list) => (list.length > 4 ? `${list.slice(0, 4).join('、')} 等 ${list.length} 个` : list.join('、'));
  switch (r.how) {
    case 'create':
      return li(`${head}第一次保存时自动新建「${r.dbTitle}」`);
    case 'created':
      return li(`${head}已新建「${r.dbTitle}」`, 'success');
    default: {
      const where = r.how === 'found' ? `沿用页面里的「${r.dbTitle}」` : `使用「${r.dbTitle}」`;
      if (r.added.length) return li(`${head}${where}，已补上 ${fields(r.added)}`, 'success');
      if (r.missing.length) return li(`${head}${where}，保存时会补上 ${fields(r.missing)}`);
      return li(`${head}${where}`, 'success');
    }
  }
}

function setBanner(kind, text, ready = false) {
  $('banner').className = `banner ${kind}`;
  $('bannerText').textContent = text;
  $('banner').hidden = !text;
  $('bannerAction').hidden = !ready;
}

let checking = 0;
async function check(apply) {
  const values = readForm();
  const hasDb = DB_KEYS.some((k) => values[k]);
  line($('tokenCheck'), '', '');
  line($('pageCheck'), '', '');
  $('plan').hidden = true;
  $('applyBtn').hidden = true;

  if (!values.notionToken) {
    setBanner('warn', '第一步：填写 Notion Token。');
    return;
  }
  const run = ++checking;
  line($('tokenCheck'), 'info', '正在检查…');
  let r;
  try {
    r = await callBackground('preparePage', { apply });
  } catch (err) {
    if (run === checking) line($('tokenCheck'), 'error', err.message);
    return;
  }
  if (run !== checking) return; // 期间又改了设置，以最新一次为准

  if (!r.token?.ok) {
    line($('tokenCheck'), 'error', `✗ ${r.token?.error || 'Token 无效'}`);
    setBanner('warn', 'Notion Token 不对，请检查后重新粘贴。');
    return;
  }
  line($('tokenCheck'), 'success', `✓ 已连接${r.token.workspace ? `工作区「${r.token.workspace}」` : ' Notion'}`);

  if (r.page && !r.page.ok) {
    line($('pageCheck'), 'error', `✗ ${r.page.error}`);
    setBanner('warn', '还连不上这个 Notion 页面，看看第 2 步的提示。');
    return;
  }
  if (r.page) line($('pageCheck'), 'success', `✓ 页面「${r.page.title}」`);
  if (!values.parentPageId && !hasDb) {
    setBanner('warn', '第二步：选一个 Notion 页面。');
    return;
  }

  const types = r.types || {};
  $('plan').replaceChildren(...['book', 'movie', 'tv'].map((t) => describe(t, types[t] || {})));
  $('plan').hidden = false;
  const errors = Object.values(types).filter((t) => t.error).length;
  const pending = Object.values(types).some((t) => t.how === 'create' || t.missing?.length);
  $('applyBtn').hidden = apply || !pending;
  if (errors) setBanner('warn', '有的数据库还有问题，看看下面的说明。');
  else setBanner('success', '✓ 一切就绪。去豆瓣打开一本书或一部电影，点插件图标就能保存。', true);
}

// ---------- 入口 ----------

async function init() {
  const stored = await chrome.storage.local.get(['notionToken', 'parentPageUrl', 'parentPageId', ...DB_KEYS]);
  $('notionToken').value = stored.notionToken || '';
  $('parentPage').value = stored.parentPageUrl || stored.parentPageId || '';
  for (const key of DB_KEYS) $(key).value = stored[key] || '';
  // 之前手动指定过数据库、还没选页面的老用户，默认展开
  if (DB_KEYS.some((k) => stored[k]) && !stored.parentPageId) $('advanced').open = true;

  // 插件自动建好 / 找到数据库后会写回设置，这里同步显示
  chrome.storage.onChanged.addListener((changes) => {
    for (const key of DB_KEYS) {
      if (changes[key] && document.activeElement !== $(key)) $(key).value = changes[key].newValue || '';
    }
  });

  for (const id of ['notionToken', 'parentPage', ...DB_KEYS]) $(id).addEventListener('input', onEdit);
  $('applyBtn').addEventListener('click', async () => {
    $('applyBtn').disabled = true;
    await check(true);
    $('applyBtn').disabled = false;
  });
  $('toggleToken').addEventListener('click', () => {
    const input = $('notionToken');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    $('toggleToken').textContent = hidden ? '隐藏' : '显示';
  });

  check(false);
}

init();
