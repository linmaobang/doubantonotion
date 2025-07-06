import { bookMapping, movieMapping, tvMapping } from './config.js';

// --- Pre-defined Schemas for Database Creation ---
const SCHEMAS = {
    book: {
        title: [{ type: 'text', text: { content: '我的书库' } }],
        icon: { type: 'emoji', emoji: '📚' },
        properties: {
            '书名': { title: {} },
            '作者': { rich_text: {} },
            '封面': { files: {} },
            '评分': { number: { format: 'number' } },
            '标签': { multi_select: {} },
            '出版日期': { rich_text: {} },
            '出版社': { rich_text: {} },
            'ISBN': { rich_text: {} },
            '链接': { url: {} },
        }
    },
    movie: {
        title: [{ type: 'text', text: { content: '我的影院' } }],
        icon: { type: 'emoji', emoji: '🎬' },
        properties: {
            '片名': { title: {} },
            '导演': { rich_text: {} },
            '封面': { files: {} },
            '评分': { number: { format: 'number' } },
            '类型': { multi_select: {} },
            '上映日期': { rich_text: {} },
            '国家': { rich_text: {} },
            'IMDb': { rich_text: {} },
            '链接': { url: {} },
        }
    },
    tv: {
        title: [{ type: 'text', text: { content: '我的剧集' } }],
        icon: { type: 'emoji', emoji: '📺' },
        properties: {
            '剧名': { title: {} },
            '导演': { rich_text: {} },
            '封面': { files: {} },
            '评分': { number: { format: 'number' } },
            '类型': { multi_select: {} },
            '首播日期': { rich_text: {} },
            '国家': { rich_text: {} },
            '集数': { number: {} },
            '链接': { url: {} },
        }
    }
};

// --- DOM Elements ---
const notionTokenInput = document.getElementById('notionToken');
const parentPageIdInput = document.getElementById('parentPageId');
const bookDatabaseIdInput = document.getElementById('bookDatabaseId');
const movieDatabaseIdInput = document.getElementById('movieDatabaseId');
const tvDatabaseIdInput = document.getElementById('tvDatabaseId');
const saveSettingsButton = document.getElementById('saveSettings');
const verifyConnectionButton = document.getElementById('verifyConnection');
const itemTypeSelect = document.getElementById('itemType');
const getInfoButton = document.getElementById('getInfo');
const addToNotionButton = document.getElementById('addToNotion');
const createBookDbBtn = document.getElementById('createBookDb');
const createMovieDbBtn = document.getElementById('createMovieDb');
const createTvDbBtn = document.getElementById('createTvDb');
const statusDiv = document.getElementById('status');
const infoDiv = document.getElementById('infoDisplay');

let itemInfo = null;

const MAPPINGS = { book: bookMapping, movie: movieMapping, tv: tvMapping };

// --- Utility Functions ---
function setStatus(message, isError = false) {
    statusDiv.textContent = message;
    statusDiv.style.color = isError ? '#d9534f' : '#5cb85c';
}

function extractIdFromUrl(urlOrId) {
    if (!urlOrId) return '';
    const match = urlOrId.match(/([a-f0-9]{32})/);
    return match ? match[1] : urlOrId; // Return the extracted ID or the original string if no match
}

async function sendMessageToBackground(action, payload) {
    try {
        const response = await chrome.runtime.sendMessage({ action, ...payload });
        if (response.success) return response.data;
        throw new Error(response.error || 'Unknown background script error');
    } catch (error) {
        setStatus(`错误: ${error.message}`, true);
        console.error(`Error in ${action}:`, error);
        throw error;
    }
}

async function sendMessageToContentScript(action, payload) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("No active tab found.");
    try {
        const response = await chrome.tabs.sendMessage(tab.id, { action, ...payload });
        if (response.success) return response.data;
        throw new Error(response.error || 'Unknown content script error');
    } catch (error) {
        setStatus(`获取信息失败，请确保在正确的豆瓣页面并刷新重试。`, true);
        console.error(`Error sending message to content script:`, error);
        throw error;
    }
}

