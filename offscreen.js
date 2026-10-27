// 离屏文档：后台脚本没有 DOM，自动同步时把豆瓣详情页交给这里解析。
import { scrapeDouban } from './scraper.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false; // 其他消息不归这里管
  if (msg.action === 'parseSubject') {
    try {
      const doc = new DOMParser().parseFromString(msg.html, 'text/html');
      sendResponse({ success: true, data: scrapeDouban(doc, msg.url) });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  }
  return false;
});
