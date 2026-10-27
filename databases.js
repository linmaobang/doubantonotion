import { MAPPINGS, SCHEMAS } from './config.js';
import { NotionError, databaseTitle, normalizeId, resolveFieldMap } from './notion.js';

// 在用户的页面里找现成数据库时，认这些名字（不区分大小写，完全一致才算）
export const DB_TITLE_ALIASES = {
  book: ['我的书库', '书库', '图书', '读书', '书单', '豆瓣读书', 'books', 'reading'],
  movie: ['我的影院', '影院', '电影', '观影', '豆瓣电影', 'movies', 'films'],
  tv: ['我的剧集', '剧集', '电视剧', '追剧', '豆瓣剧集', 'tv', 'tv shows', 'series'],
};

// 和自动建库的结构相比，数据库里还缺哪些字段。
// 已有的字段（按候选名匹配到的）一律不动，哪怕类型不一样。
export function missingFields(dbProperties, type, fieldMap = null) {
  if (fieldMap && fieldMap.addMissing === false) return {}; // 用户选了“不要新建列”
  const mapping = MAPPINGS[type];
  const schema = SCHEMAS[type].properties;
  const resolved = resolveFieldMap(dbProperties, type, fieldMap);
  const existing = new Set(Object.keys(dbProperties).map((n) => n.trim().toLowerCase()));
  const missing = {};
  for (const key of Object.keys(mapping)) {
    if (key === 'title' || resolved[key]) continue;
    const name = Object.keys(schema).find((n) => mapping[key].some((c) => c.toLowerCase() === n.toLowerCase()));
    // 同名的列已经存在（比如被设成了“不写入”）：绝不去动它
    if (name && !(name in missing) && !existing.has(name.toLowerCase())) missing[name] = schema[name];
  }
  return missing;
}

// 从页面的子块里挑出这个类型对应的数据库
export function pickChildDatabase(blocks, type) {
  const wanted = DB_TITLE_ALIASES[type].map((n) => n.toLowerCase());
  return (
    blocks.find(
      (b) =>
        b.type === 'child_database' &&
        !b.archived &&
        !b.in_trash &&
        wanted.includes((b.child_database?.title || '').trim().toLowerCase()),
    ) || null
  );
}

const isGone = (err) =>
  err instanceof NotionError && (err.code === 'object_not_found' || err.code === 'restricted_resource');

/**
 * 找到（必要时创建）某个类型要写入的数据库。
 *
 * 顺序：
 * 1. 设置里指定了数据库，并且能访问 → 用它；
 * 2. 在用户选的页面里找名字对得上的数据库 → 用它；
 * 3. 都没有 → 在这个页面里新建一个。
 * 用现成的数据库时，只补上缺少的字段，不改已有字段。
 *
 * create = false 时只做检查（不建库、不补字段），用于预览。
 */
export async function resolveDatabase(client, settings, type, { create = true } = {}) {
  const configuredId = normalizeId(settings[`${type}DatabaseId`]);
  const pageId = normalizeId(settings.parentPageId);

  let db = null;
  let how = null;

  if (configuredId) {
    try {
      db = await client.getDatabase(configuredId);
      if (db.archived || db.in_trash) db = null;
      else how = 'configured';
    } catch (err) {
      // 指定的数据库被删了或没权限：有页面就退回自动模式，否则把错误报给用户
      if (!isGone(err) || !pageId) throw err;
    }
  }

  if (!db && pageId) {
    const child = pickChildDatabase(await client.listChildren(pageId), type);
    if (child) {
      db = await client.getDatabase(child.id);
      how = 'found';
    }
  }

  if (!db) {
    if (!pageId) {
      throw new Error('还没有选择 Notion 页面。请在设置页填一个页面链接，插件会在里面自动建好数据库。');
    }
    if (!create) {
      return { how: 'create', databaseId: null, dbTitle: SCHEMAS[type].title[0].text.content, missing: [], added: [] };
    }
    db = await client.createDatabase(pageId, SCHEMAS[type]);
    return { how: 'created', databaseId: db.id, db, dbTitle: databaseTitle(db), missing: [], added: [] };
  }

  const missing = missingFields(db.properties, type, settings.fieldMaps?.[normalizeId(db.id)]);
  const names = Object.keys(missing);
  if (!create || names.length === 0) {
    return { how, databaseId: db.id, db, dbTitle: databaseTitle(db), missing: names, added: [] };
  }
  db = await client.updateDatabase(db.id, { properties: missing });
  return { how, databaseId: db.id, db, dbTitle: databaseTitle(db), missing: [], added: names };
}

// ---------- 用户自己选的目标库 ----------
// target 的几种写法：
//   { kind: 'default' }                 设置里的默认库（按上面的规则自动找 / 建）
//   { kind: 'existing', databaseId }    一个已有的库：只补缺少的字段，不改已有字段
//   { kind: 'new', title }              在设置里选的页面下新建一个库

export function schemaWithTitle(type, title) {
  return { ...SCHEMAS[type], title: [{ type: 'text', text: { content: String(title).slice(0, 200) } }] };
}

export function defaultTitle(type) {
  return SCHEMAS[type].title[0].text.content;
}

export async function resolveChosen(client, settings, type, target, { create = true } = {}) {
  const kind = target?.kind || 'default';
  if (kind === 'default') return resolveDatabase(client, settings, type, { create });

  if (kind === 'existing') {
    let db = await client.getDatabase(normalizeId(target.databaseId));
    if (db.archived || db.in_trash) throw new Error(`数据库「${databaseTitle(db)}」已经被删除了，请换一个。`);
    const missing = missingFields(db.properties, type, settings.fieldMaps?.[normalizeId(db.id)]);
    const names = Object.keys(missing);
    if (!create || names.length === 0) {
      return { how: 'chosen', databaseId: db.id, db, dbTitle: databaseTitle(db), missing: names, added: [] };
    }
    db = await client.updateDatabase(db.id, { properties: missing });
    return { how: 'chosen', databaseId: db.id, db, dbTitle: databaseTitle(db), missing: [], added: names };
  }

  if (kind === 'new') {
    const pageId = normalizeId(settings.parentPageId);
    if (!pageId) throw new Error('新建数据库需要先在设置页选一个 Notion 页面，新库会建在那个页面里。');
    const title = String(target.title || '').trim() || defaultTitle(type);
    if (!create) return { how: 'create', databaseId: null, dbTitle: title, missing: [], added: [] };
    const db = await client.createDatabase(pageId, schemaWithTitle(type, title));
    return { how: 'created', databaseId: db.id, db, dbTitle: databaseTitle(db), missing: [], added: [] };
  }

  throw new Error(`不认识的目标数据库：${kind}`);
}
