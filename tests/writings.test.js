import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWritingBlocks, chunk, decodeEntities, htmlToParagraphs, normalizeWritingUrl, writingUrlsIn } from '../writings.js';

test('实体解码', () => {
  assert.equal(decodeEntities('A &amp; B &lt;3 &#39;x&#39; &#x4E2D;&nbsp;'), "A & B <3 'x' 中 ");
});

test('豆瓣书评的 HTML（br 分段）→ 段落', () => {
  const html = "<div id='content'>第一段。<br><br>第二段第一行<br>第二段第二行<br><br>  </div>";
  const { paragraphs } = htmlToParagraphs(html);
  assert.deepEqual(paragraphs.map((p) => p.text), ['第一段。', '第二段第一行\n第二段第二行']);
});

test('笔记的 HTML（p 分段）、引用、图片', () => {
  const html = '<p>正文</p><blockquote>原文摘抄<br>第二行</blockquote><p>评论 <img src="x.jpg"> 结束</p><img src="y.jpg">';
  const { paragraphs, images } = htmlToParagraphs(html);
  assert.deepEqual(paragraphs, [
    { text: '正文', quote: false },
    { text: '原文摘抄\n第二行', quote: true },
    { text: '评论  结束', quote: false },
  ]);
  assert.equal(images, 2);
});

test('生成的块：评论标题带原文链接，笔记放在“我的读书笔记”下', () => {
  const blocks = buildWritingBlocks([
    { kind: 'note', url: 'https://book.douban.com/annotation/1/', title: '第1页 标题', date: '2012-08-31', html: '<p>笔记</p>' },
    { kind: 'review', url: 'https://book.douban.com/review/2/', title: '关于生命', date: '2009-12-01', html: '内容<img src="a">' },
  ]);
  assert.deepEqual(blocks.map((b) => b.type), ['heading_2', 'paragraph', 'paragraph', 'paragraph', 'heading_2', 'heading_3', 'paragraph', 'paragraph']);
  assert.equal(blocks[0].heading_2.rich_text[1].text.link.url, 'https://book.douban.com/review/2/');
  assert.match(blocks[3].paragraph.rich_text[0].text.content, /1 张图片/);
});

test('重新导入时，认出页面里已经放过的', () => {
  const blocks = buildWritingBlocks([{ kind: 'review', url: 'https://book.douban.com/review/2/', title: 't', html: 'x' }]);
  // Notion 读回来时链接在 href 上
  const readBack = [{ type: 'heading_2', heading_2: { rich_text: [{ plain_text: 't', href: 'http://book.douban.com/review/2' }] } }];
  assert.ok(writingUrlsIn(blocks).has('https://book.douban.com/review/2/'));
  assert.ok(writingUrlsIn(readBack).has(normalizeWritingUrl('https://book.douban.com/review/2/')));
});

test('分批', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
