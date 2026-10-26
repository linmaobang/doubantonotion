import { TYPE_LABELS } from './config.js';
import { normalizeId } from './notion.js';

const KEYS = ['notionToken', 'parentPageId', 'bookDatabaseId', 'movieDatabaseId', 'tvDatabaseId'];
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
  for (const key of ['parentPageId', 'bookDatabaseId', 'movieDatabaseId', 'tvDatabaseId']) {
    values[key] = normalizeId(values[key]);
  }
  return values;
}

async function save() {
  const values = readForm();
  await chrome.storage.local.set(values);
  for (const key of KEYS) $(key).value = values[key];
  $('saveStatus').textContent = `已保存 ${new Date().toLocaleTimeString()}`;
}

async function verify(row) {
  const type = row.dataset.type;
  const { notionToken: token, [`${type}DatabaseId`]: databaseId } = readForm();
  if (!token) return rowStatus(row, '先填写 Notion Token。', 'error');
  if (!databaseId) return rowStatus(row, '先填写数据库链接或 ID。', 'error');
  rowStatus(row, '正在验证…');
  try {
    const { title, matched } = await callBackground('verify', { token, databaseId, type });
    rowStatus(row, `✓ 已连接「${title}」，能对上 ${matched.length} 个字段：${matched.join('、')}`, 'success');
    await save();
  } catch (err) {
    rowStatus(row, err.message, 'error');
  }
}

async function create(row) {
  const type = row.dataset.type;
  const input = $(`${type}DatabaseId`);
  const { notionToken: token, parentPageId } = readForm();
  if (!token || !parentPageId) return rowStatus(row, '先填写 Notion Token 和父页面链接。', 'error');
  const label = TYPE_LABELS[type];
  const question = input.value.trim()
    ? `已经填了${label}数据库。确定要新建一个并替换掉它吗？（旧数据库不会被删除）`
    : `在父页面下新建一个${label}数据库？`;
  if (!confirm(question)) return;
  rowStatus(row, '正在创建…');
  try {
    const { id } = await callBackground('createDatabase', { token, parentPageId, type });
    input.value = id;
    await save();
    rowStatus(row, `✓ 已创建${label}数据库并保存。`, 'success');
  } catch (err) {
    rowStatus(row, err.message, 'error');
  }
}

async function init() {
  const stored = await chrome.storage.local.get(KEYS);
  for (const key of KEYS) $(key).value = stored[key] || '';

  $('save').addEventListener('click', save);
  $('toggleToken').addEventListener('click', () => {
    const input = $('notionToken');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    $('toggleToken').textContent = hidden ? '隐藏' : '显示';
  });
  for (const row of document.querySelectorAll('.db-row')) {
    row.querySelector('[data-action="verify"]').addEventListener('click', () => verify(row));
    row.querySelector('[data-action="create"]').addEventListener('click', () => create(row));
  }
}

init();
