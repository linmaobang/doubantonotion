import { MAPPINGS, TYPE_ICONS } from './config.js';

// 继续使用 2022-06-28：更新的 2025-09-03 版本改成了 data source 模型，
// 数据库的查询、建页接口都不兼容。文件上传接口在这个版本下也能用。
const NOTION_VERSION = '2022-06-28';
const API = 'https://api.notion.com/v1';
const TEXT_LIMIT = 2000; // Notion 单段 rich_text 的字数上限
const MAX_RICH_TEXT_ITEMS = 100;
const OPTION_LIMIT = 100; // select 选项名的长度上限

// ---------- 纯函数（可以单独测试） ----------

// 支持 32 位 ID、带横线的 UUID，以及完整的 Notion 链接
export function normalizeId(input) {
  if (!input) return '';
  const s = String(input).trim();
  const uuid = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  const lastSegment = s.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop();
  const raw = uuid ? uuid[0].replace(/-/g, '') : lastSegment.match(/[0-9a-f]{32}$/i)?.[0];
  if (!raw) return s;
  const h = raw.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// 从 “2003-8”“1994-09-10(美国) / 2026-08-28(中国大陆)”“2019年7月” 中取最早的日期
export function parseDate(value) {
  const s = Array.isArray(value) ? value.join(' / ') : String(value || '');
  const re = /(\d{4})(?:\s*[-年./]\s*(\d{1,2}))?(?:\s*[-月./]\s*(\d{1,2}))?/g;
  const found = [];
  for (const m of s.matchAll(re)) {
    const y = +m[1];
    const mo = m[2] ? +m[2] : 1;
    const d = m[3] ? +m[3] : 1;
    if (y < 1000 || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    found.push(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  found.sort();
  return found[0] || null;
}

export function parseNumber(value) {
  const m = String(value ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function toText(value) {
  return Array.isArray(value) ? value.join(' / ') : String(value ?? '');
}

export function richText(value) {
  const s = toText(value);
  const parts = [];
  for (let i = 0; i < s.length && parts.length < MAX_RICH_TEXT_ITEMS; i += TEXT_LIMIT) {
    parts.push({ type: 'text', text: { content: s.slice(i, i + TEXT_LIMIT) } });
  }
  return parts;
}

// Notion 的选项名里不能有英文逗号
function optionName(value) {
  return String(value).replace(/,/g, '，').trim().slice(0, OPTION_LIMIT);
}

function toList(value) {
  const list = Array.isArray(value) ? value : String(value).split('/');
  return [...new Set(list.map(optionName).filter(Boolean))];
}

export function formatValue(value, propType, key, extra = {}) {
  switch (propType) {
    case 'title':
      return { title: richText(value) };
    case 'rich_text':
      return { rich_text: richText(value) };
    case 'number': {
      const n = parseNumber(value);
      return n === null ? null : { number: n };
    }
    case 'select': {
      const first = toList(value)[0];
      return first ? { select: { name: first } } : null;
    }
    case 'multi_select': {
      const list = toList(value);
      return list.length ? { multi_select: list.map((name) => ({ name })) } : null;
    }
    case 'date': {
      const start = parseDate(value);
      return start ? { date: { start } } : null;
    }
    case 'url':
      return { url: String(value) };
    case 'files': {
      if (key !== 'cover') return null;
      if (extra.coverUploadId) {
        return { files: [{ type: 'file_upload', file_upload: { id: extra.coverUploadId }, name: 'cover' }] };
      }
      return { files: [{ type: 'external', name: 'cover', external: { url: String(value) } }] };
    }
    default:
      return null;
  }
}

function isEmpty(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

// 找到这个豆瓣字段在数据库里对应的字段名
export function findField(key, dbProperties, mapping) {
  const names = Object.keys(dbProperties);
  for (const candidate of mapping[key] || [key]) {
    const found = names.find((n) => n.trim().toLowerCase() === candidate.toLowerCase());
    if (found) return found;
  }
  // 标题字段每个数据库都有且只有一个，名字对不上也直接用它
  if (key === 'title') return names.find((n) => dbProperties[n].type === 'title') || null;
  return null;
}

export function mapProperties(info, dbProperties, type, extra = {}) {
  const mapping = MAPPINGS[type] || {};
  const properties = {};
  const matched = [];
  for (const key of Object.keys(mapping)) {
    const value = info[key];
    if (isEmpty(value)) continue;
    const field = findField(key, dbProperties, mapping);
    if (!field || field in properties) continue;
    const formatted = formatValue(value, dbProperties[field].type, key, extra);
    if (formatted) {
      properties[field] = formatted;
      matched.push(field);
    }
  }
  return { properties, matched };
}

function paragraphs(text) {
  return String(text)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: richText(line) } }));
}

function heading(text) {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: richText(text) } };
}

export function buildChildren(info) {
  const blocks = [];
  if (info.summary) blocks.push(heading('简介'), ...paragraphs(info.summary));
  if (info.author_intro) blocks.push(heading('作者简介'), ...paragraphs(info.author_intro));
  return blocks.slice(0, 100); // 一次请求最多 100 个块
}

export function pageDecorations(info, coverUploadId) {
  const deco = { icon: { type: 'emoji', emoji: TYPE_ICONS[info.type] || '📄' } };
  if (coverUploadId) deco.cover = { type: 'file_upload', file_upload: { id: coverUploadId } };
  else if (info.cover) deco.cover = { type: 'external', external: { url: info.cover } };
  return deco;
}

export function databaseTitle(db) {
  return (db.title || []).map((t) => t.plain_text).join('') || '未命名数据库';
}

// ---------- 错误信息 ----------

export class NotionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function friendlyError(err) {
  if (!(err instanceof NotionError)) {
    if (err?.name === 'TypeError') return '网络请求失败，请检查网络连接。';
    return err?.message || String(err);
  }
  switch (err.code) {
    case 'unauthorized':
      return 'Notion Token 无效，请到设置页重新填写。';
    case 'restricted_resource':
    case 'object_not_found':
      return '找不到这个数据库或页面。请确认 ID 正确，并且已在 Notion 页面右上角「…」→「连接」里添加了你的集成。';
    case 'rate_limited':
      return 'Notion 请求太频繁，请稍后再试。';
    case 'validation_error':
      return `Notion 拒绝了这次写入：${err.message}`;
    default:
      return `Notion 返回错误（${err.status}）：${err.message}`;
  }
}

// ---------- API 客户端 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class NotionClient {
  constructor(token) {
    this.token = token;
  }

  async request(path, { method = 'GET', body, form } = {}, attempt = 0) {
    const headers = { Authorization: `Bearer ${this.token}`, 'Notion-Version': NOTION_VERSION };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = Number(res.headers.get('Retry-After')) * 1000 || 1000 * 2 ** attempt;
      await sleep(Math.min(wait, 10000));
      return this.request(path, { method, body, form }, attempt + 1);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new NotionError(res.status, data.code, data.message || res.statusText);
    return data;
  }

  getDatabase(id) {
    return this.request(`/databases/${id}`);
  }

  async findByUrl(databaseId, property, url) {
    const res = await this.request(`/databases/${databaseId}/query`, {
      method: 'POST',
      body: { filter: { property, url: { equals: url } }, page_size: 1 },
    });
    return res.results?.[0] || null;
  }

  createPage(body) {
    return this.request('/pages', { method: 'POST', body });
  }

  updatePage(id, body) {
    return this.request(`/pages/${id}`, { method: 'PATCH', body });
  }

  createDatabase(parentPageId, schema) {
    return this.request('/databases', {
      method: 'POST',
      body: { parent: { type: 'page_id', page_id: parentPageId }, ...schema },
    });
  }

  async uploadFile(blob, filename) {
    const created = await this.request('/file_uploads', {
      method: 'POST',
      body: { filename, content_type: blob.type || 'image/jpeg' },
    });
    const form = new FormData();
    form.append('file', blob, filename);
    await this.request(`/file_uploads/${created.id}/send`, { method: 'POST', form });
    return created.id;
  }
}
