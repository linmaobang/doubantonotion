console.log("Douban to Notion content script loaded.");

function getBookInfo() {
    try {
        const infoEl = document.getElementById('info');
        if (!infoEl) return { error: "未能找到图书信息元素 (#info)。" };

        const infoText = infoEl.innerText;
        const getInfoByRegex = (regex) => {
            const match = infoText.match(regex);
            return match ? match[1].trim() : '';
        };

        const getAuthors = () => {
            const authorEl = Array.from(infoEl.querySelectorAll('span.pl')).find(el => el.textContent.includes('作者'));
            if (!authorEl || !authorEl.parentElement) return getInfoByRegex(/(?:作者:)\s*(.*)/);
            const links = authorEl.parentElement.querySelectorAll('a');
            return links.length > 0 ? Array.from(links).map(a => a.textContent.trim()).join(' / ') : authorEl.parentElement.innerText.replace(/作者:/, '').trim();
        };

        return {
            title: document.querySelector("h1 span[property='v:itemreviewed']")?.innerText.trim() || '',
            cover: document.querySelector("#mainpic img")?.src || '',
            rating: document.querySelector("strong.rating_num")?.innerText.trim() || '',
            url: window.location.href,
            author: getAuthors(),
            translator: getInfoByRegex(/(?:译者:)\s*(.*)/),
            publisher: getInfoByRegex(/(?:出版社:)\s*(.*)/),
            production_company: getInfoByRegex(/(?:出品方:)\s*(.*)/),
            pubdate: getInfoByRegex(/(?:出版年:)\s*(.*)/),
            pages: getInfoByRegex(/(?:页数:)\s*(.*)/),
            price: getInfoByRegex(/(?:定价:)\s*(.*)/),
            binding: getInfoByRegex(/(?:装帧:)\s*(.*)/),
            isbn: getInfoByRegex(/(?:ISBN:)\s*(.*)/),
            series: getInfoByRegex(/(?:丛书:)\s*(.*)/),
            original_title: getInfoByRegex(/(?:原作名:)\s*(.*)/),
            summary: document.querySelector("#link-report .intro")?.innerText || '',
            tags: Array.from(document.querySelectorAll('#db-tags-section .tag')).map(el => el.innerText.trim()),
        };
    } catch (error) { return { error: error.message }; }
}

function getMovieInfo() {
    try {
        const infoEl = document.getElementById('info');
        if (!infoEl) return { error: "未能找到电影信息元素 (#info)。" };

        const getSpanText = (label) => {
            const el = Array.from(infoEl.querySelectorAll('span.pl')).find(e => e.innerText.trim() === label);
            return el ? el.nextSibling.textContent.trim() : '';
        };

        const getInfoByAttribute = (prop) => Array.from(infoEl.querySelectorAll(`span[property="${prop}"]`)).map(el => el.innerText).join(' / ');

        return {
            title: document.querySelector("h1 span[property='v:itemreviewed']")?.innerText.trim() || '',
            cover: document.querySelector("#mainpic img")?.src || '',
            rating: document.querySelector("strong.rating_num")?.innerText.trim() || '',
            url: window.location.href,
            director: getInfoByAttribute('v:directedBy'),
            screenwriter: getSpanText('编剧'),
            actors: getInfoByAttribute('v:starring'),
            genres: getInfoByAttribute('v:genre'),
            country: getSpanText('制片国家/地区:'),
            production_company: getSpanText('出品方:') || getSpanText('制作公司:'),
            language: getSpanText('语言:'),
            release_date: getInfoByAttribute('v:initialReleaseDate'),
            runtime: getInfoByAttribute('v:runtime'),
            imdb: infoEl.innerText.match(/IMDb: (tt\d+)/)?.[1] || '',
            summary: document.querySelector("span[property='v:summary']")?.innerText.trim() || '',
            tags: Array.from(document.querySelectorAll('.tags-body a')).map(el => el.innerText.trim()),
        };
    } catch (error) { return { error: error.message }; }
}

function getTvInfo() {
    // 电视剧和电影的页面结构非常相似，可以直接复用电影的抓取逻辑
    const movieData = getMovieInfo();
    if(movieData.error) return movieData; // 如果出错，直接返回错误

    const infoEl = document.getElementById('info');
    const infoText = infoEl.innerText;
    const getInfoByRegex = (regex) => {
        const match = infoText.match(regex);
        return match ? match[1].trim() : '';
    };

    // 补充电视剧特有的字段
    movieData.first_air_date = getInfoByRegex(/(?:首播:)\s*(.*)/);
    movieData.episodes = getInfoByRegex(/(?:集数:)\s*(.*)/);
    movieData.episode_runtime = getInfoByRegex(/(?:单集片长:)\s*(.*)/);

    return movieData;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getInfo") {
        let info;
        switch (request.type) {
            case 'book':
                info = getBookInfo();
                break;
            case 'movie':
                info = getMovieInfo();
                break;
            case 'tv':
                info = getTvInfo();
                break;
            default:
                info = { error: "未知的类型" };
        }

        if (info.error) {
            sendResponse({ success: false, error: info.error });
        } else {
            sendResponse({ success: true, data: info });
        }
    }
    return true; // Keep channel open for async response
});
