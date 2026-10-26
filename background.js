import { MAPPINGS } from './config.js';
import { blockKind, subjectKey } from './douban.js';
import { resolveDatabase } from './databases.js';
import {
  NotionClient,
  buildChildren,
  databaseTitle,
  findField,
  friendlyError,
  mapProperties,
  normalizeId,
  pageDecorations,
} from './notion.js';

// ---------- 豆瓣的 Referer 校验 ----------
// 豆瓣图片和移动端接口只接受带豆瓣 Referer 的请求。这两条规则只作用于插件自己
// 发出的请求（tabId = -1：后台和弹窗），不影响你正常浏览网页。
const REFERER_RULES = [
  { id: 1, domain: 'doubanio.com', referer: 'https://www.douban.com/' },
  { id: 2, domain: 'm.douban.com', referer: 'https://m.douban.com/mine/' },
];

async function ensureRefererRule() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: REFERER_RULES.map((r) => r.id),
    addRules: REFERER_RULES.map((r) => ({
      id: r.id,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'Referer', operation: 'set', value: r.referer }],
      },
      condition: { requestDomains: [r.domain], tabIds: [-1] },
    })),
  });
}

chrome.runtime.onInstalled.addListener(ensureRefererRule);
chrome.runtime.onStartup.addListener(ensureRefererRule);

