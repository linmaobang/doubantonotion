import { STATUS_LABELS } from './config.js';

// 从个人主页链接或直接输入里取出豆瓣用户 ID
// 支持 https://www.douban.com/people/ahbei/、https://book.douban.com/people/123/collect、ahbei
export function parseUserId(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/people\/([^/?#\s]+)/);
  if (m) return decodeURIComponent(m[1]);
  return /^[\w.-]+$/.test(s) ? s : '';
}

// 用于判断“Notion 里是不是已经有这一条”：book:1084336 / movie:1292052
export function subjectKey(url) {
  const m = String(url || '').match(/(book|movie)\.douban\.com\/subject\/(\d+)/);
  return m ? `${m[1]}:${m[2]}` : null;
}

const names = (list) => (list || []).map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
const join = (list) => names(list).join(' / ');

// 把移动端列表接口返回的一条标记，转成和 scraper.js 相同结构的信息
export function infoFromInterest(interest) {
  const s = interest.subject || {};
  const type = s.type === 'book' ? 'book' : s.subtype === 'tv' || s.type === 'tv' ? 'tv' : 'movie';
  const rating = s.rating?.value ? String(s.rating.value) : '';

  const base = {
    type,
    id: String(s.id),
    title: s.title || '',
    url: s.url || `https://${type === 'book' ? 'book' : 'movie'}.douban.com/subject/${s.id}/`,
    cover: s.cover_url || s.pic?.large || s.pic?.normal || '',
    rating,
    summary: s.intro || '',
    // 我的标记
    mark: interest.status, // mark / doing / done，用于筛选；不会写进 Notion
    status: STATUS_LABELS[type][interest.status] || '',
    my_rating: interest.rating?.value ? String(interest.rating.value) : '',
    marked_date: (interest.create_time || '').slice(0, 10),
    comment: interest.comment || '',
    my_tags: interest.tags || [],
  };

  if (type === 'book') {
    return {
      ...base,
      subtitle: s.book_subtitle || '',
      author: join(s.author),
      publisher: join(s.press),
      pubdate: (s.pubdate || [])[0] || '',
      pages: (s.pages || [])[0] || '',
    };
  }
  const dates = (s.pubdate || []).join(' / ');
  return {
    ...base,
    year: s.year || '',
    director: join(s.directors),
    actors: join(s.actors),
    genres: s.genres || [],
    ...(type === 'tv' ? { first_air_date: dates } : { release_date: dates }),
  };
}

const USER_FIELDS = ['status', 'my_rating', 'marked_date', 'comment', 'my_tags', 'source'];

// 用详情页抓到的完整信息补全列表数据。详情页没有的字段（比如我的标记）保留列表里的值。
export function mergeDetail(fromList, fromPage) {
  const merged = { ...fromList };
  for (const [key, value] of Object.entries(fromPage || {})) {
    if (USER_FIELDS.includes(key) || key === 'error') continue;
    // 类型以列表为准；只有列表里分不清电影还是剧集时，才用详情页的判断
    if (key === 'type' && !fromList.typeGuess) continue;
    const empty = value === '' || value == null || (Array.isArray(value) && value.length === 0);
    if (!empty) merged[key] = value;
  }
  delete merged.typeGuess;
  return merged;
}

// 判断详情页请求有没有被豆瓣拦下，分两种：
// - 'challenge'：跳到了 sec.douban.com 之类的验证页。验证要在浏览器里跑脚本才能通过，
//   干等没用，只能请用户打开豆瓣页面让它自动通过（或手动验证）。
// - 'rate'：403/418/429，请求太频繁，等一会儿通常就好。
// 404（条目已被删除）不算被拦，由调用方单独处理。
export function blockKind({ status, finalUrl, html }) {
  if (status === 404) return null;
  if (status === 403 || status === 418 || status === 429) return 'rate';
  if (/sec\.douban\.com|accounts\.douban\.com|\/misc\/sorry/.test(finalUrl || '')) return 'challenge';
  return /id="info"/.test(html || '') ? null : 'challenge';
}
