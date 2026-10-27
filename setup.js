// 引导用户去设置：缺什么就直接带到设置页的那一栏，填好后还能一键回到原来的地方。
// 弹窗 / 侧边栏、批量导入页、设置页共用。

export const FOCUS_KEY = 'settingsFocus'; // { field, from, returnTabId, at }

const KEYS = ['notionToken', 'parentPageId', 'bookDatabaseId', 'movieDatabaseId', 'tvDatabaseId'];

export const FIELDS = {
  token: { label: 'Notion Token', action: '去填写 Notion Token', why: '还没有填写 Notion Token。' },
  page: { label: 'Notion 页面', action: '去选一个 Notion 页面', why: '还没有选 Notion 页面（插件会在里面自动建好数据库）。' },
  auto: { label: '自动同步', action: '去看自动同步设置', why: '' },
};

// 还缺哪一步：'token' / 'page' / null。types 只看这些类型是否有库可写
export function missingFrom(settings, types = ['book', 'movie', 'tv']) {
  if (!settings.notionToken) return 'token';
  const hasTarget = settings.parentPageId || types.some((t) => settings[`${t}DatabaseId`]);
  return hasTarget ? null : 'page';
}

export async function missingSetup(types) {
  return missingFrom(await chrome.storage.local.get(KEYS), types);
}

// 从后台的报错里看出该去改哪一栏
export function fieldForError(message = '') {
  if (/Token/.test(message)) return 'token';
  if (/找不到这个数据库或页面|还没有选择 Notion 页面|新建数据库需要先在设置页选一个/.test(message)) return 'page';
  return null;
}

// 打开设置页并定位到某一栏。设置页已经开着就切过去（openOptionsPage 会复用已打开的标签页）
export async function openSettings(field, { from = '', returnTabId = null } = {}) {
  await chrome.storage.local.set({ [FOCUS_KEY]: { field, from, returnTabId, at: Date.now() } });
  await chrome.runtime.openOptionsPage();
}

/**
 * 一个“还差一步”的提示框：说明 + 直达按钮。
 *   setupCallout('token', { from: '批量导入', returnTabId })
 */
export function setupCallout(field, { from = '', returnTabId = null, message = '' } = {}) {
  const box = document.createElement('div');
  box.className = 'setup-callout';
  const text = document.createElement('p');
  text.textContent = message || FIELDS[field]?.why || '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'primary';
  btn.textContent = `${FIELDS[field]?.action || '去设置'} →`;
  btn.addEventListener('click', () => openSettings(field, { from, returnTabId }));
  const hint = document.createElement('p');
  hint.className = 'muted small-text';
  hint.textContent = '设置好之后回到这里，会自动继续。';
  box.append(text, btn, hint);
  return box;
}

// 设置变了就回调（用来在原页面上自动恢复）
export function onSettingsChange(callback) {
  chrome.storage.onChanged.addListener((changes) => {
    if (KEYS.some((k) => k in changes)) callback();
  });
}
