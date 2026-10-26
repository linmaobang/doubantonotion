import { MAPPINGS, SCHEMAS } from './config.js';
import { blockKind, subjectKey } from './douban.js';
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

async function getTarget(type) {
  const settings = await getSettings();
  const token = settings.notionToken;
  const databaseId = normalizeId(settings[`${type}DatabaseId`]);
  if (!token) throw new Error('还没有填写 Notion Token，请先打开设置页。');
  if (!databaseId) throw new Error('还没有设置这个类型的数据库，请先打开设置页。');
  return { client: new NotionClient(token), databaseId };
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

async function findExistingPage(client, databaseId, db, type, url) {
  const field = findField('url', db.properties, MAPPINGS[type]);
  if (!field || db.properties[field].type !== 'url' || !url) return null;
  return client.findByUrl(databaseId, field, url);
}

// ---------- 操作 ----------

async function checkExisting({ info }) {
  const { client, databaseId } = await getTarget(info.type);
  const db = await getDatabaseCached(client, databaseId);
  const page = await findExistingPage(client, databaseId, db, info.type, info.url);
  return { exists: !!page, url: page?.url || null, dbTitle: databaseTitle(db) };
}

async function sync({ info }) {
  const { type } = info;
  const { client, databaseId } = await getTarget(type);
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

async function createDatabase({ token, parentPageId, type }) {
  const client = new NotionClient(token);
  const db = await client.createDatabase(normalizeId(parentPageId), SCHEMAS[type]);
  return { id: db.id, url: db.url };
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

// 数据库里已有条目的豆瓣编号，用来跳过已导入的
async function listExisting({ type }) {
  const { client, databaseId } = await getTarget(type);
  const db = await client.getDatabase(databaseId);
  const field = findField('url', db.properties, MAPPINGS[type]);
  if (!field || db.properties[field].type !== 'url') {
    return { databaseId, dbTitle: databaseTitle(db), canDedupe: false, keys: [] };
  }
  const urls = await client.listUrls(databaseId, field);
  return { databaseId, dbTitle: databaseTitle(db), canDedupe: true, keys: urls.map(subjectKey).filter(Boolean) };
}

// 找出数据库里缺少的字段（和“一键建库”的结构相比）
function missingFields(db, type) {
  const mapping = MAPPINGS[type];
  const schema = SCHEMAS[type].properties;
  const missing = {};
  for (const key of Object.keys(mapping)) {
    if (key === 'title' || findField(key, db.properties, mapping)) continue;
    const name = Object.keys(schema).find((n) => mapping[key].some((c) => c.toLowerCase() === n.toLowerCase()));
    if (name) missing[name] = schema[name];
  }
  return missing;
}

async function checkFields({ type }) {
  const { client, databaseId } = await getTarget(type);
  const db = await client.getDatabase(databaseId);
  return { dbTitle: databaseTitle(db), missing: Object.keys(missingFields(db, type)) };
}

async function addMissingFields({ type }) {
  const { client, databaseId } = await getTarget(type);
  const db = await client.getDatabase(databaseId);
  const missing = missingFields(db, type);
  if (Object.keys(missing).length) await client.updateDatabase(databaseId, { properties: missing });
  dbCache.delete(databaseId);
  return { added: Object.keys(missing) };
}

// 导入页切到后台后，页面里的定时器会被 Chrome 限流，所以等待放在后台脚本里做
const sleep = ({ ms }) => new Promise((r) => setTimeout(() => r(true), Math.min(ms, 4 * 60 * 1000)));

const HANDLERS = {
  sleep,
  checkExisting,
  sync,
  verify,
  createDatabase,
  doubanInterests,
  doubanPage,
  listExisting,
  checkFields,
  addMissingFields,
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
