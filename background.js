import { MAPPINGS, SCHEMAS } from './config.js';
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

// ---------- 豆瓣图片防盗链 ----------
// 豆瓣图片只接受带豆瓣 Referer 的请求。这条规则只作用于插件自己发出的请求
// （tabId = -1：后台和弹窗），不影响你正常浏览网页。
const REFERER_RULE_ID = 1;

async function ensureRefererRule() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [REFERER_RULE_ID],
    addRules: [
      {
        id: REFERER_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'Referer', operation: 'set', value: 'https://www.douban.com/' }],
        },
        condition: { requestDomains: ['doubanio.com'], tabIds: [-1] },
      },
    ],
  });
}

chrome.runtime.onInstalled.addListener(ensureRefererRule);
chrome.runtime.onStartup.addListener(ensureRefererRule);

// 换成大图：s_ratio_poster → l_ratio_poster，subject/s → subject/l
function largeCover(url) {
  return url.replace('/s_ratio_poster/', '/l_ratio_poster/').replace('/subject/s/', '/subject/l/');
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

const HANDLERS = { checkExisting, sync, verify, createDatabase };

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  const handler = HANDLERS[request.action];
  if (!handler) return false;
  handler(request)
    .then((data) => sendResponse({ success: true, data }))
    .catch((err) => {
      console.error(`[${request.action}]`, err);
      sendResponse({ success: false, error: friendlyError(err) });
    });
  return true; // 异步返回
});
