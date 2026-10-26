// 在豆瓣条目页面里运行的抓取函数。
// 它会通过 chrome.scripting.executeScript({ func }) 注入页面，
// 所以必须完全自包含：不能引用这个文件里的任何其他变量。
export function scrapeDouban() {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // 把元素转成纯文本，保留 <br> 和 <p> 带来的换行
  const textWithBreaks = (el) => {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    clone.querySelectorAll('p').forEach((p) => p.append('\n'));
    return clone.textContent
      .split('\n')
      .map((line) => line.replace(/^[\s　]+|[\s　]+$/g, ''))
      .filter(Boolean)
      .join('\n');
  };

  // 解析 #info 区块：每个 <br> 分隔一行 "标签: 值"
  const parseInfo = (infoEl) => {
    const fields = {};
    if (!infoEl) return fields;
    const clone = infoEl.cloneNode(true);
    clone.querySelectorAll('.more-attrs').forEach((el) => el.remove());
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\u0001'));
    for (const rawLine of clone.textContent.split('\u0001')) {
      const line = rawLine.replace(/\s+/g, ' ').trim();
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const label = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (label && value && !(label in fields)) fields[label] = value;
    }
    return fields;
  };

  // 取某个 h2 标题（如“内容简介”“作者简介”）下面的完整介绍文字
  const introAfter = (headingText) => {
    const h2 = $$('.related_info h2, .article h2').find((h) => h.textContent.includes(headingText));
    const box = h2?.nextElementSibling;
    if (!box) return '';
    const intro = $('.all .intro', box) || $('.intro', box) || box;
    return textWithBreaks(intro).replace(/\(展开全部\)\s*$/, '').trim();
  };

  const splitList = (s) => (s ? s.split('/').map((x) => x.trim()).filter(Boolean) : []);

  const url = (() => {
    const m = location.href.match(/^https:\/\/(book|movie)\.douban\.com\/subject\/(\d+)/);
    return m ? `https://${m[1]}.douban.com/subject/${m[2]}/` : location.href;
  })();

  const infoEl = document.getElementById('info');
  if (!infoEl) return { error: '没有在页面上找到条目信息，请确认这是豆瓣图书/电影/剧集的详情页。' };
  const f = parseInfo(infoEl);

  const isBook = location.hostname === 'book.douban.com';
  const isTv = !isBook && ('集数' in f || '首播' in f || '单集片长' in f);
  const fullName = $("h1 span[property='v:itemreviewed']")?.textContent.trim() || '';
  const shortName = document.title.replace(/\s*\(豆瓣\)\s*$/, '').trim();
  const title = shortName || fullName;

  const base = {
    type: isBook ? 'book' : isTv ? 'tv' : 'movie',
    title,
    url,
    cover: $('#mainpic img')?.src || '',
    rating: $('strong.rating_num')?.textContent.trim() || '',
  };

  if (isBook) {
    // 豆瓣已经去掉了图书页的标签区块，标签现在只出现在页面脚本的 criteria 里
    const criteria = $$('script')
      .map((s) => s.textContent.match(/criteria\s*=\s*'([^']*)'/)?.[1])
      .find(Boolean) || '';
    const tags = criteria
      .split('|')
      .filter((x) => x.startsWith('7:'))
      .map((x) => x.slice(2).trim())
      .filter((t) => t && t !== title);

    return {
      ...base,
      subtitle: f['副标题'] || '',
      author: f['作者'] || '',
      translator: f['译者'] || '',
      publisher: f['出版社'] || '',
      production_company: f['出品方'] || '',
      pubdate: f['出版年'] || '',
      pages: f['页数'] || '',
      price: f['定价'] || '',
      binding: f['装帧'] || '',
      isbn: f['ISBN'] || '',
      series: f['丛书'] || '',
      original_title: f['原作名'] || '',
      tags,
      summary: introAfter('内容简介'),
      author_intro: introAfter('作者简介'),
    };
  }

  const fullSummary = $('#link-report-intra span.all') || $('#link-report span.all');
  const summary = textWithBreaks(fullSummary || $("span[property='v:summary']"));
  const year = $('h1 .year')?.textContent.replace(/[()（）]/g, '').trim() || '';
  const originalTitle = fullName.startsWith(title) ? fullName.slice(title.length).trim() : '';

  const common = {
    ...base,
    original_title: originalTitle,
    year,
    director: f['导演'] || '',
    screenwriter: f['编剧'] || '',
    actors: f['主演'] || '',
    genres: splitList(f['类型']),
    country: f['制片国家/地区'] || '',
    language: f['语言'] || '',
    aka: f['又名'] || '',
    imdb: f['IMDb'] || '',
    tags: $$('.tags-body a').map((a) => a.textContent.trim()).filter(Boolean),
    summary,
  };

  if (isTv) {
    return {
      ...common,
      first_air_date: f['首播'] || '',
      episodes: f['集数'] || '',
      episode_runtime: f['单集片长'] || '',
      seasons: f['季数'] || '',
    };
  }
  return {
    ...common,
    release_date: f['上映日期'] || '',
    runtime: f['片长'] || '',
  };
}
