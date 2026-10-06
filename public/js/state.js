/**
 * 会话级共享状态。
 *
 * 为什么单独成模块，以及为什么写成这样：
 *
 * 1. 测试用 `?boot=随机数` 重新导入 app.js 来隔离每个用例，但**静态导入的模块是共享的**
 *    （ESM 只实例化一次）。所以状态必须能通过 `resetState()` 归零，
 *    app.js 每次启动都调用它。
 * 2. 导出的是 `let` 绑定，ESM 的 live binding 保证别的模块 `import { notes }` 后
 *    读到的永远是最新值——不需要 `state.notes` 这种前缀，读起来和普通变量一样。
 * 3. 但 import 进来的绑定是**只读**的：整体替换（`notes = [...]`）必须走这里的 setter。
 *    原地修改（`notes.push()`、`selectedNotes.add()`）不受影响，可以照常写。
 */

/** 全部笔记。界面上的顺序是 date 倒序、同日内 createdAt 倒序。 */
export let notes = [];

/** 正在编辑/操作的笔记 id（右键菜单、编辑弹窗、删除弹窗共用）。 */
export let currentNoteId = null;

/** 快速录入用：上一条的结束时刻（毫秒）。仅用于同一会话内的连续记录。 */
export let lastEndTime = null;

/** 选择模式下已勾选的笔记 id。 */
export let selectedNotes = new Set();

/** 当前 AI 总结的请求配置（用于"重新生成"）。 */
export let currentSummaryConfig = {};

/** 当前 AI 总结的结果。 */
export let currentSummaryResult = null;

/** 是否处于选择模式。 */
export let selectionMode = false;

/**
 * 区间选择的锚点：Shift+点击 时，从这里选到被点的那条。
 * 存 id 而不是索引，因为笔记随时可能被增删。
 */
export let selectionAnchorId = null;

/** 日期分组 -> 该组的笔记 id（选择模式整组勾选时用）。 */
export let dateGroupNotesMap = new Map();

/** 真源读不到时置位，界面会提示"正在使用本机副本"。 */
export let offlineMode = false;

/** 最近一次保存是否失败，用于点击提示重试。 */
export let lastSaveFailed = false;

/** AI 请求进行中标记：防止连点重复调用 API（每次都是真金白银）。 */
export let summaryInFlight = false;

/**
 * 折叠分组里"还没生成 DOM"的笔记（分组元素 -> 笔记数组）。
 * 上千条笔记时，绝大多数卡片都躺在折叠的分组里、根本看不见，
 * 却会占掉两万多个 DOM 节点；展开时再惰性渲染。
 */
export const lazyGroupNotes = new Map();

/* ------------------------------------------------------------------ */
/* setter：整体替换类赋值必须走这里                                      */
/* ------------------------------------------------------------------ */

export function setNotes(list) { notes = Array.isArray(list) ? list : []; }
export function setCurrentNoteId(id) { currentNoteId = id; }
export function setLastEndTime(timestamp) { lastEndTime = timestamp; }
export function setCurrentSummaryConfig(config) { currentSummaryConfig = config; }
export function setCurrentSummaryResult(result) { currentSummaryResult = result; }
export function setSelectionMode(value) { selectionMode = value === true; }
export function setSelectionAnchorId(id) { selectionAnchorId = id ?? null; }
export function setOfflineMode(value) { offlineMode = value === true; }
export function setLastSaveFailed(value) { lastSaveFailed = value === true; }
export function setSummaryInFlight(value) { summaryInFlight = value === true; }

/**
 * 把状态清回初始值。app.js 每次启动（每个测试用例）都会调用，
 * 否则上一个用例残留的选中项/笔记会漏到下一个用例里。
 */
export function resetState() {
    notes = [];
    currentNoteId = null;
    lastEndTime = null;
    selectedNotes.clear();
    currentSummaryConfig = {};
    currentSummaryResult = null;
    selectionMode = false;
    selectionAnchorId = null;
    dateGroupNotesMap.clear();
    offlineMode = false;
    lastSaveFailed = false;
    summaryInFlight = false;
    lazyGroupNotes.clear();
}