// --- Settings Management ---
async function saveSettings() {
    const settings = {
        notionToken: notionTokenInput.value.trim(),
        parentPageId: parentPageIdInput.value.trim(),
        bookDatabaseId: bookDatabaseIdInput.value.trim(),
        movieDatabaseId: movieDatabaseIdInput.value.trim(),
        tvDatabaseId: tvDatabaseIdInput.value.trim(),
    };
    if (!settings.notionToken) {
        setStatus('Notion Token 不能为空', true);
        return;
    }
    await chrome.storage.local.set(settings);
    setStatus('设置已保存!', false);
}

async function loadSettings() {
    const settings = await chrome.storage.local.get(['notionToken', 'parentPageId', 'bookDatabaseId', 'movieDatabaseId', 'tvDatabaseId']);
    notionTokenInput.value = settings.notionToken || '';
    parentPageIdInput.value = settings.parentPageId || '';
    bookDatabaseIdInput.value = settings.bookDatabaseId || '';
    movieDatabaseIdInput.value = settings.movieDatabaseId || '';
    tvDatabaseIdInput.value = settings.tvDatabaseId || '';
}

// --- Core Functions ---
async function getSettingsForCurrentType() {
    const type = itemTypeSelect.value;
    const dbIdKey = `${type}DatabaseId`;
    const settings = await chrome.storage.local.get(['notionToken', dbIdKey]);
    return { notionToken: settings.notionToken, databaseId: settings[dbIdKey], type };
}

async function verifyConnection() {
    const { notionToken, databaseId, type } = await getSettingsForCurrentType();
    if (!notionToken || !databaseId) {
        setStatus(`${type.toUpperCase()} 的 Token 或 Database ID 未设置`, true);
        return;
    }
    setStatus(`正在验证 ${type.toUpperCase()} 数据库...`, false);
    try {
        await sendMessageToBackground('getDatabaseStructure', { notionToken, databaseId });
        setStatus('连接成功!', false);
    } catch (error) {
        setStatus(`连接失败: ${error.message}`, true);
    }
}

async function getInfo() {
    const type = itemTypeSelect.value;
    setStatus(`正在获取${itemTypeSelect.options[itemTypeSelect.selectedIndex].text}信息...`, false);
    try {
        itemInfo = await sendMessageToContentScript('getInfo', { type });
        displayInfo(itemInfo);
        setStatus('信息获取成功!', false);
    } catch (error) { /* Status already set */ }
}

async function addToNotion() {
    if (!itemInfo) {
        setStatus('请先获取信息', true);
        return;
    }
    const { notionToken, databaseId, type } = await getSettingsForCurrentType();
    if (!notionToken || !databaseId) {
        setStatus(`${type.toUpperCase()} 的 Token 或 Database ID 未设置`, true);
        return;
    }
    setStatus('正在添加到 Notion...', false);
    try {
        const dbStructure = await sendMessageToBackground('getDatabaseStructure', { notionToken, databaseId });
        const properties = mapInfoToNotionProperties(itemInfo, dbStructure.properties, type);
        const content = createPageContent(itemInfo);
        await sendMessageToBackground('addToNotion', { notionToken, databaseId, properties, content });
        setStatus('成功添加到 Notion!', false);
    } catch (error) {
        setStatus(`添加到 Notion 失败: ${error.message}`, true);
    }
}

async function createDatabase(type) {
    const notionToken = notionTokenInput.value.trim();
    const parentPageUrlOrId = parentPageIdInput.value.trim();
    const parentPageId = extractIdFromUrl(parentPageUrlOrId);
    const dbIdInput = document.getElementById(`${type}DatabaseId`);
    const existingDbId = dbIdInput.value.trim();

    if (!notionToken || !parentPageId) {
        setStatus('请先填写 Notion Token 和有效的父页面ID或URL', true);
        return;
    }

    let confirmationMessage = `确定要在父页面下创建新的 ${type.toUpperCase()} 数据库吗？`;
    if (existingDbId) {
        confirmationMessage = `一个 ${type.toUpperCase()} 数据库ID已经存在。您确定要创建一个新的数据库吗？这将会替换掉输入框中的旧ID。`;
    }

    if (!confirm(confirmationMessage)) {
        return;
    }

    setStatus(`正在创建 ${type.toUpperCase()} 数据库...`, false);
    try {
        const schema = SCHEMAS[type];
        const newDb = await sendMessageToBackground('createDatabase', { notionToken, parentPageId, schema });
        dbIdInput.value = newDb.id;
        await saveSettings();
        setStatus(`${type.toUpperCase()} 数据库创建成功!`, false);
    } catch (error) {
        setStatus(`创建失败: ${error.message}`, true);
    }
}

