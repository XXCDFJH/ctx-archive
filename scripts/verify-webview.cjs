/**
 * Webview 总览轴验证:提取内嵌脚本 → 语法检查 → DOM 桩端到端断言。
 *
 * 背景:webview 脚本被包在 TS 模板字面量里,`\n` 之类的转义和二重转义极易出错,
 * 且无法在 Node 里直接运行真实浏览器交互。这里用最小 DOM 桩跑通
 * buildTimeline → 事件消息 → 指针/滚轮交互 → 选区联动账本 的全链路。
 *
 * 用法:npm run verify:webview
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/** 从编译产物中还原 webview 内嵌脚本并做语法检查,返回脚本文本 */
function extractWebviewScript() {
  const source = fs.readFileSync(path.join(ROOT, 'out', 'webview.js'), 'utf8');
  const marker = 'return `<!DOCTYPE html>';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error('未在 out/webview.js 中找到 HTML 模板');
  const end = source.indexOf('`;', start + marker.length);
  const literal = source.slice(start + 'return '.length, end + 1);
  const nonce = 'VERIFY'; // eslint-disable-line no-unused-vars
  const html = eval(literal); // 模板里唯一的插值是 ${nonce}
  const open = html.indexOf('<script nonce="');
  const bodyStart = html.indexOf('>', open) + 1;
  const bodyEnd = html.indexOf('</scr' + 'ipt>', bodyStart);
  const script = html.slice(bodyStart, bodyEnd);
  const out = path.join(os.tmpdir(), 'ctx-webview-check.js');
  fs.writeFileSync(out, script, 'utf8');
  console.log(`[verify-webview] 提取内嵌脚本 ${script.length} 字符 → ${out}`);
  execFileSync(process.execPath, ['--check', out], { stdio: 'inherit' });
  console.log('[verify-webview] 语法检查通过');
  return script;
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.dataset = {};
    this.handlers = {};
    this._class = new Set();
    this._text = '';
    this.id = '';
    this.value = '';
    this.offsetWidth = 120;
    this.offsetHeight = 40;
    const self = this;
    this.style = {
      setProperty(key, value) { self.style[key] = value; },
      removeProperty(key) { delete self.style[key]; },
    };
    this.classList = {
      add(name) { self._class.add(name); },
      remove(name) { self._class.delete(name); },
      contains(name) { return self._class.has(name); },
      toggle(name, force) {
        const on = force === undefined ? !self._class.has(name) : Boolean(force);
        if (on) self._class.add(name);
        else self._class.delete(name);
        return on;
      },
    };
  }
  get textContent() { return this._text; }
  set textContent(value) { this._text = value == null ? '' : String(value); this.children = []; }
  get className() { return Array.from(this._class).join(' '); }
  set className(value) { this._class = new Set(String(value).split(/\s+/).filter(Boolean)); }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter((item) => item !== child); return child; }
  setAttribute(key, value) { this.attrs[key] = value; }
  removeAttribute(key) { delete this.attrs[key]; }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener(type, handler) { (this.handlers[type] = this.handlers[type] ?? []).push(handler); }
  removeEventListener() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  scrollIntoView() {}
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 50, right: 1000, bottom: 50 }; }
  closest(selector) {
    const key = selector.replace(/[[\]]/g, '').replace('data-', '');
    let node = this;
    while (node) {
      if (node.dataset[key] !== undefined) return node;
      node = node.parent;
    }
    return null;
  }
  querySelector(selector) {
    const found = this.querySelectorAll(selector);
    return found.length > 0 ? found[0] : null;
  }
  querySelectorAll(selector) {
    // 只需支持类选择器:.dtab 这类用法
    if (!selector.startsWith('.')) return [];
    const want = selector.slice(1);
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child._class.has(want)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  fire(type, event) {
    for (const handler of this.handlers[type] ?? []) {
      handler(Object.assign({
        preventDefault() {}, stopPropagation() {}, target: this, currentTarget: this,
        button: 0, pointerId: 1,
      }, event));
    }
  }
}

function createSandbox(byId, windowHandlers, vscodeState) {
  const document = {
    body: new El('body'),
    createElement: (tag) => new El(tag),
    getElementById(id) {
      if (!byId.has(id)) {
        const element = new El('div');
        element.id = id;
        byId.set(id, element);
      }
      return byId.get(id);
    },
  };
  const window = {
    addEventListener(type, handler) { (windowHandlers[type] = windowHandlers[type] ?? []).push(handler); },
    innerWidth: 1400,
    innerHeight: 900,
  };
  return {
    document, window, HTMLElement: El,
    acquireVsCodeApi: () => ({
      postMessage() {},
      getState() { return vscodeState.value; },
      setState(next) { vscodeState.value = next; },
    }),
    console, setTimeout, clearTimeout, Math, Date, JSON, Map, Set, Number, String, Array, Object,
    isFinite, Infinity, undefined,
  };
}

