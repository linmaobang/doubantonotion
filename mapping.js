// “字段对应”窗口：左边是 Notion 数据库的列，右边选它放豆瓣的哪项信息。
// 设置页和批量导入页共用。用法：
//   const saved = await openMappingDialog({ databaseId, type });  // 取消时返回 null
import { FIELD_INFO, KIND_ACCEPTS, MAPPINGS, PROP_TYPE_LABELS, SCHEMAS, TYPE_ICONS, TYPE_LABELS, WRITABLE_TYPES } from './config.js';

async function bg(action, payload = {}) {
  const res = await chrome.runtime.sendMessage({ action, ...payload });
  if (!res) throw new Error('后台没有响应');
  if (!res.success) throw new Error(res.error);
  return res.data;
}

// 关闭窗口：按钮、Esc、浏览器自己的 close 事件都走这里，只处理一次。
// （有的浏览器环境里 close 事件不一定触发，所以不能只靠它。）
function onceClosed(dialog, done) {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    done();
  };
  dialog.addEventListener('close', finish);
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    finish();
  });
  return finish;
}

// replaceChildren 会把 null 变成文字“null”，先过滤掉
function replace(node, ...children) {
  node.replaceChildren(...children.filter((c) => c !== null && c !== undefined && c !== false));
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.includes('-')) node.setAttribute(k, v);
    else node[k] = v;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

// 这个豆瓣字段能不能写进这种列
function accepts(key, propType) {
  return (KIND_ACCEPTS[FIELD_INFO[key]?.kind] || []).includes(propType);
}

// 某个豆瓣字段没有对应列时，自动补列会建出的列名（没有就不能补）
function creatableName(type, key) {
  const schema = SCHEMAS[type].properties;
  return Object.keys(schema).find((n) => MAPPINGS[type][key]?.some((c) => c.toLowerCase() === n.toLowerCase())) || null;
}