// --- Data Mapping and Formatting ---
function mapInfoToNotionProperties(info, dbProperties, type) {
    const mapping = MAPPINGS[type];
    if (!mapping) return {};
    const mapped = {};
    for (const [key, value] of Object.entries(info)) {
        if (!value || key === 'summary' || key === 'catalog') continue;
        const notionField = findNotionField(key, dbProperties, mapping);
        if (notionField) {
            const formatted = formatPropertyValue(value, dbProperties[notionField].type, key);
            if (formatted) mapped[notionField] = formatted;
        }
    }
    return mapped;
}

function findNotionField(fieldKey, dbProperties, mapping) {
    const possibleNames = mapping[fieldKey] || [fieldKey];
    for (const name of possibleNames) {
        const found = Object.keys(dbProperties).find(prop => prop.toLowerCase() === name.toLowerCase());
        if (found) return found;
    }
    return null;
}

function formatPropertyValue(value, propType, fieldKey) {
    try {
        switch (propType) {
            case 'title': return { title: [{ text: { content: String(value) } }] };
            case 'rich_text': return { rich_text: [{ text: { content: String(value) } }] };
            case 'number': return { number: parseFloat(value) || null };
            case 'select': return { select: { name: String(value) } };
            case 'multi_select': return Array.isArray(value) ? { multi_select: value.map(item => ({ name: String(item) })) } : { multi_select: [{ name: String(value) }] };
            case 'date': return { date: { start: new Date(value).toISOString().split('T')[0] } };
            case 'url': return { url: String(value) };
            case 'files': return fieldKey === 'cover' ? { files: [{ name: "Cover", type: "external", external: { url: value } }] } : null;
            default: return null;
        }
    } catch (e) { return null; }
}

function createPageContent(info) {
    const content = [];
    if (info.summary) {
        content.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: '简介' } }] } });
        content.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: info.summary } }] } });
    }
    return content;
}

function displayInfo(info) {
    const typeText = itemTypeSelect.options[itemTypeSelect.selectedIndex].text;
    let html = `<h2>${typeText}信息:</h2>`;
    for (const [key, value] of Object.entries(info)) {
        if (key === 'cover') {
            html += `<p><strong>${key}:</strong> <img src="${value}" alt="cover" style="max-width: 100px;"></p>`;
        } else {
            html += `<p><strong>${key}:</strong> ${Array.isArray(value) ? value.join(' / ') : value}</p>`;
        }
    }
    infoDiv.innerHTML = html;
}

// --- Event Listeners & Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    saveSettingsButton.addEventListener('click', saveSettings);
    verifyConnectionButton.addEventListener('click', verifyConnection);
    getInfoButton.addEventListener('click', getInfo);
    addToNotionButton.addEventListener('click', addToNotion);
    createBookDbBtn.addEventListener('click', () => createDatabase('book'));
    createMovieDbBtn.addEventListener('click', () => createDatabase('movie'));
    createTvDbBtn.addEventListener('click', () => createDatabase('tv'));

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab.url || '';

    if (url.includes('book.douban.com/subject/')) {
        itemTypeSelect.value = 'book';
    } else if (url.includes('movie.douban.com/subject/')) {
        itemTypeSelect.value = 'movie';
    } else {
        getInfoButton.disabled = true;
        addToNotionButton.disabled = true;
        setStatus('请在豆瓣条目详情页使用本插件', true);
    }
});