function main() {
  const script = extractWebviewScript();
  const byId = new Map();
  const windowHandlers = {};
  const vscodeState = { value: null };
  vm.runInNewContext(script, createSandbox(byId, windowHandlers, vscodeState), { filename: 'webview.js' });

  const refsFor = (map) => {
    const root = map.get('timeline');
    const bar = root.children[0];
    const plot = root.children[1];
    const track = plot.children[1];
    return {
      root, bar, plot, track,
      sel: track.children[0],
      projected: track.children[1],
      edges: track.children[2],
      spans: () => track.children[1].children[1].children,
      turns: () => track.children[1].children[0].children,
      chip: bar.children[bar.children.length - 2],
      modeBtn: bar.children[0],
      modeLabel: bar.children[0].children[1],
    };
  };
  const refs = () => refsFor(byId);
  const MODE_LABELS = { sequence: '顺序', time: '时间', duration: '时长', actual: '实际' };
  const setMode = (key) => {
    for (let step = 0; step <= 4; step += 1) {
      if (refs().modeLabel.textContent === MODE_LABELS[key]) return;
      refs().modeBtn.fire('click', {});
    }
    throw new Error(`模式切换失败:${key}`);
  };
  const pct = (value) => parseFloat(value);
  const near = (left, right, tolerance = 0.01) => Math.abs(left - right) <= tolerance;

  let pass = 0;
  let fail = 0;
  const check = (name, condition, extra) => {
    if (condition) { pass += 1; console.log(`  ok   ${name}${extra ? '  ' + extra : ''}`); } else {
      fail += 1;
      console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`);
    }
  };

  const T0 = 1000000;
  const events = [
    { type: 'user', seq: 1, time: T0, request: 1, text: 'a' },
    { type: 'assistant', seq: 2, time: T0 + 1000, request: 1, text: 'b' },
    { type: 'tool', seq: 3, time: T0 + 1500, request: 1, text: 'c', toolId: 'read_file' },
    { type: 'toolResult', seq: 4, time: T0 + 4000, request: 1, text: 'd', durationMs: 2500, exitCode: 0 },
    { type: 'user', seq: 5, time: T0 + 20000, request: 2, text: 'e' },
    { type: 'assistant', seq: 6, time: T0 + 21000, request: 2, text: 'f' },
  ];
  const send = (payload) => windowHandlers.message[0]({ data: payload });
  send({ type: 'sessionData', file: 'C:/x/a.jsonl', title: 't', time: 'now', model: 'm', source: 'w', total: 6, events });

  // ---- 排序:聊天列表按时间 + 对话块按时间 ----
  const listTitles = () => byId.get('list-body').children.map((node) => node.children[0].textContent);
  const feedIndexes = () => byId.get('feed-body').children[0].children.map((node) => node.dataset.tlIndex);
  const listOrderBtn = byId.get('btn-list-order');
  const feedOrderBtn = byId.get('btn-feed-order');

  send({ type: 'sessionList', sessions: [
    { file: 'C:/x/old.jsonl', sid: 'old', title: '旧会话', time: 't1', timeMs: 1000, count: 3, model: '' },
    { file: 'C:/x/new.jsonl', sid: 'new', title: '新会话', time: 't3', timeMs: 3000, count: 5, model: '' },
    { file: 'C:/x/mid.jsonl', sid: 'mid', title: '中会话', time: 't2', timeMs: 2000, count: 4, model: '' },
  ] });
  check('聊天列表默认降序(新 → 旧)',
    JSON.stringify(listTitles()) === JSON.stringify(['新会话', '中会话', '旧会话']), JSON.stringify(listTitles()));
  check('列表排序按钮初始 时间 ↓', listOrderBtn.textContent === '时间 ↓', listOrderBtn.textContent);
  listOrderBtn.fire('click', {});
  check('点击后升序(旧 → 新)',
    JSON.stringify(listTitles()) === JSON.stringify(['旧会话', '中会话', '新会话']), JSON.stringify(listTitles()));
  check('列表排序按钮变 时间 ↑', listOrderBtn.textContent === '时间 ↑', listOrderBtn.textContent);

  check('对话块默认升序(seq 0 在前)', feedIndexes()[0] === '0', JSON.stringify(feedIndexes()));
  feedOrderBtn.fire('click', {});
  check('对话块点击后降序(末块在前)', feedIndexes()[0] === '5' && feedIndexes()[5] === '0', JSON.stringify(feedIndexes()));
  check('对话块按钮变 时间 ↓', feedOrderBtn.textContent === '时间 ↓', feedOrderBtn.textContent);
  check('降序渲染后账本停在顶部', byId.get('feed-body').scrollTop === 0);

  let state = refs();
  check('泳道标签 3 个', state.plot.children[0].children.length === 3);
  check('模式控件是单个按钮', state.modeBtn.className === 'tl-mode-cycle');
  check('默认模式 = 顺序', state.modeLabel.textContent === '顺序');
  check('顺序模式:色块 6 个', state.spans().length === 6);
  check('顺序模式:首块 0%', state.spans()[0].style['--tl-span-left'] === '0.0000%');
  check('顺序模式:第 4 块 50%', pct(state.spans()[3].style['--tl-span-left']) === 50);
  check('泳道归属 0/1/2',
    state.spans()[0].style['--tl-span-lane'] === '0'
    && state.spans()[1].style['--tl-span-lane'] === '1'
    && state.spans()[2].style['--tl-span-lane'] === '2');
  check('轮次线跳过起点(1 条)', state.turns().length === 1);

  setMode('time');
  state = refs();
  check('按钮循环 → 时间模式', state.modeLabel.textContent === '时间', state.modeLabel.textContent);
  check('时间模式:第 2 块 = 1000/21000',
    near(pct(state.spans()[1].style['--tl-span-left']), 1000 / 21000 * 100),
    state.spans()[1].style['--tl-span-left']);
  check('时间模式:末块 100%', near(pct(state.spans()[5].style['--tl-span-left']), 100));
  check('时间模式:等宽 8px 标记', state.spans().every((span) => span.dataset.equal === 'true'));
  check('时间模式:全域可见', state.projected.style['--tl-domain-width'] === '100.0000%'
    && pct(state.projected.style['--tl-domain-left']) === 0);

  state.track.fire('wheel', { deltaY: -100, clientX: 500 });
  state = refs();
  const zoomLeft = pct(state.projected.style['--tl-domain-left']);
  const zoomWidth = pct(state.projected.style['--tl-domain-width']);
  check('滚轮缩放:域宽 > 100%', zoomWidth > 100, `${zoomWidth.toFixed(2)}%`);
  check('滚轮缩放:域左为负(容器左移)', zoomLeft < 0, `${zoomLeft.toFixed(2)}%`);
  check('滚轮缩放:锚点保持居中', near(zoomLeft + zoomWidth / 2, 50, 1));
  check('滚轮缩放:锚点时间不变', near(
    (50 - zoomLeft) / zoomWidth * 21000, 10500, 60,
  ));

  state.track.fire('pointerdown', { button: 2, clientX: 600, pointerId: 7 });
  state.track.fire('pointermove', { clientX: 400, pointerId: 7 });
  state.track.fire('pointerup', { button: 2, clientX: 400, pointerId: 7 });
  state = refs();
  check('右键拖动平移', pct(state.projected.style['--tl-domain-left']) < zoomLeft);
  state.track.fire('pointerdown', { button: 2, clientX: 500, pointerId: 8 });
  state.track.fire('pointerup', { button: 2, clientX: 500, pointerId: 8 });
  state = refs();
  check('右键点击未移动:保留缩放', pct(state.projected.style['--tl-domain-width']) === zoomWidth);
  state.track.fire('wheel', { deltaY: 4000, clientX: 500 });
  state = refs();
  check('滚轮缩出:回到全域', state.projected.style['--tl-domain-width'] === '100.0000%');

  state.track.fire('pointerdown', { button: 0, clientX: 0, pointerId: 3 });
  state.track.fire('pointermove', { clientX: 500, pointerId: 3 });
  state = refs();
  check('拖动中显示选区', state.sel.style.display === '' && state.edges.style.display === '');
  state.track.fire('pointerup', { clientX: 500, pointerId: 3 });
  state = refs();
  const dimmed = byId.get('feed-body').children[0].children.map((node) => node.classList.contains('dimmed'));
  check('选区[0,10500] 命中前 4 条',
    dimmed.filter((on) => !on).length === 4 && dimmed.filter((on) => on).length === 2,
    JSON.stringify(dimmed));
  check('选区胶囊文案', state.chip.textContent === '已选 4 / 6 事件', state.chip.textContent);
  check('未命中色块标记 data-dim',
    state.spans()[4].dataset.dim === 'true' && state.spans()[0].dataset.dim === undefined);
  state.track.fire('keydown', { key: 'Escape' });
  state = refs();
  check('Esc 清除选区', state.chip.style.display === 'none'
    && byId.get('feed-body').children[0].children.every((node) => !node.classList.contains('dimmed')));

  setMode('duration');
  state = refs();
  check('按钮循环 → 时长模式', state.modeLabel.textContent === '时长', state.modeLabel.textContent);
  check('时长模式:空闲压缩,末块 100%', near(pct(state.spans()[5].style['--tl-span-left']), 100));
  check('时长模式:耗时块占满全域', near(pct(state.spans()[3].style['--tl-span-width']), 100));
  check('时长模式:无耗时块零宽(CSS min-width 兜底)', pct(state.spans()[0].style['--tl-span-width']) === 0);

  setMode('actual');
  state = refs();
  check('按钮循环 → 实际模式', state.modeLabel.textContent === '实际', state.modeLabel.textContent);
  check('实际模式:耗时块 = 2500/21000',
    near(pct(state.spans()[3].style['--tl-span-width']), 2500 / 21000 * 100));
  check('实际模式:保留空闲,末块 100%', near(pct(state.spans()[5].style['--tl-span-left']), 100));
  check('模式偏好已写入 webview 状态', vscodeState.value !== null && vscodeState.value.tlMode === 'actual',
    JSON.stringify(vscodeState.value));
  state.modeBtn.fire('click', {});
  check('第 4 次点击环回顺序模式', refs().modeLabel.textContent === '顺序');

  // 重新加载:预置偏好应当直接生效
  const byId2 = new Map();
  const handlers2 = {};
  const state2 = { value: { tlMode: 'actual', listOrder: 'asc', feedOrder: 'desc' } };
  vm.runInNewContext(script, createSandbox(byId2, handlers2, state2), { filename: 'webview-reload.js' });
  handlers2.message[0]({ data: { type: 'sessionList', sessions: [
    { file: 'C:/x/old.jsonl', sid: 'old', title: '旧会话', time: 't1', timeMs: 1000, count: 3, model: '' },
    { file: 'C:/x/new.jsonl', sid: 'new', title: '新会话', time: 't3', timeMs: 3000, count: 5, model: '' },
  ] } });
  handlers2.message[0]({ data: { type: 'sessionData', file: 'C:/x/c.jsonl', title: 't3', time: 'now', model: 'm', source: 'w', total: 6, events } });
  check('重载后沿用记忆的模式', refsFor(byId2).modeLabel.textContent === '实际', refsFor(byId2).modeLabel.textContent);
  check('重载后沿用列表升序',
    byId2.get('list-body').children[0].children[0].textContent === '旧会话',
    byId2.get('list-body').children[0].children[0].textContent);
  const reloadedFeed = byId2.get('feed-body').children[0].children.map((node) => node.dataset.tlIndex);
  check('重载后沿用对话块降序', reloadedFeed[0] === '5', JSON.stringify(reloadedFeed));
  check('排序偏好已持久化',
    vscodeState.value !== null && vscodeState.value.listOrder === 'asc' && vscodeState.value.feedOrder === 'desc'
      && vscodeState.value.tlMode === 'sequence',
    JSON.stringify(vscodeState.value));

  const errorEvents = events.map((event) => Object.assign({}, event));
  errorEvents[3].exitCode = 2;
  send({ type: 'sessionData', file: 'C:/x/b.jsonl', title: 't2', time: 'now', model: 'm', source: 'w', total: 6, events: errorEvents });
  state = refs();
  check('退出码非 0 → error 色', state.spans()[3].dataset.error === 'true');
  check('会话切换重置选区', state.chip.style.display === 'none');
  check('会话切换后仍是 6 块', state.spans().length === 6);
  // ---- DSH 风格:行内结果 / 整轮折叠 / 标签记忆 ----
  const nodesOf = () => byId.get('feed-body').children[0].children;
  const nodeForIndex = (index) => nodesOf().find((node) => node.dataset.tlIndex === String(index));
  const summaryOf = (node) => node.children[2].children[0];
  const tabsOf = (node) => node.children[2].children[1].children[0];
  const textChild = (summary) => summary.children.find((child) => child.className === '');
  const resultChild = (summary) => summary.children.find((child) => child.className.indexOf('s-result') >= 0);
  const activeTabLabel = (node) => {
    for (const button of tabsOf(node).children) {
      if (button.className.indexOf('active') >= 0) return button.textContent;
    }
    return null;
  };
  const foldedNodes = () => nodesOf().filter((node) => node.className.indexOf('n-folded') >= 0);
  const foldedText = (node) => node.children[2].children[0].children[1].textContent;

  send({ type: 'sessionData', file: 'C:/x/a.jsonl', title: 't', time: 'now', model: 'm', source: 'w', total: 6, events });
  const toolSummary = summaryOf(nodeForIndex(2));
  check('工具行内联 "→ 结果"',
    resultChild(toolSummary) !== undefined && toolSummary.children.some((child) => child.textContent === '→'),
    (resultChild(toolSummary) || {}).textContent);

  // 长文本走有界预览:源 3000 字符 → 摘要 ≤141、结果 ≤121 且带省略号
  const longEvents = events.map((event) => Object.assign({}, event));
  longEvents[1] = Object.assign({}, longEvents[1], { text: 'w'.repeat(3000) });
  longEvents[2] = Object.assign({}, longEvents[2], { text: 'y'.repeat(3000) });
  longEvents[3] = Object.assign({}, longEvents[3], { text: 'z'.repeat(3000) });
  send({ type: 'sessionData', file: 'C:/x/long.jsonl', title: 't-long', time: 'now', model: 'm', source: 'w', total: 6, events: longEvents });
  const longToolResult = resultChild(summaryOf(nodeForIndex(2)));
  const longAssistant = textChild(summaryOf(nodeForIndex(1))).textContent;
  check('结果预览有界且带省略号',
    longToolResult.textContent.length <= 121 && longToolResult.textContent.slice(-1) === '…',
    String(longToolResult.textContent.length));
  check('助手摘要有界且带省略号',
    longAssistant.length <= 141 && longAssistant.slice(-1) === '…', String(longAssistant.length));

  // 整轮折叠(工具栏开关)
  send({ type: 'sessionData', file: 'C:/x/a.jsonl', title: 't', time: 'now', model: 'm', source: 'w', total: 6, events });
  const rowsBefore = nodesOf().length;
  const foldButton = byId.get('btn-fold');
  check('折叠按钮初始文案', foldButton.textContent === '折叠轮次', foldButton.textContent);
  foldButton.fire('click', {});
  check('折叠后出现两个合成行(两轮各一)', foldedNodes().length === 2, String(foldedNodes().length));
  check('合成行统计事件数与调用数',
    foldedNodes().some((node) => foldedText(node).indexOf('折叠了 3 个事件 · 1 次工具调用') >= 0),
    foldedNodes().map(foldedText).join(' | '));
  check('折叠后行数变少(6 → 4)', nodesOf().length === 4, String(nodesOf().length));
  check('折叠后按钮变展开', foldButton.textContent === '展开轮次', foldButton.textContent);
  foldedNodes()[0].children[2].children[0].fire('click', {});
  check('点击合成行只展开该轮', foldedNodes().length === 1, String(foldedNodes().length));
  foldButton.fire('click', {});
  check('工具栏二次点击全展开', foldedNodes().length === 0 && nodesOf().length === rowsBefore, String(nodesOf().length));

  // 双击折叠单轮(与显示顺序无关:折叠当前首行所属的那一轮)
  summaryOf(nodesOf()[0]).fire('dblclick', {});
  check('双击轮次首行折叠该轮', foldedNodes().length === 1, String(foldedNodes().length));
  foldedNodes()[0].children[2].children[0].fire('click', {});
  check('展开后恢复全部行', nodesOf().length === rowsBefore && foldedNodes().length === 0, String(nodesOf().length));

  // 明细标签记忆
  summaryOf(nodesOf()[0]).fire('click', {});
  check('默认标签概述', activeTabLabel(nodesOf()[0]) === '概述', String(activeTabLabel(nodesOf()[0])));
  tabsOf(nodesOf()[0]).children[2].fire('click', {});
  check('点击切到原始内容', activeTabLabel(nodesOf()[0]) === '原始内容', String(activeTabLabel(nodesOf()[0])));
  check('标签已写入持久化状态', vscodeState.value !== null && vscodeState.value.detailTab === 'raw',
    JSON.stringify(vscodeState.value));
  summaryOf(nodesOf()[1]).fire('click', {});
  check('下一条详情沿用记忆标签', activeTabLabel(nodesOf()[1]) === '原始内容', String(activeTabLabel(nodesOf()[1])));
  console.log(`\n[verify-webview] 通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
