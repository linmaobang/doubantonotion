import { TYPE_ICONS, TYPE_LABELS } from './config.js';
import { normalizeId } from './notion.js';

const KEYS = ['notionToken', 'parentPageId', 'bookDatabaseId', 'movieDatabaseId', 'tvDatabaseId'];
const ID_KEYS = ['parentPageId', 'bookDatabaseId', 'movieDatabaseId', 'tvDatabaseId'];
const $ = (id) => document.getElementById(id);

async function callBackground(action, payload) {
  const res = await chrome.runtime.sendMessage({ action, ...payload });
  if (!res) throw new Error('后台没有响应，请刷新本页再试。');
  if (!res.success) throw new Error(res.error);
  return res.data;
}

function rowStatus(row, text, kind = 'info') {
  const el = row.querySelector('.row-status');
  el.textContent = text;
  el.className = `row-status ${kind}`;
}

function readForm() {
  const values = {};
  for (const key of KEYS) values[key] = $(key).value.trim();
  for (const key of ID_KEYS) values[key] = normalizeId(values[key]);
  return values;
}

async function save() {
  const values = readForm();
  await chrome.storage.local.set(values);
  for (const key of KEYS) $(key).value = values[key];
  $('saveStatus').textContent = `已保存 ${new Date().toLocaleTimeString()}`;
}

function li(text, kind = '') {
  const el = document.createElement('li');
  el.textContent = text;
  el.className = kind;
  return el;
}

// 把每个类型的处理结果说成人话
function describe(type, r) {
  const head = `${TYPE_ICONS[type]} ${TYPE_LABELS[type]}：`;
  if (r.error) return li(head + r.error, 'error');
  const fields = (list) => (list.length > 5 ? `${list.slice(0, 5).join('、')} 等 ${list.length} 个` : list.join('、'));
  switch (r.how) {
    case 'create':
      return li(`${head}页面里还没有，第一次保存时会自动新建「${r.dbTitle}」`);
    case 'created':
      return li(`${head}已新建「${r.dbTitle}」`, 'success');
    default: {
      const where = r.how === 'found' ? `沿用页面里的「${r.dbTitle}」` : `使用「${r.dbTitle}」`;
      if (r.added.length) return li(`${head}${where}，已补上字段：${fields(r.added)}`, 'success');
      if (r.missing.length) return li(`${head}${where}，保存时会补上字段：${fields(r.missing)}`);
      return li(`${head}${where}，字段齐全`, 'success');
    }
  }
}

async function check(apply) {
  const values = readForm();
  if (!values.notionToken) return showPlan([li('先填写 Notion Token。', 'error')]);
  if (!values.parentPageId && !values.bookDatabaseId && !values.movieDatabaseId && !values.tvDatabaseId) {
    return showPlan([li('先填一个页面链接。', 'error')]);
  }
  await save();
  const btn = apply ? $('applyBtn') : $('checkBtn');
  btn.disabled = true;
  showPlan([li(apply ? '正在建库 / 补字段…' : '正在检查…')]);
  try {
    const result = await callBackground('preparePage', { apply });
    showPlan(['book', 'movie', 'tv'].map((t) => describe(t, result[t])));
    const pending = Object.values(result).some((r) => r.how === 'create' || r.missing?.length);
    $('applyBtn').hidden = apply || !pending;
  } catch (err) {
    showPlan([li(err.message, 'error')]);
    $('applyBtn').hidden = true;
  } finally {
    btn.disabled = false;
  }
}

function showPlan(items) {
  $('plan').replaceChildren(...items);
  $('plan').hidden = false;
}

async function verify(row) {
  const type = row.dataset.type;
  const { notionToken: token, [`${type}DatabaseId`]: databaseId } = readForm();
  if (!token) return rowStatus(row, '先填写 Notion Token。', 'error');
  if (!databaseId) return rowStatus(row, '先填写数据库链接或 ID。', 'error');
  rowStatus(row, '正在验证…');
  try {
    const { title, matched } = await callBackground('verify', { token, databaseId, type });
    rowStatus(row, `✓ 已连接「${title}」，能对上 ${matched.length} 个字段：${matched.join('、')}。缺少的字段会在保存时补上。`, 'success');
    await save();
  } catch (err) {
    rowStatus(row, err.message, 'error');
  }
}

async function init() {
  const stored = await chrome.storage.local.get(KEYS);
  for (const key of KEYS) $(key).value = stored[key] || '';
  // 之前手动指定过数据库、还没选页面的老用户，默认展开
  const hasDb = stored.bookDatabaseId || stored.movieDatabaseId || stored.tvDatabaseId;
  if (hasDb && !stored.parentPageId) $('advanced').open = true;

  // 插件自动建好/找到数据库后会写回设置，这里同步显示
  chrome.storage.onChanged.addListener((changes) => {
    for (const key of ID_KEYS) {
      if (changes[key] && document.activeElement !== $(key)) $(key).value = changes[key].newValue || '';
    }
  });

  $('save').addEventListener('click', save);
  $('checkBtn').addEventListener('click', () => check(false));
  $('applyBtn').addEventListener('click', () => check(true));
  $('toggleToken').addEventListener('click', () => {
    const input = $('notionToken');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    $('toggleToken').textContent = hidden ? '隐藏' : '显示';
  });
  for (const row of document.querySelectorAll('.db-row')) {
    row.querySelector('[data-action="verify"]').addEventListener('click', () => verify(row));
  }
}

init();
