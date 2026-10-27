// 批量导入的筛选和勾选逻辑（不碰页面，方便测试）

export const EMPTY_FILTERS = {
  types: [], // 空 = 全部
  marks: [], // mark / doing / done，空 = 全部
  year: '', // 标记年份，'' = 全部
  rating: '', // '' 全部，'1'~'5'，'none' 未评分
  query: '',
  show: 'all', // all / new / existing
  sort: '', // 见 sortItems
};

export function markYear(item) {
  return (item.marked_date || '').slice(0, 4);
}

// 所有出现过的标记年份，新的在前
export function yearsOf(items) {
  return [...new Set(items.map(markYear).filter(Boolean))].sort().reverse();
}

export function filterItems(items, filters = EMPTY_FILTERS) {
  const q = (filters.query || '').trim().toLowerCase();
  return items.filter((item) => {
    if (filters.types?.length && !filters.types.includes(item.type)) return false;
    if (filters.marks?.length && !filters.marks.includes(item.mark)) return false;
    if (filters.year && markYear(item) !== filters.year) return false;
    if (filters.rating === 'none' && item.my_rating) return false;
    if (filters.rating && filters.rating !== 'none' && item.my_rating !== filters.rating) return false;
    if (filters.show === 'new' && item.exists) return false;
    if (filters.show === 'existing' && !item.exists) return false;
    if (q) {
      const hay = [item.title, item.original_title, item.subtitle, item.author, item.director]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// 默认勾选：所有还没进 Notion 的
export function defaultSelection(items) {
  return new Set(items.filter((i) => !i.exists).map((i) => i.key));
}

export function summarizeSelection(items, selected) {
  let toCreate = 0;
  let toUpdate = 0;
  for (const item of items) {
    if (!selected.has(item.key)) continue;
    if (item.exists) toUpdate++;
    else toCreate++;
  }
  return { total: toCreate + toUpdate, toCreate, toUpdate };
}

// 排序：'' 保持原顺序（豆瓣列表的顺序）
export function sortItems(items, sort) {
  const list = [...items];
  const num = (v) => Number(v) || 0;
  switch (sort) {
    case 'marked':
      return list.sort((a, b) => (b.marked_date || '').localeCompare(a.marked_date || ''));
    case 'mine':
      return list.sort((a, b) => num(b.my_rating) - num(a.my_rating));
    case 'douban':
      return list.sort((a, b) => num(b.rating) - num(a.rating));
    case 'title':
      return list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-Hans-CN'));
    default:
      return list;
  }
}

// Shift 连选：返回从上次点击到这次点击之间（含两端）的条目
export function rangeBetween(items, fromKey, toKey) {
  const a = items.findIndex((i) => i.key === fromKey);
  const b = items.findIndex((i) => i.key === toKey);
  if (a < 0 || b < 0) return [];
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return items.slice(lo, hi + 1);
}
