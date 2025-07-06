# 豆瓣同步到 Notion 插件

## 简介

**豆瓣同步到 Notion** 是一款浏览器扩展，可以帮助你一键将豆瓣上的图书、电影、电视剧信息高效、安全地导入到你的 Notion 数据库中。

## 主要功能

*   **一键同步:** 在豆瓣的条目页面，可以轻松将当前项目（图书、电影、电视剧）信息同步到 Notion。
*   **信息全面:** 自动抓取包括书名/电影名、封面、评分、简介、作者/导演等在内的关键信息。
*   **高度可定制:** 用户可以自行配置 Notion API Key 和 Database ID，将信息同步到指定的数据库。
*   **安全可靠:** 你的 Notion API Key 和配置信息将安全地存储在本地。

## 安装

1.  下载本项目的 `.zip` 压缩包并解压。
2.  打开 Chrome 浏览器，进入 `chrome://extensions/` 页面。
3.  启用右上角的 **“开发者模式”**。
4.  点击 **“加载已解压的扩展程序”**，然后选择刚刚解压的文件夹。

## 配置

1.  点击浏览器工具栏中的插件图标，打开设置页面。
2.  在设置页面中，你需要填入以下两项信息：
    *   **Notion API Key:** 你可以在 [Notion 的集成页面](https://www.notion.so/my-integrations) 创建一个新的集成来获取 API Key。
    *   **Database ID:** 这是你希望用来存储豆瓣数据的 Notion 数据库的 ID。
3.  填写完毕后，点击保存。

## 使用方法

1.  配置完成后，访问任意一个豆瓣图书或电影的条目页面（例如 `https://book.douban.com/subject/...` 或 `https://movie.douban.com/subject/...`）。
2.  在页面上，你会看到一个 “同步到 Notion” 的按钮。
3.  点击该按钮，插件会自动抓取页面信息并发送到你指定的 Notion 数据库。
4.  同步成功后，会有相应的提示。

## 权限说明

本插件需要以下权限以正常工作：

*   `storage`: 用于在本地安全地存储你的 Notion API Key 和 Database ID。
*   `activeTab` 和 `scripting`: 用于在当前激活的豆瓣页面上执行脚本，以抓取信息和显示同步按钮。
*   `host_permissions` (`https://*.douban.com/*`, `https://api.notion.com/*`): 用于向豆瓣页面注入脚本，并与 Notion API 进行通信。

## 如何贡献

欢迎为此项目做出贡献！你可以通过以下方式参与：

1.  **报告 Bug:** 如果你发现了任何问题，请在 [Issues](https://github.com/your-username/your-repo-name/issues) 中提交详细的报告。
2.  **提出建议:** 如果你有任何关于新功能或改进的建议，也欢迎在 [Issues](https://github.com/your-username/your-repo-name/issues) 中提出。
3.  **提交代码:** 如果你希望直接贡献代码，请遵循以下步骤：
    1.  Fork 本仓库。
    2.  创建一个新的分支 (`git checkout -b feature/your-feature-name`)。
    3.  提交你的代码 (`git commit -m 'Add some feature'`)。
    4.  将你的分支推送到远程仓库 (`git push origin feature/your-feature-name`)。
    5.  创建一个 Pull Request。

## 许可证

本项目采用 [MIT](LICENSE) 许可证。
