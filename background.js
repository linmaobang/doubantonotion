async function fetchNotionAPI(url, options) {
  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Notion API Error:', response.status, errorBody);
      throw new Error(`HTTP error! status: ${response.status}, message: ${errorBody}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Fetch Error:', error);
    throw error;
  }
}

async function getDatabaseStructure(databaseId, notionToken) {
  const url = `https://api.notion.com/v1/databases/${databaseId}`;
  const options = {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${notionToken}`,
      'Notion-Version': '2022-06-28',
    },
  };
  return await fetchNotionAPI(url, options);
}

async function addToNotion(databaseId, properties, content, notionToken) {
  const url = 'https://api.notion.com/v1/pages';
  const options = {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${notionToken}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties,
      children: content,
    }),
  };
  return await fetchNotionAPI(url, options);
}

async function createDatabase(notionToken, parentPageId, schema) {
    const url = 'https://api.notion.com/v1/databases';
    const options = {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${notionToken}`,
            'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28',
        },
        body: JSON.stringify({
            parent: { page_id: parentPageId },
            ...schema
        }),
    };
    return await fetchNotionAPI(url, options);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      let responseData;
      switch (request.action) {
        case 'getDatabaseStructure':
          responseData = await getDatabaseStructure(request.databaseId, request.notionToken);
          break;
        case 'addToNotion':
          responseData = await addToNotion(request.databaseId, request.properties, request.content, request.notionToken);
          break;
        case 'createDatabase':
          responseData = await createDatabase(request.notionToken, request.parentPageId, request.schema);
          break;
        default:
          throw new Error(`Unknown action: ${request.action}`);
      }
      sendResponse({ success: true, data: responseData });
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
  })();
  return true; // Keep the message channel open for async sendResponse
});
