// 我在豆瓣写的书评 / 影评、读书笔记 → Notion 页面正文。
// 这里都是纯函数（不碰 DOM），后台脚本里也能用。
import { richText } from './notion.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const QUOTE_START = '\u0002';
const QUOTE_END = '\u0003';

// 豆瓣正文的 HTML → 段落（引用单独标出）。图片只计数，不搬运
export function htmlToParagraphs(html) {
  let images = 0;
  let s = String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<img\b[^>]*>/gi, () => {
      images++;
      return '';
    })
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => `\n\n${QUOTE_START}${inner}${QUOTE_END}\n\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|pre|section)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s).replace(/\r/g, '');
  const paragraphs = s
    .split(/\n{2,}/)
    .map((p) => p.split('\n').map((l) => l.replace(/^[\s　]+|[\s　]+$/g, '')).filter(Boolean).join('\n'))
    .filter((p) => p.replace(/[\u0002\u0003]/g, '').trim())
    .map((p) => {
      const quote = p.includes(QUOTE_START) || p.includes(QUOTE_END);
      return { text: p.replace(/[\u0002\u0003]/g, '').trim(), quote };
    });
  return { paragraphs, images };
}

const block = (type, rich) => ({ object: 'block', type, [type]: { rich_text: rich } });
const linkText = (text, url) => [{ type: 'text', text: { content: text.slice(0, 2000), link: url ? { url } : null } }];

function contentBlocks(html, url) {
  const { paragraphs, images } = htmlToParagraphs(html);
  const blocks = paragraphs.map((p) => block(p.quote ? 'quote' : 'paragraph', richText(p.text)));
  if (images) blocks.push(block('paragraph', linkText(`（原文里有 ${images} 张图片，点这里看原文）`, url)));
  return blocks.slice(0, 90); // 单篇最多放 90 段，免得一页太长
}

/**
 * writings: [{ kind: 'review' | 'note', url, title, date, html, page? }]
 * 书评每篇一个二级标题；笔记统一放在“读书笔记”下面，每条一个三级标题。
 * 标题都带原文链接——之后重新导入时，靠这个链接判断哪些已经放过了。
 */
export function buildWritingBlocks(writings) {
  const blocks = [];
  for (const w of writings.filter((x) => x.kind === 'review')) {
    blocks.push(block('heading_2', [{ type: 'text', text: { content: '我的评论：' } }, ...linkText(w.title || '（无题）', w.url)]));
    if (w.date) blocks.push(block('paragraph', [{ type: 'text', text: { content: w.date }, annotations: { color: 'gray' } }]));
    blocks.push(...contentBlocks(w.html, w.url));
  }
  const notes = writings.filter((x) => x.kind === 'note');
  if (notes.length) {
    blocks.push(block('heading_2', [{ type: 'text', text: { content: '我的读书笔记' } }]));
    for (const n of notes) {
      blocks.push(block('heading_3', linkText(n.title || '（无题）', n.url)));
      if (n.date) blocks.push(block('paragraph', [{ type: 'text', text: { content: n.date }, annotations: { color: 'gray' } }]));
      blocks.push(...contentBlocks(n.html, n.url));
    }
  }
  return blocks;
}

// 页面里已经放过的书评 / 笔记（看标题上的原文链接）
export function writingUrlsIn(blocks) {
  const urls = new Set();
  for (const b of blocks || []) {
    const rich = b[b.type]?.rich_text || [];
    for (const r of rich) {
      const href = r.href || r.text?.link?.url;
      if (href) urls.add(normalizeWritingUrl(href));
    }
  }
  return urls;
}

export function normalizeWritingUrl(url) {
  return String(url).replace(/^http:/, 'https:').replace(/[?#].*$/, '').replace(/\/?$/, '/');
}

// Notion 一次最多追加 100 个块
export function chunk(list, size = 100) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
