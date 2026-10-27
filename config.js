// 豆瓣字段 → Notion 数据库字段名的候选列表。
// 同步时按顺序（不区分大小写）在你的数据库里找第一个存在的字段名，
// 所以你可以用自己习惯的字段名，只要它在下面的列表里。
const COMMON = {
  title: ['标题', 'Name', 'title', '名称'],
  rating: ['评分', '豆瓣评分', 'rating', 'score'],
  tags: ['标签', 'tags', 'category'],
  url: ['链接', '豆瓣链接', 'url', 'link'],
  cover: ['封面', 'cover', 'image', 'poster'],
  summary: ['简介', 'summary', 'plot'],
  // 以下是“我的标记”，只在批量导入时有值
  status: ['状态', '阅读状态', '观看状态', 'status'],
  my_rating: ['我的评分', 'my rating'],
  marked_date: ['标记日期', '标记时间', 'date marked'],
  comment: ['短评', '我的短评', 'comment'],
  my_tags: ['我的标签', 'my tags'],
  // 从豆列、标签等页面批量导入时，记下来自哪里
  source: ['来源', 'source'],
};

const SCREEN = {
  original_title: ['原名', '原片名', 'original title'],
  year: ['年份', 'year'],
  director: ['导演', 'director'],
  screenwriter: ['编剧', 'writer', 'screenwriter'],
  actors: ['主演', '演员', 'cast', 'actors'],
  genres: ['类型', 'genres', 'genre'],
  country: ['国家/地区', '制片国家/地区', '国家', '地区', 'country'],
  language: ['语言', 'language'],
  aka: ['又名', 'aka'],
  imdb: ['IMDb', 'imdb'],
};

export const MAPPINGS = {
  book: {
    ...COMMON,
    title: ['书名', ...COMMON.title],
    subtitle: ['副标题', 'subtitle'],
    author: ['作者', '作者名', 'author'],
    translator: ['译者', '译者名', 'translator'],
    publisher: ['出版社', '出版社名', 'publisher'],
    production_company: ['出品方', 'producer'],
    pubdate: ['出版日期', '出版年', '出版时间', 'publication date'],
    pages: ['页数', '总页数', 'pages', 'page number'],
    price: ['定价', '价格', 'price'],
    binding: ['装帧', '装订', 'binding'],
    isbn: ['ISBN', 'ISBN-13', 'ISBN-10'],
    series: ['丛书', 'series'],
    original_title: ['原作名', 'original title'],
    author_intro: ['作者简介', 'author intro'],
  },
  movie: {
    ...COMMON,
    ...SCREEN,
    title: ['片名', '电影名', ...COMMON.title],
    release_date: ['上映日期', '上映时间', 'release date'],
    runtime: ['片长', 'runtime'],
  },
  tv: {
    ...COMMON,
    ...SCREEN,
    title: ['剧名', '片名', ...COMMON.title],
    first_air_date: ['首播日期', '首播', 'first air date'],
    episodes: ['集数', 'episodes'],
    episode_runtime: ['单集片长', 'episode runtime'],
    seasons: ['季数', 'seasons'],
  },
};

export const TYPE_LABELS = { book: '图书', movie: '电影', tv: '剧集' };
export const TYPE_ICONS = { book: '📚', movie: '🎬', tv: '📺' };

// 豆瓣的三种标记状态在不同类型下的叫法
export const STATUS_LABELS = {
  book: { mark: '想读', doing: '在读', done: '读过' },
  movie: { mark: '想看', doing: '在看', done: '看过' },
  tv: { mark: '想看', doing: '在看', done: '看过' },
};

const text = { rich_text: {} };
const status = (type) => ({
  select: { options: Object.values(STATUS_LABELS[type]).map((name) => ({ name })) },
});
const MINE = {
  我的评分: { number: { format: 'number' } },
  标记日期: { date: {} },
  短评: text,
  我的标签: { multi_select: {} },
  来源: { multi_select: {} },
};