// 换成大图：s/m_ratio_poster → l_ratio_poster，subject/s 或 m → subject/l
function largeCover(url) {
  return url.replace(/\/[sm]_ratio_poster\//, '/l_ratio_poster/').replace(/\/subject\/[sm]\//, '/subject/l/');
}

async function fetchCover(url) {
  await ensureRefererRule();
  for (const candidate of [largeCover(url), url]) {
    try {
      const res = await fetch(candidate);
      const blob = await res.blob();
      if (res.ok && blob.type.startsWith('image/') && blob.size > 0) return blob;
    } catch {
      // 换下一个地址再试
    }
  }
  return null;
}

async function uploadCover(client, info) {
  if (!info.cover) return null;
  try {
    const blob = await fetchCover(info.cover);
    if (!blob) return null;
    const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    return await client.uploadFile(blob, `cover.${ext}`);
  } catch (err) {
    console.warn('封面上传失败，改用外链：', err);
    return null;
  }
}

// ---------- 设置 ----------

async function getSettings() {
  return chrome.storage.local.get([
    'notionToken',
    'parentPageId',
    'bookDatabaseId',
    'movieDatabaseId',
    'tvDatabaseId',
  ]);
}

// 数据库结构缓存 5 分钟，避免每次打开弹窗都重新拉取
const dbCache = new Map();
async function getDatabaseCached(client, id) {
  const hit = dbCache.get(id);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.db;
  const db = await client.getDatabase(id);
  dbCache.set(id, { db, at: Date.now() });
  return db;
}

// 已经确认过（找到/建好/补全字段）的数据库，这次后台运行期间不再重复检查
const ready = new Map(); // type -> databaseId
// 同一类型同时只解析一次，避免弹窗和批量导入同时触发、建出两个库
const resolving = new Map();

/**
 * 拿到要写入的数据库。
 * create = true：找不到就建，缺字段就补（真正保存时用）；
 * create = false：只看不动（打开弹窗、导入预览时用），库还不存在时 databaseId 为 null。
 */
async function getTarget(type, { create = true } = {}) {
  const settings = await getSettings();
  if (!settings.notionToken) throw new Error('还没有填写 Notion Token，请先打开设置页。');
  const client = new NotionClient(settings.notionToken);

  if (!create) {
    const r = await resolveDatabase(client, settings, type, { create: false });
    return { client, ...r };
  }
  const known = ready.get(type);
  if (known && known === normalizeId(settings[`${type}DatabaseId`])) {
    return { client, databaseId: known, how: 'configured', added: [] };
  }

  if (!resolving.has(type)) {
    const job = (async () => {
      const r = await resolveDatabase(client, settings, type, { create: true });
      // 记住找到/新建的数据库，下次直接用
      if (r.databaseId !== normalizeId(settings[`${type}DatabaseId`])) {
        await chrome.storage.local.set({ [`${type}DatabaseId`]: r.databaseId });
      }
      ready.set(type, r.databaseId);
      dbCache.delete(r.databaseId);
      return r;
    })().finally(() => resolving.delete(type));
    resolving.set(type, job);
  }
  return { client, ...(await resolving.get(type)) };
}

// 设置变了（换了页面或数据库），重新解析
chrome.storage.onChanged.addListener((changes) => {
  if ('notionToken' in changes || 'parentPageId' in changes) ready.clear();
  for (const type of ['book', 'movie', 'tv']) {
    const change = changes[`${type}DatabaseId`];
    if (change && change.newValue !== ready.get(type)) ready.delete(type);
  }
});

async function findExistingPage(client, databaseId, db, type, url) {
  const field = findField('url', db.properties, MAPPINGS[type]);
  if (!field || db.properties[field].type !== 'url' || !url) return null;
  return client.findByUrl(databaseId, field, url);
}

// ---------- 操作 ----------

async function checkExisting({ info }) {
  const { client, databaseId, dbTitle } = await getTarget(info.type, { create: false });
  if (!databaseId) return { exists: false, url: null, dbTitle };
  const db = await getDatabaseCached(client, databaseId);
  const page = await findExistingPage(client, databaseId, db, info.type, info.url);
  return { exists: !!page, url: page?.url || null, dbTitle: databaseTitle(db) };
}

async function sync({ info }) {
  const { type } = info;
  const target = await getTarget(type);
  const { client, databaseId } = target;
  dbCache.delete(databaseId); // 同步时总是用最新结构
  const db = await getDatabaseCached(client, databaseId);
  const existing = await findExistingPage(client, databaseId, db, type, info.url);

  const coverUploadId = await uploadCover(client, info);
  const { properties, matched } = mapProperties(info, db.properties, type, { coverUploadId });
  const decorations = pageDecorations(info, coverUploadId);

  const page = existing
    ? await client.updatePage(existing.id, { properties, ...decorations })
    : await client.createPage({
        parent: { database_id: databaseId },
        properties,
        children: buildChildren(info),
        ...decorations,
      });

  return {
    url: page.url,
    updated: !!existing,
    matched,
    coverUploaded: !!coverUploadId,
    dbTitle: databaseTitle(db),
    dbCreated: target.how === 'created',
    fieldsAdded: target.added || [],
  };
}

async function verify({ token, databaseId, type }) {
  const client = new NotionClient(token);
  const db = await client.getDatabase(normalizeId(databaseId));
  const mapping = MAPPINGS[type];
  const matched = Object.keys(mapping)
    .map((key) => findField(key, db.properties, mapping))
    .filter(Boolean);
  return { title: databaseTitle(db), matched: [...new Set(matched)] };
}

// 设置页的“检查”：确认页面能访问，并说明每个类型会用哪个数据库。
// apply = true 时立即建库/补字段。
async function preparePage({ apply = false }) {
  const settings = await getSettings();
  if (!settings.notionToken) throw new Error('先填写 Notion Token。');
  const pageId = normalizeId(settings.parentPageId);
  if (pageId) {
    const client = new NotionClient(settings.notionToken);
    try {
      await client.getPage(pageId);
    } catch (err) {
      // 用户可能贴的是数据库链接
      const isDb = await client.getDatabase(pageId).then(() => true, () => false);
      if (isDb) {
        throw new Error('这是一个数据库的链接，不是页面。请填数据库所在的页面，或者在下面「已有数据库」里指定它。');
      }
      throw err;
    }
  }
  const result = {};
  for (const type of ['book', 'movie', 'tv']) {
    try {
      const r = await getTarget(type, { create: apply });
      result[type] = { how: r.how, dbTitle: r.dbTitle, missing: r.missing || [], added: r.added || [] };
    } catch (err) {
      result[type] = { error: friendlyError(err) };
    }
  }
  return result;
}

// ---------- 批量导入用到的操作 ----------

class DoubanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// 用户的想看/在看/看过列表（移动端接口，每页最多 50 条）
async function doubanInterests({ uid, kind, status, start = 0, count = 50 }) {
  await ensureRefererRule();
  const url =
    `https://m.douban.com/rexxar/api/v2/user/${encodeURIComponent(uid)}/interests` +
    `?type=${kind}&status=${status}&start=${start}&count=${count}&for_mobile=1`;
  const res = await fetch(url, { credentials: 'include' });
  if (res.status === 404) throw new DoubanError('DOUBAN_NO_USER', '找不到这个豆瓣用户，请检查主页链接。');
  if (res.status === 403 || res.status === 418 || res.status === 429) {
    throw new DoubanError('DOUBAN_BLOCKED', '豆瓣暂时拒绝了请求（可能需要安全验证）。');
  }
  const data = await res.json().catch(() => null);
  if (/sec\.douban\.com/.test(res.url) || (res.ok && !data)) {
    throw new DoubanError('DOUBAN_CHALLENGE', '豆瓣要求做一次安全验证。');
  }
  if (!res.ok || !data) throw new DoubanError('DOUBAN_ERROR', `豆瓣返回错误（${res.status}）。`);
  return { total: data.total || 0, interests: data.interests || [] };
}

// 详情页的 HTML，交给导入页用 DOMParser 解析
async function doubanPage({ url }) {
  const res = await fetch(url, { credentials: 'include' });
  const html = await res.text();
  if (res.status === 404) throw new DoubanError('DOUBAN_NOT_FOUND', '条目已不存在或被隐藏。');
  const kind = blockKind({ status: res.status, finalUrl: res.url, html });
  if (kind === 'challenge') throw new DoubanError('DOUBAN_CHALLENGE', '豆瓣弹出了安全验证。');
  if (kind === 'rate') throw new DoubanError('DOUBAN_BLOCKED', '豆瓣认为请求太频繁。');
  return { html, url: res.url };
}

// 数据库里已有条目的豆瓣编号，用来跳过已导入的；同时说明会用哪个数据库
async function listExisting({ type }) {
  const { client, databaseId, how, dbTitle, missing } = await getTarget(type, { create: false });
  const plan = { how, dbTitle, missing: missing || [] };
  if (!databaseId) return { ...plan, canDedupe: true, keys: [] }; // 库还没建，自然没有重复
  const db = await getDatabaseCached(client, databaseId);
  // 链接字段如果是待补的，补上后也是空的，同样不会重复
  const field = findField('url', db.properties, MAPPINGS[type]);
  if (!field) return { ...plan, canDedupe: true, keys: [] };
  if (db.properties[field].type !== 'url') return { ...plan, canDedupe: false, keys: [] };
  const urls = await client.listUrls(databaseId, field);
  return { ...plan, canDedupe: true, keys: urls.map(subjectKey).filter(Boolean) };
}

// 导入页切到后台后，页面里的定时器会被 Chrome 限流，所以等待放在后台脚本里做
const sleep = ({ ms }) => new Promise((r) => setTimeout(() => r(true), Math.min(ms, 4 * 60 * 1000)));

const HANDLERS = {
  sleep,
  checkExisting,
  sync,
  verify,
  preparePage,
  doubanInterests,
  doubanPage,
  listExisting,
};

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  const handler = HANDLERS[request.action];
  if (!handler) return false;
  handler(request)
    .then((data) => sendResponse({ success: true, data }))
    .catch((err) => {
      console.error(`[${request.action}]`, err);
      sendResponse({ success: false, error: friendlyError(err), code: err.code || null });
    });
  return true; // 异步返回
});
