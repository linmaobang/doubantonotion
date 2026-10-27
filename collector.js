// 从任意豆瓣列表页（豆列、标签、Top250、别人的收藏、选电影……）里收集条目。
// 和 scraper.js 一样有两种用法：
// 1. 弹窗注入当前页面运行（不传参数）——能拿到“加载更多”之后由脚本渲染出来的条目；
// 2. 导入页对后台拉回来的 HTML 用 DOMParser 解析后调用。
// 因为第 1 种用法，它必须完全自包含。
export function collectSubjects(doc = document, href = location.href) {
  const SUBJECT = /^https?:\/\/(book|movie)\.douban\.com\/subject\/(\d+)/;
  const DISPATCH = /douban\.com\/doubanapp\/dispatch\/?\?uri=\/(book|movie|tv)\/(\d+)/;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const abs = (h) => {
    try {
      return new URL(h, href).href;
    } catch {
      return '';
    }
  };

  // 只看主栏，避免把侧栏的“猜你喜欢”“相关推荐”也收进来
  const candidates = [doc.querySelector('#content .article'), doc.querySelector('#content'), doc.querySelector('#app'), doc.body];
  const countLinks = (root) =>
    root ? [...root.querySelectorAll('a[href]')].filter((a) => SUBJECT.test(abs(a.getAttribute('href'))) || DISPATCH.test(a.getAttribute('href'))).length : 0;
  const root = candidates.find((r) => countLinks(r) > 0) || doc.body;

  const CONTAINER = 'li, tr, .item, .doulist-item, .subject-item, .drc-subject-card, .grid-view > div';
  const TITLE_IN_CONTAINER = '.drc-subject-info-title-text, .title a, .pl2 a, h2 a, .info a, .item-title';
  const RATING_IN_CONTAINER = '.rating_nums, .rating_num, .rating-nums';

  const map = new Map();
  for (const a of root.querySelectorAll('a[href]')) {
    const raw = a.getAttribute('href');
    const url = abs(raw);
    let m = url.match(SUBJECT);
    let host;
    let id;
    let type;
    if (m) {
      [, host, id] = m;
      type = host === 'book' ? 'book' : 'movie';
    } else if ((m = raw.match(DISPATCH) || url.match(DISPATCH))) {
      id = m[2];
      host = m[1] === 'book' ? 'book' : 'movie';
      type = m[1];
    } else {
      continue;
    }
    const key = `${host}:${id}`;
    const item = map.get(key) || {
      key,
      type,
      // 电影域名下的链接可能是剧集，抓详情页时再确定
      typeGuess: type === 'movie',
      url: `https://${host}.douban.com/subject/${id}/`,
      title: '',
      cover: '',
      rating: '',
    };
    if (type === 'tv') item.typeGuess = false;

    const box = a.closest(CONTAINER);
    if (!item.title) {
      // 只有封面图的链接没有文字，这时从同一个条目框里找标题
      const inBox = box?.querySelector(TITLE_IN_CONTAINER);
      const fromBox = clean(inBox?.getAttribute('title') || inBox?.textContent);
      const fromAttr = clean(a.getAttribute('title'));
      const fromText = a.querySelector('img') ? '' : clean(a.textContent);
      // Top250 之类会把别名都列出来：“肖申克的救赎 / The Shawshank Redemption / …”，只留第一个
      item.title = (fromAttr || fromText || fromBox || '').split(' / ')[0].trim();
    }
    if (!item.cover) {
      const img = a.querySelector('img') || box?.querySelector('img');
      const src = img?.getAttribute('src') || '';
      if (/doubanio\.com\/view\//.test(src)) item.cover = abs(src);
    }
    if (!item.rating && box) {
      const r = clean(box.querySelector(RATING_IN_CONTAINER)?.textContent);
      if (/^\d+(\.\d+)?$/.test(r)) item.rating = r;
    }
    map.set(key, item);
  }

  // 下一页
  const nextEl = doc.querySelector('.paginator .next a[href], .paginator span.next a[href], link[rel="next"]');
  const next = nextEl ? abs(nextEl.getAttribute('href')) : null;
  const pager = doc.querySelector('.paginator');
  const totalPages =
    Number(pager?.querySelector('[data-total-page]')?.dataset.totalPage) ||
    Math.max(0, ...[...(pager?.querySelectorAll('a, span') || [])].map((e) => Number(clean(e.textContent)) || 0)) ||
    1;
  const hasLoadMore = !next && [...doc.querySelectorAll('button, a, span')].some((e) => clean(e.textContent) === '加载更多');

  const name = clean(doc.querySelector('#content h1, h1')?.textContent) || clean(doc.title.replace(/\s*\(豆瓣\)\s*$/, ''));
  return { name, url: href, items: [...map.values()].filter((i) => i.title), next, totalPages, hasLoadMore };
}

// 根据网址给来源起个短名字，写进 Notion 的“来源”字段
export function sourceLabel(url, name) {
  const short = (s) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
  const n = short((name || '').replace(/^豆瓣(图书|读书|电影)?标签[:：]\s*/, '').trim());
  if (/\/doulist\/\d+/.test(url)) return `豆列：${n}`;
  if (/\/tag\//.test(url)) return `标签：${n}`;
  if (/\/top250/.test(url)) return /book\./.test(url) ? '豆瓣读书 Top250' : '豆瓣电影 Top250';
  if (/\/people\/[^/]+\/(collect|wish|do)/.test(url)) return n;
  return n || '豆瓣页面';
}

// 我的读书笔记列表页：book.douban.com/people/{id}/annotation/
// 每本书一块（.annotations-item），标题链接到 /people/{id}/annotation/{书的编号}/，下面是笔记链接。
// 某本书笔记很多时，列表里只显示一部分，返回 moreUrl 让调用方再去那本书的笔记页读。
export function collectNotes(doc, href) {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const abs = (h) => new URL(h, href).href;
  const root = doc.querySelector('#content .article') || doc.body;
  // 某一本书的笔记页（/people/{id}/annotation/{书的编号}/）：书的编号在网址里
  const pageSid = href.match(/\/people\/[^/]+\/annotation\/(\d+)/)?.[1] || null;
  const books = new Map();
  for (const a of root.querySelectorAll('a[href*="/annotation/"]')) {
    const url = abs(a.getAttribute('href'));
    const noteId = url.match(/book\.douban\.com\/annotation\/(\d+)\/?$/)?.[1];
    if (!noteId) continue;
    const box = a.closest('.annotations-item');
    const head = box?.querySelector('h3 a');
    const sid = head?.getAttribute('href').match(/\/annotation\/(\d+)/)?.[1] || pageSid;
    if (!sid) continue;
    if (!books.has(sid)) {
      const count = Number(clean(head?.textContent).match(/\((\d+)\)\s*$/)?.[1]) || 0;
      books.set(sid, { sid, title: head?.getAttribute('title') || '', count, moreUrl: head ? abs(head.getAttribute('href')) : null, notes: [] });
    }
    const book = books.get(sid);
    if (!book.notes.some((n) => n.url === url)) {
      book.notes.push({ kind: 'note', id: noteId, url, title: clean(a.textContent), subjectUrl: `https://book.douban.com/subject/${sid}/` });
    }
  }
  const nextEl = doc.querySelector('.paginator .next a[href]');
  return { books: [...books.values()], next: nextEl ? abs(nextEl.getAttribute('href')) : null };
}

// 一条读书笔记的全文页：book.douban.com/annotation/{id}/
export function parseNote(doc) {
  const text = doc.body?.textContent || '';
  return {
    title: (doc.querySelector('h1')?.textContent || '').replace(/\s+/g, ' ').trim(),
    html: doc.querySelector('#link-report')?.innerHTML || '',
    date: text.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '',
  };
}