// “一键创建数据库”时使用的结构。字段名都能在上面的 MAPPINGS 里找到。
export const SCHEMAS = {
  book: {
    title: [{ type: 'text', text: { content: '我的书库' } }],
    icon: { type: 'emoji', emoji: '📚' },
    properties: {
      书名: { title: {} },
      封面: { files: {} },
      状态: status('book'),
      评分: { number: { format: 'number' } },
      作者: text,
      译者: text,
      出版社: text,
      出品方: text,
      出版日期: { date: {} },
      页数: { number: { format: 'number' } },
      定价: text,
      装帧: { select: {} },
      丛书: text,
      原作名: text,
      ISBN: text,
      标签: { multi_select: {} },
      链接: { url: {} },
      ...MINE,
    },
  },
  movie: {
    title: [{ type: 'text', text: { content: '我的影院' } }],
    icon: { type: 'emoji', emoji: '🎬' },
    properties: {
      片名: { title: {} },
      封面: { files: {} },
      状态: status('movie'),
      评分: { number: { format: 'number' } },
      年份: { number: { format: 'number' } },
      原名: text,
      导演: text,
      编剧: text,
      主演: text,
      类型: { multi_select: {} },
      '国家/地区': text,
      语言: text,
      上映日期: { date: {} },
      片长: text,
      IMDb: text,
      标签: { multi_select: {} },
      链接: { url: {} },
      ...MINE,
    },
  },
  tv: {
    title: [{ type: 'text', text: { content: '我的剧集' } }],
    icon: { type: 'emoji', emoji: '📺' },
    properties: {
      剧名: { title: {} },
      封面: { files: {} },
      状态: status('tv'),
      评分: { number: { format: 'number' } },
      年份: { number: { format: 'number' } },
      原名: text,
      导演: text,
      编剧: text,
      主演: text,
      类型: { multi_select: {} },
      '国家/地区': text,
      语言: text,
      首播日期: { date: {} },
      集数: { number: { format: 'number' } },
      单集片长: text,
      IMDb: text,
      标签: { multi_select: {} },
      链接: { url: {} },
      ...MINE,
    },
  },
};

// ---------- 字段对应窗口用的说明 ----------
// kind 决定这个豆瓣字段可以写进哪些类型的 Notion 列
export const FIELD_INFO = {
  title: { label: '标题', kind: 'text' },
  subtitle: { label: '副标题', kind: 'text' },
  original_title: { label: '原名 / 原作名', kind: 'text' },
  author: { label: '作者', kind: 'text' },
  translator: { label: '译者', kind: 'text' },
  publisher: { label: '出版社', kind: 'text' },
  production_company: { label: '出品方', kind: 'text' },
  pubdate: { label: '出版日期', kind: 'date' },
  pages: { label: '页数', kind: 'number' },
  price: { label: '定价', kind: 'number' },
  binding: { label: '装帧', kind: 'text' },
  isbn: { label: 'ISBN', kind: 'text' },
  series: { label: '丛书', kind: 'text' },
  author_intro: { label: '作者简介', kind: 'longtext' },
  year: { label: '年份', kind: 'number' },
  director: { label: '导演', kind: 'text' },
  screenwriter: { label: '编剧', kind: 'text' },
  actors: { label: '主演', kind: 'text' },
  genres: { label: '类型', kind: 'list' },
  country: { label: '国家 / 地区', kind: 'text' },
  language: { label: '语言', kind: 'text' },
  aka: { label: '又名', kind: 'text' },
  imdb: { label: 'IMDb', kind: 'text' },
  release_date: { label: '上映日期', kind: 'date' },
  runtime: { label: '片长', kind: 'text' },
  first_air_date: { label: '首播日期', kind: 'date' },
  episodes: { label: '集数', kind: 'number' },
  episode_runtime: { label: '单集片长', kind: 'text' },
  seasons: { label: '季数', kind: 'number' },
  rating: { label: '豆瓣评分', kind: 'number' },
  tags: { label: '豆瓣标签', kind: 'list' },
  url: { label: '豆瓣链接', kind: 'url' },
  cover: { label: '封面', kind: 'image' },
  summary: { label: '简介', kind: 'longtext' },
  status: { label: '我的状态（想读 / 读过…）', kind: 'status' },
  my_rating: { label: '我的评分', kind: 'number' },
  marked_date: { label: '标记日期', kind: 'date' },
  comment: { label: '我的短评', kind: 'longtext' },
  my_tags: { label: '我的标签', kind: 'list' },
  source: { label: '来源（豆列 / 标签…）', kind: 'list' },
};

// 每种字段能写进哪些 Notion 列类型
export const KIND_ACCEPTS = {
  text: ['rich_text', 'title', 'select', 'multi_select'],
  longtext: ['rich_text', 'title'],
  number: ['number', 'rich_text', 'select'],
  date: ['date', 'rich_text'],
  list: ['multi_select', 'rich_text', 'select'],
  url: ['url', 'rich_text'],
  image: ['files', 'url'],
  status: ['select', 'status', 'multi_select', 'rich_text'],
};

// 插件能写入的 Notion 列类型
export const WRITABLE_TYPES = ['title', 'rich_text', 'number', 'select', 'multi_select', 'status', 'date', 'url', 'files'];

export const PROP_TYPE_LABELS = {
  title: '标题', rich_text: '文本', number: '数字', select: '单选', multi_select: '多选', status: '状态',
  date: '日期', url: '链接', files: '文件', checkbox: '勾选框', people: '人员', relation: '关联',
  formula: '公式', rollup: '汇总', created_time: '创建时间', last_edited_time: '编辑时间',
  created_by: '创建人', last_edited_by: '编辑人', email: '邮箱', phone_number: '电话', unique_id: '编号',
};