export async function openMappingDialog({ databaseId, type }) {
  const dialog = el('dialog', { className: 'map-dialog' });
  dialog.append(el('p', { className: 'muted' }, '正在读取数据库的列…'));
  document.body.append(dialog);
  dialog.showModal();

  let data;
  try {
    data = await bg('getFieldMap', { databaseId, type });
  } catch (err) {
    return new Promise((resolve) => {
      const finish = onceClosed(dialog, () => resolve(null));
      dialog.replaceChildren(
        el('p', { className: 'error' }, `读不到这个数据库：${err.message}`),
        el('div', { className: 'map-actions' }, el('button', { className: 'secondary', type: 'button', onclick: finish }, '关闭')),
      );
    });
  }

  const keys = Object.keys(MAPPINGS[type]);
  const saved = data.saved || {};
  const state = {
    rows: {}, // 列名 -> 豆瓣字段（'' = 不写入）
    addMissing: saved.addMissing !== false,
    body: { summary: true, author_intro: true, ...(saved.body || {}) },
    pageCover: saved.pageCover !== false,
  };
  const fill = (resolved) => {
    state.rows = {};
    for (const p of data.properties) state.rows[p.name] = '';
    for (const [key, prop] of Object.entries(resolved)) if (prop in state.rows) state.rows[prop] = key;
  };
  fill(data.resolved);

  const rowsBox = el('div', { className: 'map-rows' });
  const missingBox = el('div', { className: 'map-missing' });

  function renderRows() {
    const used = new Map(Object.entries(state.rows).filter(([, k]) => k).map(([prop, k]) => [k, prop]));
    rowsBox.replaceChildren(
      ...data.properties.map((p) => {
        const name = el('span', { className: 'map-col' }, el('strong', {}, p.name), el('span', { className: 'type-chip' }, PROP_TYPE_LABELS[p.type] || p.type));
        if (!WRITABLE_TYPES.includes(p.type)) {
          return el('div', { className: 'map-row disabled' }, name, el('span', { className: 'muted small-text' }, '这种列插件不写入'));
        }
        const select = el('select', { 'aria-label': `「${p.name}」放什么` });
        select.append(new Option('— 不写入 —', ''));
        for (const key of keys) {
          if (!accepts(key, p.type)) continue;
          const other = used.get(key);
          const label = FIELD_INFO[key]?.label || key;
          select.append(new Option(other && other !== p.name ? `${label}（现在在「${other}」）` : label, key));
        }
        select.value = state.rows[p.name];
        select.addEventListener('change', () => {
          const key = select.value;
          // 一个豆瓣字段只放一列：原来那列改成不写入
          if (key) for (const [prop, k] of Object.entries(state.rows)) if (k === key && prop !== p.name) state.rows[prop] = '';
          state.rows[p.name] = key;
          renderRows();
          renderMissing();
        });
        const statusHint =
          p.type === 'status' && state.rows[p.name] === 'status'
            ? el('span', { className: 'muted small-text map-hint' }, `只会写入这一列已有的选项：${p.options.join('、') || '（没有选项）'}`)
            : null;
        return el('div', { className: 'map-row' }, name, select, statusHint);
      }),
    );
  }

  function renderMissing() {
    const chosen = new Set(Object.values(state.rows).filter(Boolean));
    const lower = new Set(data.properties.map((p) => p.name.toLowerCase()));
    // 简介、作者简介默认放在页面正文里，不算“没有地方放”
    const inBody = (k) => (k === 'summary' || k === 'author_intro') && state.body[k];
    const left = keys.filter((k) => k !== 'title' && !chosen.has(k) && !inBody(k));
    const creatable = left.filter((k) => {
      const n = creatableName(type, k);
      return n && !lower.has(n.toLowerCase());
    });
    const labels = (list) => list.map((k) => FIELD_INFO[k]?.label || k).join('、');
    if (!left.length) {
      missingBox.replaceChildren(el('p', { className: 'success' }, '✓ 豆瓣上的信息都有地方放了。'));
      return;
    }
    const toggle = el('input', { type: 'checkbox', checked: state.addMissing });
    toggle.addEventListener('change', () => {
      state.addMissing = toggle.checked;
      renderMissing();
    });
    const details = el('details', {}, el('summary', {}, `还有 ${left.length} 项豆瓣信息没有对应的列`), el('p', { className: 'muted small-text' }, labels(left)));
    replace(
      missingBox,
      details,
      creatable.length
        ? el('label', { className: 'switch-row small' }, toggle, el('span', {}, `自动在这个库里新建 ${creatable.length} 列来放它们`))
        : null,
      !state.addMissing || !creatable.length ? el('p', { className: 'muted small-text' }, '没有对应列的信息不会写进 Notion。') : null,
    );
  }

  const bodyOptions = el(
    'div',
    { className: 'map-body' },
    el('strong', {}, '页面里还放什么'),
    ...[
      ['summary', '正文放「简介」'],
      ...(type === 'book' ? [['author_intro', '正文放「作者简介」']] : []),
    ].map(([k, text]) => {
      const box = el('input', { type: 'checkbox', checked: state.body[k] });
      box.addEventListener('change', () => {
        state.body[k] = box.checked;
        renderMissing();
      });
      return el('label', { className: 'switch-row small' }, box, el('span', {}, text));
    }),
    (() => {
      const box = el('input', { type: 'checkbox', checked: state.pageCover });
      box.addEventListener('change', () => (state.pageCover = box.checked));
      return el('label', { className: 'switch-row small' }, box, el('span', {}, '用封面做页面封面'));
    })(),
  );

  return new Promise((resolve) => {
    let result = null;
    const finish = onceClosed(dialog, () => resolve(result));
    const reset = el('button', { type: 'button', className: 'text-btn' }, '恢复自动对应');
    reset.addEventListener('click', () => {
      fill(data.auto);
      state.addMissing = true;
      renderRows();
      renderMissing();
    });
    const cancel = el('button', { type: 'button', className: 'secondary' }, '取消');
    cancel.addEventListener('click', finish);
    const save = el('button', { type: 'button', className: 'primary' }, '保存');
    save.addEventListener('click', async () => {
      save.disabled = true;
      const map = {};
      const ignored = [];
      for (const p of data.properties) {
        if (!WRITABLE_TYPES.includes(p.type)) continue;
        if (state.rows[p.name]) map[state.rows[p.name]] = p.name;
        else ignored.push(p.name); // 看到的“不写入”就真的不写，自动匹配也不用它
      }
      const fieldMap = { map, ignored, addMissing: state.addMissing, body: state.body, pageCover: state.pageCover };
      try {
        await bg('saveFieldMap', { databaseId: data.databaseId, fieldMap });
        result = fieldMap;
        finish();
      } catch (err) {
        save.disabled = false;
        save.textContent = `保存失败：${err.message}`;
      }
    });

    dialog.replaceChildren(
      el('header', { className: 'map-head' }, el('h2', {}, `字段对应 · 「${data.dbTitle}」`), el('span', { className: 'muted' }, `${TYPE_ICONS[type]} 按${TYPE_LABELS[type]}写入`)),
      el('p', { className: 'muted small-text' }, '左边是这个数据库的列，右边选它放豆瓣的哪项信息。已经按列名自动对好了，只改不对的就行。只对这个数据库生效。'),
      rowsBox,
      missingBox,
      bodyOptions,
      el('div', { className: 'map-actions' }, reset, el('span', { className: 'spacer' }), cancel, save),
    );
    renderRows();
    renderMissing();
  });
}
