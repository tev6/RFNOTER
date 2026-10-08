import {
    generateUUID, getCurrentDateString, formatRelativeTime, formatDateForDisplay,
    calculateTimeDuration, formatDuration, trimTagToLimit, markdownToHtml,
    isTodayDate, groupNotesByDate, escapeHTML, sanitizeHtml, parseDateString,
    parseClockMinutes, minutesToClock, countWords
} from './utils.js';
import {
    loadNotes, saveNotesToServer, saveNotesLocally, callDeepSeekAPI,
    backupLocalNotes, hasPendingChanges, fetchAvailableModels,
    setApiKey, getApiKey, ApiError, REQUEST_TIMEOUT_MS, isDesktopApp
} from './api.js';
import { notesToJson, notesToMarkdown, notesToCsv, exportFilename, mimeFor } from './exporters.js';
import { rangeIds, sortForDisplay, batchApplyTag, batchRemove, collectTags, TAG_OP } from './note-ops.js';
import { parseQuery, matchNote, resultLabel } from './search.js';
import {
    filterByRange, rankActivities, hourHistogram, dailyBuckets,
    timelineBlocks, overview, heatmapDays, ALLOCATION,
    activityHistory, activitiesInOrder
} from './stats.js';
import { renderStats, renderActivityHistory } from './stats-view.js';
import { topActivities, searchSuggestions, applySuggestion } from './suggest.js';
import { CONFIG, STORE_LABEL, SAFE_ID_RE } from './config.js';
import { initTheme } from './theme.js';
import {
    initRender, setRenderHooks, renderNotes, renderNoteElement,
    removeNoteElement, updateEmptyState, setDateGroupCollapsed, expandDateGroup
} from './render.js';
import {
    notes, currentNoteId, lastEndTime, selectedNotes,
    currentSummaryConfig, currentSummaryResult, selectionMode,
    dateGroupNotesMap, offlineMode, lastSaveFailed, summaryInFlight,
    lazyGroupNotes, resetState, selectionAnchorId, setSelectionAnchorId,
    searchTerms, setSearchTerms,
    setNotes, setCurrentNoteId, setLastEndTime,
    setCurrentSummaryConfig, setCurrentSummaryResult, setSelectionMode,
    setOfflineMode, setLastSaveFailed, setSummaryInFlight
} from './state.js';

const notesContainer = document.getElementById('notes-container');
const emptyState = document.getElementById('empty-state');
const noteModal = document.getElementById('note-modal');
const contextMenu = document.getElementById('context-menu');
const deleteModal = document.getElementById('delete-modal');
const quickAddForm = document.getElementById('quick-add-form');
const colorSubmenu = document.getElementById('color-submenu');
const colorMenuBtn = document.getElementById('color-menu-btn');
const selectionToggleBtn = document.getElementById('selection-toggle-btn');
const selectionModeHint = document.getElementById('selection-mode-hint');
const closeSelectionHintBtn = document.getElementById('close-selection-hint-btn');
const aiSummaryFloatBtn = document.getElementById('ai-summary-float-btn');
const selectionInfo = document.getElementById('selection-info');
const selectedCount = document.getElementById('selected-count');
const clearSelectionBtn = document.getElementById('clear-selection-btn');
const selectedNotesCount = document.getElementById('selected-notes-count');
const aiSummaryModal = document.getElementById('ai-summary-modal');
const aiResultModal = document.getElementById('ai-result-modal');
const modalSelectedCount = document.getElementById('modal-selected-count');
const selectedNotesPreview = document.getElementById('selected-notes-preview');
const generateSummaryBtn = document.getElementById('generate-summary-btn');
const cancelSummaryBtn = document.getElementById('cancel-summary-btn');
const summaryLoading = document.getElementById('summary-loading');
const summaryContent = document.getElementById('summary-content');
const summaryText = document.getElementById('summary-text');
const resultNoteCount = document.getElementById('result-note-count');
const summaryStats = document.getElementById('summary-stats');
const summaryError = document.getElementById('summary-error');
const errorMessage = document.getElementById('error-message');
const helpBtn = document.getElementById('help-btn');
const helpModal = document.getElementById('help-modal');
const helpContent = document.getElementById('help-content');
const closeHelpBtn = document.getElementById('close-help-btn');
const closeHelpBtn2 = document.getElementById('close-help-btn2');
const exportBtn = document.getElementById('export-btn');
const importBtn = document.getElementById('import-btn');
const importFileInput = document.getElementById('import-file-input');
const quickPicks = document.getElementById('quick-picks');
const quickContinuityText = document.getElementById('quick-continuity-text');
const quickContinueBtn = document.getElementById('quick-continue-btn');
const selectAllBtn = document.getElementById('select-all-btn');
const batchTagBtn = document.getElementById('batch-tag-btn');
const batchDeleteBtn = document.getElementById('batch-delete-btn');
const batchTagModal = document.getElementById('batch-tag-modal');
const batchTagMode = document.getElementById('batch-tag-mode');
const batchTagInput = document.getElementById('batch-tag-input');
const batchTagCount = document.getElementById('batch-tag-count');
const batchTagExisting = document.getElementById('batch-tag-existing');
const cancelBatchTagBtn = document.getElementById('cancel-batch-tag-btn');
const applyBatchTagBtn = document.getElementById('apply-batch-tag-btn');
const searchInput = document.getElementById('search-input');
const searchClearBtn = document.getElementById('search-clear-btn');
const searchStatus = document.getElementById('search-status');
const themeBtn = document.getElementById('theme-btn');
const themeIcon = document.getElementById('theme-icon');
const statsBtn = document.getElementById('stats-btn');
const statsModal = document.getElementById('stats-modal');
const statsContent = document.getElementById('stats-content');
const closeStatsBtn = document.getElementById('close-stats-btn');
const historyModal = document.getElementById('history-modal');
const historyContent = document.getElementById('history-content');
const historyTitle = document.getElementById('history-title');
const closeHistoryBtn = document.getElementById('close-history-btn');
const undoToast = document.getElementById('undo-toast');
const undoToastText = document.getElementById('undo-toast-text');
const undoToastBtn = document.getElementById('undo-toast-btn');
const undoToastClose = document.getElementById('undo-toast-close');

/**
 * 统计面板的界面状态（范围、口径、展开了哪些明细、时间轴看哪天）。
 * 这些是纯界面选择，不进笔记数据。
 */
let statsState = { range: 'month', allocation: ALLOCATION.SPLIT, expanded: new Set(), timelineDate: null };

document.addEventListener('DOMContentLoaded', async () => {
    // 每次启动先把会话状态归零：测试会用 ?boot=随机数 反复重载本模块，
    // 而 state.js 是共享实例，不清就会把上一个用例的笔记/选中项带进来。
    resetState();
    // 渲染模块的 DOM 引用与回调也要每次重新注入：静态导入的模块是共享实例，
    // 模块级抓 DOM 会让第二个测试用例操作到上一个用例的 document
    initRender({ notesContainer, emptyState });
    setRenderHooks({
        onNoteClick: handleNoteSelection,
        onEdit: openEditModal,
        onDelete: openDeleteModal,
        onContextMenu: openContextMenu,
        onExpandToggled: persistViewState,
        bindGroupSelectionEvents: bindDateGroupSelectionEvents,
        onRendered: refreshSearchStatus
    });
    // 先绑定事件，再加载数据：即使数据异常，界面也不会变成一张点不动的死图。
    try {
        bindEventListeners();
        bindAIEventListeners();
        initImportExport();
        initQuickInput();
        initDesktopBridge();
        // 主题：读偏好并挂上暗色类、绑定顶栏按钮。放在 try 里是为了
        // 即使数据加载出问题，换肤也不能跟着坏掉。
        initTheme({ button: themeBtn, icon: themeIcon });
    } catch (e) {
        console.error('[RFNOTER] 界面初始化失败', e);
    }
    await initializeNotes();
});

/** 桌面端：全局热键唤出时，把光标直接放进快速输入框。 */
function initDesktopBridge() {
    if (!window.rfnoter?.onQuickCapture) return;
    window.rfnoter.onQuickCapture(() => {
        if (selectionMode) exitSelectionMode();
        const input = document.getElementById('quick-content');
        input.focus();
        input.select();
    });
}

/** 把外部数据（服务端文件 / localStorage）补齐成完整、类型正确的笔记对象。 */
function normalizeNote(raw) {
    const note = raw && typeof raw === 'object' ? raw : {};
    const timeStart = parseClockMinutes(note.timeStart) === null ? '00:00' : note.timeStart;
    const timeEnd = parseClockMinutes(note.timeEnd) === null ? timeStart : note.timeEnd;
    return {
        id: typeof note.id === 'string' && SAFE_ID_RE.test(note.id) ? note.id : generateUUID(),
        date: parseDateString(note.date) ? String(note.date).slice(0, 10) : getCurrentDateString(),
        timeStart,
        timeEnd,
        content: typeof note.content === 'string' ? note.content : String(note.content ?? ''),
        tag: trimTagToLimit(typeof note.tag === 'string' ? note.tag : ''),
        color: typeof note.color === 'string' ? note.color : '',
        details: typeof note.details === 'string' ? note.details : '',
        expanded: note.expanded === true,
        createdAt: Number.isFinite(Number(note.createdAt)) ? Number(note.createdAt) : Date.now(),
        updatedAt: Number.isFinite(Number(note.updatedAt)) ? Number(note.updatedAt) : Date.now()
    };
}

/**
 * 加载并对账笔记。
 * 关键约束：服务端为空而本地有数据时，必须由用户确认，绝不静默覆盖。
 */
async function initializeNotes() {
    let result;
    try {
        result = await loadNotes();
    } catch (e) {
        console.error('[RFNOTER] 加载笔记失败', e);
        result = { notes: [], offline: true, error: e.message };
    }

    const loadedNotes = Array.isArray(result.notes) ? result.notes.map(normalizeNote) : [];
    setOfflineMode(result.offline === true);

    if (result.needImportConfirm) {
        const confirmed = window.confirm(
            `检测到本机保存着 ${result.localCount} 条笔记，但${STORE_LABEL}上还没有这份数据。\n\n`
            + `点「确定」：把本地笔记导入到${STORE_LABEL}（推荐，续用旧数据）。\n`
            + `点「取消」：以${STORE_LABEL}为准，本地副本会先自动备份。`
        );
        if (confirmed) {
            setNotes(loadedNotes);
            // 用户确认导入后要把旧数据真正推到服务端，否则下次打开又会认为服务器是空的
            await saveNotes();
        } else {
            const backupKey = backupLocalNotes();
            if (backupKey) {
                setNotes([]);
                console.info('[RFNOTER] 本地笔记已备份到:', backupKey);
            } else {
                setNotes(loadedNotes);
                window.alert('本地笔记备份失败，为避免丢数据，本次仍保留本地副本。');
            }
        }
    } else {
        setNotes(loadedNotes);
        if (result.needPush) {
            // 本地存在未同步的改动，以本地为准推到服务端
            await saveNotes();
        }
    }

    renderNotes();
    renderQuickPicks();
    updateQuickContinuity();
    updateSyncStatus();
}

/* ------------------------------------------------------------------ */
/* 高频录入：常用条目 + 时间接续                                        */
/* ------------------------------------------------------------------ */

/**
 * 从历史笔记里算出「常用条目」。
 *
 * 聚合口径统一挪到了 suggest.js 的 topActivities：它按**活动段**统计，
 * 而不是按整条标题。这个区别在真实数据上非常明显（1151 条、36% 含 `+`）：
 *
 *   按整条标题：CS(147) B站(92) 30图小河道表水(22) 34竹刀(16) B站+吃饭(9) …
 *   按活动段：  B站(289) CS(161) 吃饭(65) 终末地(44) 听音乐(35) …
 *
 * 老口径把 `B站+吃饭` 和 `吃饭+B站` 当成两个独立项，`B站` 的真实热度被拆散，
 * `吃饭`（其实 65 次）连榜都进不去。数据全部现算，不新增存储、不需要迁移。
 */
function computeQuickPicks(limit = 8) {
    return topActivities(notes, { limit });
}

function renderQuickPicks() {
    if (!quickPicks) return;
    const picks = computeQuickPicks();
    quickPicks.innerHTML = '';
    if (picks.length === 0) {
        quickPicks.classList.add('hidden');
        quickPicks.classList.remove('flex');
        return;
    }
    picks.forEach(({ label, count }) => {
        const chip = document.createElement('button');
        chip.type = 'button';   // 必须在表单外/非 submit，否则点一下就把笔记提交了
        chip.className = 'px-2.5 py-1 text-xs rounded-full bg-surface border border-gray-300 text-gray-700 hover:border-primary hover:text-primary transition-colors duration-150';
        chip.textContent = label;
        chip.title = `用过 ${count} 次 · 点击填入，双击直接记录`;
        chip.addEventListener('click', () => fillQuickContent(label));
        chip.addEventListener('dblclick', () => {
            fillQuickContent(label);
            if (typeof quickAddForm.requestSubmit === 'function') quickAddForm.requestSubmit();
        });
        quickPicks.appendChild(chip);
    });
    quickPicks.classList.remove('hidden');
    quickPicks.classList.add('flex');
}

function fillQuickContent(content) {
    const input = document.getElementById('quick-content');
    if (!input) return;
    input.value = content;
    input.focus();
    hideSuggestions();
}

/* ------------------------------------------------------------------ */
/* 输入补全：把"以前记过的"变成少打几个字                                */
/* ------------------------------------------------------------------ */

/** 当前候选列表与选中项。选中项用键盘上下键移动，-1 表示没选。 */
let suggestItems = [];
let suggestIndex = -1;

/**
 * 重画补全下拉。
 *
 * 候选为空时整体隐藏。这里刻意**不做防抖**：候选来自内存里的笔记数组，
 * 1151 条算一次只要几毫秒，加防抖反而会让快速连打时提示慢半拍。
 */
function renderSuggestions() {
    const input = document.getElementById('quick-content');
    const box = document.getElementById('quick-suggest');
    if (!input || !box) return;

    suggestItems = searchSuggestions(notes, input.value);
    suggestIndex = -1;

    if (suggestItems.length === 0) {
        hideSuggestions();
        return;
    }

    box.innerHTML = '';
    suggestItems.forEach((item, i) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'suggest-row w-full text-left px-3 py-1.5 text-sm flex items-baseline gap-2 '
            + 'hover:bg-gray-100 transition-colors duration-100';
        row.dataset.index = String(i);

        const name = document.createElement('span');
        name.className = 'text-gray-800';
        name.textContent = item.label;

        // 灰字显示"还差多少字"，让用户知道选中后会补上什么
        const rest = document.createElement('span');
        rest.className = 'text-gray-400 text-xs';
        rest.textContent = item.rest ? `+${item.rest}` : '';

        const meta = document.createElement('span');
        meta.className = 'ml-auto text-xs text-gray-400 shrink-0';
        meta.textContent = `${item.count} 次`;

        row.append(name, rest, meta);
        // 用 mousedown 而不是 click：click 之前 input 会先失焦，
        // 而失焦会关掉下拉，导致点不到
        row.addEventListener('mousedown', (event) => {
            event.preventDefault();
            acceptSuggestion(i);
        });
        box.appendChild(row);
    });

    box.classList.remove('hidden');
    highlightSuggestion();
}

function hideSuggestions() {
    const box = document.getElementById('quick-suggest');
    if (box) {
        box.classList.add('hidden');
        box.innerHTML = '';
    }
    suggestItems = [];
    suggestIndex = -1;
}

/** 把选中项画出来（键盘操作时用户要知道当前选的是哪条）。 */
function highlightSuggestion() {
    const box = document.getElementById('quick-suggest');
    if (!box) return;
    box.querySelectorAll('.suggest-row').forEach((row, i) => {
        const active = i === suggestIndex;
        row.classList.toggle('bg-gray-100', active);
        row.setAttribute('aria-selected', active ? 'true' : 'false');
    });
}

/** 采纳第 i 条候选，填回输入框。 */
function acceptSuggestion(i) {
    const item = suggestItems[i];
    const input = document.getElementById('quick-content');
    if (!item || !input) return;
    input.value = applySuggestion(input.value, item.label);
    input.focus();
    // 填完继续给下一段的提示（多段输入时连着打很常见），
    // 但光标末尾那一段已经完整了，通常会自然没有候选
    renderSuggestions();
}

/**
 * 输入框的键盘操作。
 *
 * Enter 的语义要小心：有候选时是"采纳这条"，没候选时才是"提交这条笔记"。
 * 否则用户想补全却把半截标题提交了。
 */
function handleQuickContentKeydown(event) {
    if (event.key === 'Escape') {
        hideSuggestions();
        return;
    }
    if (suggestItems.length === 0) return;

    if (event.key === 'ArrowDown') {
        event.preventDefault();
        suggestIndex = (suggestIndex + 1) % suggestItems.length;
        highlightSuggestion();
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        suggestIndex = (suggestIndex - 1 + suggestItems.length) % suggestItems.length;
        highlightSuggestion();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
        // 没手动选过就采纳第一条——那是排序最靠前的，也就是最可能想要的
        event.preventDefault();
        acceptSuggestion(suggestIndex >= 0 ? suggestIndex : 0);
    }
}

/** 把「今天第 N 分钟」换算成时间戳。 */
function timestampOfToday(minutes) {
    const date = new Date();
    date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    return date.getTime();
}

/**
 * 今天最后一条笔记的结束时间。
 * 之前续接只依赖内存里的 lastEndTime，重启应用后就断了——这里改成从数据里推导，
 * 让"接着上一条继续记"跨重启也能成立。
 */
function getTodayLastEnd() {
    const today = getCurrentDateString();
    let latest = null;
    for (const note of notes) {
        if (note.date !== today) continue;
        if (!latest || (Number(note.createdAt) || 0) > (Number(latest.createdAt) || 0)) latest = note;
    }
    if (!latest) return null;
    const start = parseClockMinutes(latest.timeStart);
    const end = parseClockMinutes(latest.timeEnd);
    if (start === null || end === null) return null;
    return { minutes: end, crossDay: end < start, note: latest };
}

/** 刷新接续提示：上一条什么时候结束的、空档多久。 */
function updateQuickContinuity() {
    if (!quickContinuityText || !quickContinueBtn) return;
    const last = getTodayLastEnd();
    if (!last) {
        quickContinuityText.textContent = '今天还没有记录';
        quickContinuityText.className = 'text-xs text-gray-400';
        quickContinueBtn.classList.add('hidden');
        return;
    }
    const clock = minutesToClock(last.minutes);
    const gapMinutes = Math.round((Date.now() - timestampOfToday(last.minutes)) / 60000);
    if (gapMinutes >= 10) {
        quickContinuityText.textContent = `上一条 ${clock} 结束 · 空档 ${formatDuration(gapMinutes)}`;
        quickContinuityText.className = 'text-xs text-amber-600';
        quickContinueBtn.classList.remove('hidden');
    } else {
        quickContinuityText.textContent = `上一条 ${clock} 结束`;
        quickContinuityText.className = 'text-xs text-gray-500';
        quickContinueBtn.classList.add('hidden');
    }
}

/** 「补记空档」：起止时间一键铺满从上一条结束到现在的这段空白。 */
function fillGapToNow() {
    const last = getTodayLastEnd();
    if (!last) return;
    const startMinutes = last.minutes;
    const now = new Date();
    const endMinutes = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 5) * 5;
    document.getElementById('quick-time-start').value = minutesToClock(startMinutes);
    document.getElementById('quick-time-end').value = minutesToClock(Math.max(endMinutes, startMinutes + 5));
    document.getElementById('quick-content').focus();
    updateQuickContinuity();
}

/** 把某个时间输入直接设成指定分钟数。 */
function setTimeInputTo(inputId, totalMinutes) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.value = minutesToClock(totalMinutes);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 把某个时间输入拨动 N 分钟（自动绕圈，23:55 +5 → 00:00）。 */
function stepTimeInput(inputId, deltaMinutes) {
    const input = document.getElementById(inputId);
    if (!input || !input.value) return;
    const minutes = parseClockMinutes(input.value);
    if (minutes === null) return;
    setTimeInputTo(inputId, minutes + deltaMinutes);
}

/** 「现在」：把结束时间设为当前时刻（向上取整到 5 分钟）。 */
function setEndTimeToNow() {
    const now = new Date();
    const rounded = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 5) * 5;
    setTimeInputTo('quick-time-end', rounded);
    document.getElementById('quick-content').focus();
}

function initQuickInput() {
    const today = new Date();
    const formattedDate = today.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
    document.getElementById('quick-date').value = formattedDate;
    const now = new Date();
    let startTime;
    if (lastEndTime) {
        startTime = new Date(lastEndTime);
    } else {
        // 跨重启也能接上：从今天的最后一条推导，而不是只有内存里的 lastEndTime 才算
        const derived = getTodayLastEnd();
        if (derived && !derived.crossDay) {
            startTime = new Date(timestampOfToday(derived.minutes));
        } else {
            startTime = new Date(now);
            const minutes = startTime.getMinutes();
            const nextFiveMinute = Math.ceil(minutes / 5) * 5;
            startTime.setMinutes(nextFiveMinute);
            startTime.setSeconds(0);
            startTime.setMilliseconds(0);
        }
    }
    const endTime = new Date(startTime.getTime() + CONFIG.DEFAULT_DURATION_MINUTES * 60000);
    const startHour = String(startTime.getHours()).padStart(2, '0');
    const startMinute = String(startTime.getMinutes()).padStart(2, '0');
    const endHour = String(endTime.getHours()).padStart(2, '0');
    const endMinute = String(endTime.getMinutes()).padStart(2, '0');
    document.getElementById('quick-time-start').value = `${startHour}:${startMinute}`;
    document.getElementById('quick-time-end').value = `${endHour}:${endMinute}`;
    document.getElementById('quick-content').focus();
}


function handleNoteSelection(event, noteId) {
    event.stopPropagation();
    if (!selectionMode) {
        if (event.detail === 2) openEditModal(noteId);
        return;
    }
    // Shift + 点击 = 从上次点的那条一路选过来（跨日期也成立，按界面顺序算）
    if (event.shiftKey && selectionAnchorId && selectionAnchorId !== noteId) {
        const ids = rangeIds(notes, selectionAnchorId, noteId);
        if (ids.length > 0) {
            applyRangeSelection(ids);
            return;
        }
    }
    if (!selectedNotes.has(noteId) && selectedNotes.size >= CONFIG.MAX_SELECTION) {
        alert(`最多只能选择${CONFIG.MAX_SELECTION}条笔记，请先取消选择一些笔记`);
        return;
    }
    setSelectionAnchorId(noteId);
    toggleNoteSelection(noteId);
    updateAllDateGroupSelectionUI();
}

/** 把一批 id 选上（受 MAX_SELECTION 限制），用于 Shift 区间选择。 */
function applyRangeSelection(ids) {
    let hitLimit = false;
    let added = 0;
    for (const id of ids) {
        if (selectedNotes.has(id)) continue;
        if (selectedNotes.size >= CONFIG.MAX_SELECTION) { hitLimit = true; break; }
        selectedNotes.add(id);
        updateNoteSelectionUI(id, true);
        added += 1;
    }
    updateAllDateGroupSelectionUI();
    updateSelectionUI();
    if (hitLimit) {
        showSaveIndicator(`一次最多 ${CONFIG.MAX_SELECTION} 条，本次选中了 ${added} 条`, { failed: true });
    } else if (added > 0) {
        showSaveIndicator(`已选中区间内 ${added} 条`);
    }
}

/** 全选：按界面顺序（时间从新到旧）取，最多 MAX_SELECTION 条。 */
function selectAllNotes() {
    if (notes.length === 0) return;
    selectedNotes.clear();
    const ordered = sortForDisplay(notes).slice(0, CONFIG.MAX_SELECTION);
    for (const note of ordered) {
        selectedNotes.add(note.id);
    }
    setSelectionAnchorId(ordered[0]?.id ?? null);
    // 折叠分组里的卡片可能没渲染，统一走"先清后刷"避免漏掉
    refreshAllSelectionUI();
    if (notes.length > CONFIG.MAX_SELECTION) {
        showSaveIndicator(`已选中最近 ${CONFIG.MAX_SELECTION} 条（共 ${notes.length} 条）`);
    }
}

/** 按当前 selectedNotes 全量刷新界面上的勾选态（含未渲染的折叠分组）。 */
function refreshAllSelectionUI() {
    document.querySelectorAll('.note-card[data-note-id]').forEach((element) => {
        element.classList.toggle('selected', selectedNotes.has(element.dataset.noteId));
    });
    updateAllDateGroupSelectionUI();
    updateSelectionUI();
}

/* ------------------------------------------------------------------ */
/* 批量编辑                                                            */
/* ------------------------------------------------------------------ */

function openBatchTagModal() {
    if (selectedNotes.size === 0) return;
    batchTagCount.textContent = selectedNotes.size;
    batchTagInput.value = '';
    batchTagMode.value = TAG_OP.ADD;
    // "移除"时得知道能填什么，所以把现有标签列出来
    const existing = collectTags(notes, [...selectedNotes]).slice(0, 8);
    batchTagExisting.textContent = existing.length
        ? `这批笔记现有标签：${existing.map((item) => `${item.tag}(${item.count})`).join('、')}`
        : '这批笔记目前都没有标签';
    batchTagModal.classList.remove('hidden');
    batchTagInput.focus();
}

function closeBatchTagModal() {
    if (batchTagModal) batchTagModal.classList.add('hidden');
}

async function applyBatchTag() {
    if (selectedNotes.size === 0) {
        closeBatchTagModal();
        return;
    }
    const mode = batchTagMode.value;
    const tag = batchTagInput.value;
    if (mode === TAG_OP.ADD && !tag.trim()) {
        alert('请填写要添加的标签');
        return;
    }
    const { notes: next, changed } = batchApplyTag(notes, [...selectedNotes], { mode, tag });
    setNotes(next);
    renderNotes();
    closeBatchTagModal();
    // 先等保存结束再提示：saveNotes 自己也会写"已保存"，不等它就会被覆盖掉
    await saveNotes();
    showSaveIndicator(changed > 0 ? `已更新 ${changed} 条笔记的标签` : '没有笔记需要改动');
}

async function batchDeleteSelected() {
    const count = selectedNotes.size;
    if (count === 0) return;
    if (!confirm(`确定删除选中的 ${count} 条笔记吗？删除后 ${UNDO_WINDOW_MS / 1000} 秒内可以撤销。`)) return;
    const ids = [...selectedNotes];
    // batchRemove 只返回删除的条数，撤销要的是笔记本身，所以先自己挑出来
    const removedNotes = notes.filter((note) => ids.includes(note.id));
    const { notes: next, removed } = batchRemove(notes, ids);
    setNotes(next);
    recordDeletion(removedNotes);
    clearSelection();
    exitSelectionMode();
    renderNotes();
    renderQuickPicks();
    updateQuickContinuity();
    await saveNotes();
    showSaveIndicator(`已删除 ${removed} 条笔记`);
}

function toggleNoteSelection(noteId) {
    if (selectedNotes.has(noteId)) {
        selectedNotes.delete(noteId);
        updateNoteSelectionUI(noteId, false);
    } else {
        selectedNotes.add(noteId);
        updateNoteSelectionUI(noteId, true);
    }
    updateSelectionUI();
}

function updateNoteSelectionUI(noteId, isSelected) {
    const noteElement = document.querySelector(`.note-card[data-note-id="${noteId}"]`);
    if (noteElement) {
        if (isSelected) noteElement.classList.add('selected');
        else noteElement.classList.remove('selected');
    }
}

function updateSelectionUI() {
    const count = selectedNotes.size;
    selectedCount.textContent = `已选中 ${count} 条笔记`;
    selectedNotesCount.textContent = count;
    if (count > 0) {
        selectionInfo.classList.remove('hidden');
        aiSummaryFloatBtn.classList.remove('hidden');
    } else {
        selectionInfo.classList.add('hidden');
        aiSummaryFloatBtn.classList.add('hidden');
    }
    if (selectionMode) {
        // 文案要如实反映点下去会发生什么，否则用户根本不知道还能取消
        selectionToggleBtn.innerHTML = count > 0
            ? `<i class="fa fa-check-circle mr-2"></i>确认，开始AI总结 (${count})`
            : '<i class="fa fa-times-circle mr-2"></i>退出选择模式';
    }
}

function clearSelection() {
    selectedNotes.forEach(noteId => updateNoteSelectionUI(noteId, false));
    selectedNotes.clear();
    updateAllDateGroupSelectionUI();
    updateSelectionUI();
}

function updateAllDateGroupSelectionUI() {
    dateGroupNotesMap.forEach((noteIds, dateGroup) => {
        updateDateGroupSelectionUI(dateGroup, noteIds);
    });
}

function updateDateGroupSelectionUI(dateGroup, noteIds) {
    if (!dateGroup || !noteIds || noteIds.length === 0) return;
    const dateHeader = dateGroup.querySelector('.date-header');
    if (!dateHeader) return;
    const allSelected = noteIds.every(id => selectedNotes.has(id));
    if (allSelected && noteIds.length > 0) dateHeader.classList.add('selected');
    else dateHeader.classList.remove('selected');
}

function bindDateGroupSelectionEvents() {
    document.querySelectorAll('.date-group').forEach(group => {
        // 必须从数据里取该分组的笔记：折叠的分组压根没有卡片节点，
        // 靠 DOM 兄弟节点收集会得到空数组，整组选择就失效了。
        const noteIds = notes.filter(n => n.date === group.dataset.date).map(n => n.id);
        dateGroupNotesMap.set(group, noteIds);
        const dateHeader = group.querySelector('.date-header');
        if (dateHeader) {
            dateHeader.addEventListener('click', handleDateGroupClick);
            dateHeader.style.cursor = 'pointer';
        }
        updateDateGroupSelectionUI(group, noteIds);
    });
}

function removeDateGroupSelectionEvents() {
    const dateHeaders = document.querySelectorAll('.date-header');
    dateHeaders.forEach(header => {
        header.removeEventListener('click', handleDateGroupClick);
        header.style.cursor = '';
        header.classList.remove('selected');
    });
    dateGroupNotesMap.clear();
}

function handleDateGroupClick(e) {
    e.stopPropagation();
    let group = e.target.closest('.date-group');
    if (!group) return;
    const noteIds = dateGroupNotesMap.get(group);
    if (!noteIds || noteIds.length === 0) return;
    const allSelected = noteIds.every(id => selectedNotes.has(id));
    if (allSelected) {
        noteIds.forEach(id => {
            selectedNotes.delete(id);
            updateNoteSelectionUI(id, false);
        });
        setDateGroupCollapsed(group, true);
    } else {
        const newSelections = noteIds.filter(id => !selectedNotes.has(id));
        if (selectedNotes.size + newSelections.length > CONFIG.MAX_SELECTION) {
            alert(`最多只能选择${CONFIG.MAX_SELECTION}条笔记，当前已选择${selectedNotes.size}条，无法再选择${newSelections.length}条`);
            return;
        }
        noteIds.forEach(id => {
            selectedNotes.add(id);
            updateNoteSelectionUI(id, true);
        });
        setDateGroupCollapsed(group, false);
    }
    updateDateGroupSelectionUI(group, noteIds);
    updateSelectionUI();
}


function initSelectionMode() {
    selectionToggleBtn.addEventListener('click', toggleSelectionMode);
    if (closeSelectionHintBtn) {
        // 提示条是"选择模式已开启"的横幅，关掉它 = 退出选择模式
        closeSelectionHintBtn.addEventListener('click', () => exitSelectionMode());
    }
    // 批量操作入口和选择状态在同一行，选中 0 条时整行是隐藏的
    if (selectAllBtn) selectAllBtn.addEventListener('click', selectAllNotes);
    if (batchTagBtn) batchTagBtn.addEventListener('click', openBatchTagModal);
    if (batchDeleteBtn) batchDeleteBtn.addEventListener('click', batchDeleteSelected);
    if (cancelBatchTagBtn) cancelBatchTagBtn.addEventListener('click', closeBatchTagModal);
    if (applyBatchTagBtn) applyBatchTagBtn.addEventListener('click', applyBatchTag);
    if (batchTagModal) {
        batchTagModal.addEventListener('click', (event) => {
            if (event.target === batchTagModal) closeBatchTagModal();
        });
    }
}

/* ------------------------------------------------------------------ */
/* 搜索                                                                */
/* ------------------------------------------------------------------ */

/** 输入即过滤：解析成词数组、更新状态、重画列表。 */
function applySearch(raw) {
    setSearchTerms(parseQuery(raw));
    const active = searchTerms.length > 0;
    if (searchClearBtn) searchClearBtn.classList.toggle('hidden', !active);
    if (searchStatus) searchStatus.classList.toggle('hidden', !active);
    renderNotes();
}

/** 结果条数要跟着数据变（新记一条、删一条、导入之后）。 */
function refreshSearchStatus() {
    if (!searchStatus) return;
    if (searchTerms.length === 0) {
        searchStatus.classList.add('hidden');
        return;
    }
    const matched = notes.filter((note) => matchNote(note, searchTerms).matched).length;
    searchStatus.textContent = resultLabel(matched, notes.length, searchTerms);
    searchStatus.classList.remove('hidden');
}

function clearSearch() {
    if (searchInput) searchInput.value = '';
    applySearch('');
    searchInput?.focus();
}

function initSearch() {
    if (!searchInput) return;
    searchInput.addEventListener('input', () => applySearch(searchInput.value));
    searchInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        // 别让 Esc 顺手关掉弹窗或退出选择模式，它在这里只负责清空搜索
        event.stopPropagation();
        if (searchInput.value) clearSearch();
        else searchInput.blur();
    });
    if (searchClearBtn) searchClearBtn.addEventListener('click', clearSearch);
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

function openStats() {
    if (!statsModal) return;
    statsState = { range: 'month', allocation: statsState.allocation, expanded: new Set(), timelineDate: null };
    renderStatsPanel();
    statsModal.classList.remove('hidden');
}

function closeStats() {
    if (statsModal) statsModal.classList.add('hidden');
}

/** 面板里当前该显示的日期列表（有记录的那些天，升序）。 */
function statsDates() {
    return [...dailyBuckets(filterByRange(notes, statsState.range)).keys()].sort();
}

function renderStatsPanel() {
    if (!statsContent) return;
    const scoped = filterByRange(notes, statsState.range);
    const dates = statsDates();
    // 时间轴默认落在范围内最近有记录的那天；换范围后要重新定位
    if (!statsState.timelineDate || !dates.includes(statsState.timelineDate)) {
        statsState.timelineDate = dates[dates.length - 1] || null;
    }
    renderStats(statsContent, {
        range: statsState.range,
        allocation: statsState.allocation,
        expanded: statsState.expanded,
        overview: overview(scoped),
        ranked: rankActivities(scoped, { allocation: statsState.allocation, limit: 40 }),
        hourly: hourHistogram(scoped),
        // 热力图刻意不受范围影响：它就是用来看"这一年记了多少"的
        heatmap: heatmapDays(notes, { days: 365 }),
        timelineDate: statsState.timelineDate,
        timeline: statsState.timelineDate ? timelineBlocks(notes, statsState.timelineDate) : []
    });
}

/** 面板里的交互统一用事件委托：面板内容是整块重绘的，逐个绑定会漏。 */
function handleStatsClick(event) {
    const trigger = event.target.closest('[data-stats-action]');
    if (!trigger) return;
    const action = trigger.dataset.statsAction;

    if (action === 'range') {
        statsState.range = trigger.dataset.range;
        statsState.expanded.clear();
        statsState.timelineDate = null;
    } else if (action === 'allocation') {
        statsState.allocation = trigger.dataset.allocation;
        statsState.expanded.clear();
    } else if (action === 'toggle-members') {
        const index = Number(trigger.dataset.index);
        if (statsState.expanded.has(index)) statsState.expanded.delete(index);
        else statsState.expanded.add(index);
    } else if (action === 'day-prev' || action === 'day-next') {
        const dates = statsDates();
        const current = dates.indexOf(statsState.timelineDate);
        const next = action === 'day-prev' ? current - 1 : current + 1;
        if (next < 0 || next >= dates.length) return;   // 到头了就不动
        statsState.timelineDate = dates[next];
    } else if (action === 'history') {
        // 直接返回：统计面板保持原样叠在下面，关掉历史就回到刚才的统计
        openActivityHistory(trigger.dataset.label);
        return;
    } else {
        return;
    }
    renderStatsPanel();
}

/* ------------------------------------------------------------------ */
/* 一件事的历史（A2）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 打开某个活动的历史。
 *
 * @param {string} label 活动名
 * @param {string[]} choices 从笔记卡片进来时的可切换项（`B站+吃饭` 有两个）
 */
function openActivityHistory(label, choices = []) {
    if (!historyModal || !historyContent || !label) return;
    const data = activityHistory(notes, label);
    data.choices = choices.length > 1 ? choices : [];
    if (historyTitle) historyTitle.textContent = `「${label}」的历史`;
    renderActivityHistory(historyContent, data);
    historyModal.classList.remove('hidden');
}

function closeActivityHistory() {
    if (historyModal) historyModal.classList.add('hidden');
}

function openHistoryForCurrentNote() {
    const note = notes.find((item) => item.id === currentNoteId);
    closeContextMenu();
    if (!note) return;
    // 多段标题（`B站+吃饭`）没有"整条的历史"这回事，得先挑一个活动
    const choices = activitiesInOrder(note.content);
    if (choices.length === 0) return;
    openActivityHistory(choices[0], choices);
}

/**
 * 跳到列表里的某条笔记：展开它所在的日期分组、滚过去、闪一下。
 *
 * 折叠的日期分组里根本没有卡片 DOM（惰性渲染），所以必须先展开再找。
 */
function jumpToNote(noteId) {
    const note = notes.find((item) => item.id === noteId);
    if (!note) return;
    closeActivityHistory();

    const locate = () => document.querySelector(`.note-card[data-note-id="${noteId}"]`);
    // 正在搜索时这条可能被过滤掉了，清空搜索再找，否则"跳过去"会落空
    if (!locate() && searchTerms && searchTerms.length > 0) {
        setSearchTerms([]);
        if (searchInput) searchInput.value = '';
        if (searchStatus) searchStatus.classList.add('hidden');
        renderNotes();
    }

    // 折叠分组里没有卡片 DOM，先把这一天展开（内部会补出惰性跳过的卡片）
    expandDateGroup(note.date);
    const card = locate();
    if (!card) return;
    try {
        card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch { /* jsdom 没有 scrollIntoView */ }
    card.style.transition = 'background-color 0.35s ease';
    card.style.backgroundColor = 'rgba(250, 204, 21, 0.35)';
    setTimeout(() => { card.style.backgroundColor = ''; }, 1200);
}

function handleHistoryClick(event) {
    const noteRow = event.target.closest('[data-history-note-id]');
    if (noteRow) {
        jumpToNote(noteRow.dataset.historyNoteId);
        return;
    }
    const chip = event.target.closest('[data-history-label]');
    if (chip) {
        const choices = [...historyContent.querySelectorAll('[data-history-label]')]
            .map((element) => element.dataset.historyLabel);
        openActivityHistory(chip.dataset.historyLabel, choices);
    }
}

function initStats() {
    if (statsBtn) statsBtn.addEventListener('click', openStats);
    if (closeStatsBtn) closeStatsBtn.addEventListener('click', closeStats);
    if (statsContent) statsContent.addEventListener('click', handleStatsClick);
    if (statsModal) {
        statsModal.addEventListener('click', (event) => {
            // 点面板外的遮罩关闭；点面板内部不关
            if (event.target === statsModal) closeStats();
        });
    }
}

function initHistory() {
    if (closeHistoryBtn) closeHistoryBtn.addEventListener('click', closeActivityHistory);
    if (historyContent) historyContent.addEventListener('click', handleHistoryClick);
    if (historyModal) {
        historyModal.addEventListener('click', (event) => {
            if (event.target === historyModal) closeActivityHistory();
        });
    }
}

/** 绑定导出 / 导入按钮（v1.2.0 功能）。 */
function initImportExport() {    if (exportBtn) exportBtn.addEventListener('click', toggleExportMenu);
    if (importBtn) importBtn.addEventListener('click', importNotes);
    if (importFileInput) importFileInput.addEventListener('change', handleFileImport);

    const exportMenu = document.getElementById('export-menu');
    if (exportMenu) {
        exportMenu.querySelectorAll('.export-menu-item').forEach((item) => {
            item.addEventListener('click', () => {
                closeExportMenu();
                exportNotes(item.dataset.format);
            });
        });
    }
}

/** 导出菜单：和右键菜单一样用 fixed 定位并按窗口夹回来，窄窗口下也不会跑出屏幕。 */
function openExportMenu() {
    const menu = document.getElementById('export-menu');
    if (!menu || !exportBtn) return;
    menu.classList.remove('hidden');
    const anchor = exportBtn.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const margin = 8;
    let left = anchor.left;
    let top = anchor.bottom + 4;
    if (left + box.width > window.innerWidth - margin) left = window.innerWidth - box.width - margin;
    if (left < margin) left = margin;
    if (top + box.height > window.innerHeight - margin) top = anchor.top - box.height - 4;
    if (top < margin) top = margin;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

function closeExportMenu() {
    const menu = document.getElementById('export-menu');
    if (menu) menu.classList.add('hidden');
}

function toggleExportMenu() {
    const menu = document.getElementById('export-menu');
    if (!menu) return;
    if (menu.classList.contains('hidden')) openExportMenu();
    else closeExportMenu();
}

/** 触发一次下载（桌面端 app:// 下同样有效）。 */
function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
}

/**
 * 导出全部笔记。
 * format: 'json'（无损备份，默认）/ 'md'（给人读）/ 'csv'（给表格和脚本）
 */
function exportNotes(format = 'json') {
    if (notes.length === 0) {
        alert('没有笔记可导出');
        return;
    }
    const text = format === 'md' ? notesToMarkdown(notes)
        : format === 'csv' ? notesToCsv(notes)
            : notesToJson(notes);
    downloadText(exportFilename(format, getCurrentDateString()), text, mimeFor(format));
    const label = format === 'md' ? 'Markdown' : format === 'csv' ? 'CSV' : 'JSON 备份';
    showSaveIndicator(`已导出 ${label}（${notes.length} 条）`);
}

/** 校验导入文件的结构；保留 color='' 这类合法取值。 */
function validateNoteImport(data) {
    const errors = [];
    if (typeof data !== 'object' || data === null) {
        return { valid: false, errors: ['数据格式无效'] };
    }
    if (!Array.isArray(data.notes)) {
        return { valid: false, errors: ['缺少 notes 数组'] };
    }

    const validNotes = [];
    data.notes.forEach((note, index) => {
        const label = `第 ${index + 1} 条笔记`;
        if (typeof note?.id !== 'string' || note.id === '') {
            errors.push(`${label}：缺少有效ID`);
            return;
        }
        if (typeof note.date !== 'string' || !parseDateString(note.date)) {
            errors.push(`${label}：日期无效`);
            return;
        }
        if (parseClockMinutes(note.timeStart) === null || parseClockMinutes(note.timeEnd) === null) {
            errors.push(`${label}：时间格式无效`);
            return;
        }
        if (typeof note.content !== 'string' || note.content === '') {
            errors.push(`${label}：缺少有效内容`);
            return;
        }
        validNotes.push({
            id: SAFE_ID_RE.test(note.id) ? note.id : generateUUID(),
            date: String(note.date).slice(0, 10),
            timeStart: note.timeStart,
            timeEnd: note.timeEnd,
            content: note.content.slice(0, CONFIG.MAX_CONTENT_LENGTH),
            tag: note.tag ? trimTagToLimit(String(note.tag)) : '',
            color: typeof note.color === 'string' ? note.color : '',
            details: note.details ? String(note.details).slice(0, CONFIG.MAX_DETAILS_LENGTH) : '',
            expanded: note.expanded === true,
            createdAt: Number.isFinite(Number(note.createdAt)) ? Number(note.createdAt) : Date.now(),
            updatedAt: Number.isFinite(Number(note.updatedAt)) ? Number(note.updatedAt) : Date.now()
        });
    });

    return { valid: validNotes.length > 0, errors, notes: validNotes };
}

function importNotes() {
    if (!importFileInput) return;
    importFileInput.click();
}

async function handleFileImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!file.name.endsWith('.json')) {
        alert('请选择 JSON 文件');
        event.target.value = '';
        return;
    }

    try {
        let importData;
        try {
            importData = JSON.parse(await file.text());
        } catch {
            alert('文件格式错误，无法解析 JSON');
            return;
        }

        const validation = validateNoteImport(importData);
        if (!validation.valid) {
            alert(`导入失败：\n${validation.errors.slice(0, 10).join('\n')}`
                + (validation.errors.length > 10 ? `\n…还有 ${validation.errors.length - 10} 条错误` : ''));
            return;
        }

        const existingIds = new Set(notes.map(n => n.id));
        const newNotes = validation.notes.filter(n => !existingIds.has(n.id));

        if (newNotes.length === 0) {
            alert('导入的笔记已全部存在，没有新的笔记需要导入');
            return;
        }

        const merge = confirm(
            `发现 ${newNotes.length} 条新笔记\n是否合并到现有笔记？\n\n`
            + '点击「确定」：合并（保留现有笔记）\n'
            + '点击「取消」：替换（用导入数据覆盖现有笔记）'
        );

        // 替换是破坏性操作，先备份本地副本
        if (!merge) backupLocalNotes();
        setNotes(merge ? [...newNotes, ...notes] : validation.notes);

        const result = await saveNotes();
        renderNotes();
        renderQuickPicks();
        updateQuickContinuity();
        showSaveIndicator(result.ok ? `已导入 ${newNotes.length} 条笔记` : `已导入到本机，尚未写入${STORE_LABEL}`);
    } catch (error) {
        console.error('[RFNOTER] 导入失败', error);
        alert(`导入失败：${error.message}`);
    } finally {
        event.target.value = '';
    }
}

function toggleSelectionMode() {
    if (!selectionMode) {
        enterSelectionMode();
        return;
    }
    // 一条都没选时，这个按钮就是"取消"——之前这里直接 alert 后 return，
    // 导致进入选择模式后不选任何笔记就再也退不出来（只能按 Esc）。
    if (selectedNotes.size === 0) {
        exitSelectionMode();
        return;
    }
    if (selectedNotes.size > CONFIG.MAX_SELECTION) {
        alert(`最多只能选择${CONFIG.MAX_SELECTION}条笔记进行AI总结，请减少选择数量`);
        return;
    }
    openAISummaryModal();
}

function enterSelectionMode() {
    setSelectionMode(true);
    selectionToggleBtn.innerHTML = '<i class="fa fa-check-circle mr-2"></i>确认，开始AI总结';
    selectionToggleBtn.classList.remove('btn-secondary');
    selectionToggleBtn.classList.add('btn-ai');
    selectionModeHint.classList.remove('hidden');
    clearSelection();
    bindDateGroupSelectionEvents();
    updateSelectionUI();
}

function exitSelectionMode() {
    setSelectionMode(false);
    setSelectionAnchorId(null);
    selectionToggleBtn.innerHTML = '<i class="fa fa-check-square-o mr-2"></i>选择笔记';
    selectionToggleBtn.classList.remove('btn-ai');
    selectionToggleBtn.classList.add('btn-secondary');
    selectionModeHint.classList.add('hidden');
    clearSelection();
    removeDateGroupSelectionEvents();
    updateSelectionUI();
}

function quickAddNote(e) {
    e.preventDefault();
    if (selectionMode) {
        alert('选择模式下无法添加新笔记，请先退出选择模式');
        return;
    }
    const date = getCurrentDateString();
    const timeStart = document.getElementById('quick-time-start').value;
    const timeEnd = document.getElementById('quick-time-end').value;
    const content = document.getElementById('quick-content').value.trim();
    const quickTagInput = document.getElementById('quick-tag');
    const tag = trimTagToLimit(quickTagInput.value.trim());
    quickTagInput.value = tag;
    if (!timeStart || !timeEnd || !content) {
        alert('请填写完整信息');
        return;
    }
    const newNote = {
        id: generateUUID(),
        date: date,
        timeStart: timeStart,
        timeEnd: timeEnd,
        content: content,
        tag: tag,
        color: 'note1',
        details: '',
        expanded: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    notes.unshift(newNote);
    saveNotes();
    // 增量插入，避免每新增一条就重建整个列表
    renderNoteElement(newNote);
    updateEmptyState();
    renderQuickPicks();
    const [hours, minutes] = timeEnd.split(':');
    const today = new Date();
    const endTime = new Date(today);
    endTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
    setLastEndTime(endTime.getTime());
    document.getElementById('quick-content').value = '';
    document.getElementById('quick-tag').value = '';
    hideSuggestions();
    initQuickInput();
    updateQuickContinuity();
    document.getElementById('quick-content').focus();
}

function openEditModal(noteId) {
    if (selectionMode) {
        alert('选择模式下无法编辑笔记，请先退出选择模式');
        return;
    }
    const noteIndex = notes.findIndex(note => note.id === noteId);
    if (noteIndex !== -1) {
        const note = notes[noteIndex];
        document.getElementById('modal-title').textContent = '编辑笔记';
        document.getElementById('note-date').value = note.date;
        document.getElementById('note-time-start').value = note.timeStart;
        document.getElementById('note-time-end').value = note.timeEnd;
        document.getElementById('note-content').value = note.content;
        document.getElementById('note-tag').value = trimTagToLimit(note.tag || '');
        document.getElementById('note-details').value = note.details || '';
        const currentColor = note.color ?? '';
        document.getElementById('note-color').value = currentColor;
        document.querySelectorAll('.color-dot').forEach(dot => {
            dot.classList.remove('border-4');
            if (dot.dataset.color === currentColor) dot.classList.add('border-4');
        });
        setCurrentNoteId(noteId);
        noteModal.classList.remove('hidden');
    }
}

function closeNoteModal() {
    noteModal.classList.add('hidden');
}

function saveNote() {
    const date = document.getElementById('note-date').value;
    const timeStart = document.getElementById('note-time-start').value;
    const timeEnd = document.getElementById('note-time-end').value;
    const content = document.getElementById('note-content').value.trim();
    const noteTagInput = document.getElementById('note-tag');
    const tag = trimTagToLimit(noteTagInput.value.trim());
    noteTagInput.value = tag;
    const details = document.getElementById('note-details').value.trim();
    const color = document.getElementById('note-color').value; // '' = 默认无颜色，不能再回落成 note1
    if (!date || !timeStart || !timeEnd || !content) {
        alert('请填写所有必填字段');
        return;
    }
    const noteData = { date, timeStart, timeEnd, content, tag, color, details, updatedAt: Date.now() };
    if (currentNoteId) {
        const noteIndex = notes.findIndex(note => note.id === currentNoteId);
        if (noteIndex !== -1) {
            notes[noteIndex] = { ...notes[noteIndex], ...noteData };
        }
    }
    saveNotes();
    renderNotes();
    renderQuickPicks();
    updateQuickContinuity();
    closeNoteModal();
}

function openDeleteModal(noteId) {
    if (selectionMode) {
        alert('选择模式下无法删除笔记，请先退出选择模式');
        return;
    }
    setCurrentNoteId(noteId);
    deleteModal.classList.remove('hidden');
}

function closeDeleteModal() {
    deleteModal.classList.add('hidden');
}

function deleteNote() {
    if (!currentNoteId) return;
    const noteId = currentNoteId;
    if (!notes.some(note => note.id === noteId)) {
        closeDeleteModal();
        closeContextMenu();
        return;
    }
    if (selectedNotes.has(noteId)) {
        selectedNotes.delete(noteId);
        updateSelectionUI();
    }
    const removeNote = () => {
        // 动画期间数组可能已经变化，必须在真正删除时按 id 重新定位
        const index = notes.findIndex(note => note.id === noteId);
        if (index === -1) return;
        const [removed] = notes.splice(index, 1);
        recordDeletion([removed]);
        saveNotes();
        // 把日期传下去：折叠分组里的卡片可能还没渲染，靠 DOM 找不到
        removeNoteElement(noteId, removed.date);
        updateEmptyState();
        renderQuickPicks();
        updateQuickContinuity();
    };
    // noteId 来自 normalizeNote / validateNoteImport，已被 SAFE_ID_RE 白名单约束，
    // 不含引号或反斜杠，可以直接放进属性选择器（也就不依赖 CSS.escape）
    const noteElement = document.querySelector(`[data-note-id="${noteId}"]`);
    if (noteElement) {
        noteElement.classList.add('animate-fade-out');
        setTimeout(removeNote, CONFIG.ANIMATION_DURATION);
    } else {
        removeNote();
    }
    closeDeleteModal();
    closeContextMenu();
}

/* ------------------------------------------------------------------ */
/* 撤销删除（A5）                                                      */
/* ------------------------------------------------------------------ */

/**
 * 撤销窗口。比普通提示长一些——"发现删错了"往往要隔几秒才反应过来。
 * 批量删除的确认文案里也用这个数字，所以别再写字面量。
 */
const UNDO_WINDOW_MS = 10000;

/**
 * 待撤销的删除，后进先出。
 *
 * 存的是**副本**：恢复时要把它们并回 notes，而 notes 是被整体替换的（setNotes），
 * 留着原引用容易被后续操作改到。
 * 不记"原来在第几个"——显示顺序由 createdAt 决定，并回去位置自然就对。
 */
let undoStack = [];
let undoTimer = null;

/** 记下一次删除，让它在接下来几秒内可撤销。 */
function recordDeletion(removedNotes) {
    if (!undoToast || !removedNotes || removedNotes.length === 0) return;
    undoStack.push({ notes: removedNotes.map((note) => ({ ...note })) });
    renderUndoToast();
    // 每来一次新的删除就续期：这一窗内的删除都能依次撤回
    clearTimeout(undoTimer);
    undoTimer = setTimeout(commitUndo, UNDO_WINDOW_MS);
}

function undoTotalCount() {
    return undoStack.reduce((sum, entry) => sum + entry.notes.length, 0);
}

function renderUndoToast() {
    if (!undoToast) return;
    if (undoStack.length === 0) {
        undoToast.classList.add('hidden');
        return;
    }
    undoToastText.textContent = `已删除 ${undoTotalCount()} 条笔记`;
    undoToast.classList.remove('hidden');
}

/** 关掉撤销提示 = 认了这些删除，之后只能从备份目录里找。 */
function commitUndo() {
    clearTimeout(undoTimer);
    undoTimer = null;
    undoStack = [];
    if (undoToast) undoToast.classList.add('hidden');
}

async function undoLastDeletion() {
    const entry = undoStack.pop();
    if (!entry) return;
    setNotes([...notes, ...entry.notes]);
    renderNotes();
    renderQuickPicks();
    updateQuickContinuity();
    updateEmptyState();
    // 先等保存结束再提示，否则会被 saveNotes 自己的"已保存"盖掉
    await saveNotes();
    showSaveIndicator(`已恢复 ${entry.notes.length} 条笔记`);
    renderUndoToast();
    if (undoStack.length === 0) clearTimeout(undoTimer);
}

function initUndo() {
    if (undoToastBtn) undoToastBtn.addEventListener('click', () => { undoLastDeletion(); });
    if (undoToastClose) undoToastClose.addEventListener('click', commitUndo);
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'z' && event.key !== 'Z') return;
        if (!(event.ctrlKey || event.metaKey) || event.shiftKey) return;
        // 输入框里的 Ctrl+Z 是"撤销我打的字"，交给浏览器
        const target = event.target;
        const tag = (target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || target.isContentEditable) return;
        if (undoStack.length === 0) return;
        event.preventDefault();
        undoLastDeletion();
    });
}

function duplicateNote() {
    if (!currentNoteId) return;
    const originalNote = notes.find(note => note.id === currentNoteId);
    if (!originalNote) {
        closeContextMenu();
        return;
    }

    const durationMinutes = calculateTimeDuration(originalNote.timeStart, originalNote.timeEnd);
    // 从「当前时间向上取整到 5 分钟」开始，紧挨着排一个等长的时间段
    const now = new Date();
    const roundedMinutes = Math.ceil(now.getMinutes() / 5) * 5;
    const startDate = new Date(
        now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), roundedMinutes, 0, 0
    );
    const startMinutes = startDate.getHours() * 60 + startDate.getMinutes();
    const duplicatedNote = {
        ...originalNote,
        id: generateUUID(),
        date: getCurrentDateString(startDate), // 跨天时（如 23:58）日期跟着开始时间走
        timeStart: minutesToClock(startMinutes),
        timeEnd: minutesToClock(startMinutes + durationMinutes),
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    notes.unshift(duplicatedNote);
    saveNotes();
    renderNotes();
    renderQuickPicks();
    updateQuickContinuity();
    closeContextMenu();
}

function changeNoteColor(color) {
    if (!currentNoteId) return;
    const noteIndex = notes.findIndex(note => note.id === currentNoteId);
    if (noteIndex !== -1) {
        notes[noteIndex].color = color; // '' 是合法值，代表"默认无颜色"
        notes[noteIndex].updatedAt = Date.now();
        saveNotes();
        renderNotes();
    }
    closeContextMenu();
}

function openContextMenu(event, noteId) {
    if (selectionMode) return;
    setCurrentNoteId(noteId);
    // 先显示再量尺寸：菜单尺寸不固定（有无"颜色标记"子菜单），必须先渲染才能量准
    contextMenu.classList.remove('hidden');
    const rect = contextMenu.getBoundingClientRect();
    const margin = 8;
    let left = event.clientX;
    let top = event.clientY;
    // 靠右/靠下时往回缩，否则菜单会被窗口边缘截断、点不到后面的项
    if (left + rect.width + margin > window.innerWidth) {
        left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (top + rect.height + margin > window.innerHeight) {
        top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    contextMenu.style.left = `${left}px`;
    contextMenu.style.top = `${top}px`;
    // 注意：这里不能再 addEventListener。监听器统一在 bindEventListeners 里绑定一次，
    // 否则每开一次右键菜单就多一份 toggle 监听，行为会随打开次数漂移。
}

function closeContextMenu() {
    contextMenu.classList.add('hidden');
    colorSubmenu.classList.add('hidden');
}

function showColorSubmenu(e) {
    if (e) e.stopPropagation();
    colorSubmenu.classList.toggle('hidden');
}

/** 只写本地副本，不触发服务端全量保存（用于展开/收起这类纯界面状态）。 */
function persistViewState() {
    saveNotesLocally(notes);
    updateSyncStatus();
}

/** 把最新的同步状态反映到界面上的小徽标。 */
function updateSyncStatus() {
    const badge = document.getElementById('sync-status');
    if (!badge) return;
    const warnClass = 'text-xs px-2 py-1 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200';
    if (offlineMode) {
        badge.textContent = `读取${STORE_LABEL}失败 · 正在使用本机副本`;
        badge.className = warnClass;
    } else if (hasPendingChanges()) {
        badge.textContent = `有改动未写入${STORE_LABEL}`;
        badge.className = warnClass;
    } else {
        badge.textContent = '';
        badge.className = 'hidden';
    }
}

async function saveNotes() {
    const result = await saveNotesToServer(notes);
    setLastSaveFailed(!result.ok);
    if (result.ok) {
        setOfflineMode(false);
        showSaveIndicator('已保存');
    } else {
        showSaveIndicator(`未写入${STORE_LABEL}，点击重试`, { failed: true });
    }
    updateSyncStatus();
    return result;
}

function showSaveIndicator(message = '已保存', { failed = false } = {}) {
    const indicator = document.getElementById('save-indicator');
    const icon = indicator.querySelector('i');
    indicator.querySelector('span').textContent = message;
    icon.classList.toggle('fa-check-circle', !failed);
    icon.classList.toggle('text-green-500', !failed);
    icon.classList.toggle('fa-exclamation-triangle', failed);
    icon.classList.toggle('text-amber-500', failed);
    indicator.classList.toggle('cursor-pointer', failed);
    indicator.classList.remove('translate-y-10', 'opacity-0');
    clearTimeout(showSaveIndicator.timer);
    showSaveIndicator.timer = setTimeout(() => {
        indicator.classList.add('translate-y-10', 'opacity-0');
    }, failed ? 5000 : 2000);
}

function openHelpModal() {
    helpModal.classList.remove('hidden');
    helpContent.textContent = '教程加载中...';
    fetch('flash-noter-tutorial.md')
        .then(r => {
            // fetch 对 404 不会 reject，必须自己检查状态码，否则会把 404 页面当成教程显示
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.text();
        })
        .then(md => { helpContent.innerHTML = markdownToHtml(md); })
        .catch((e) => {
            console.warn('[RFNOTER] 教程加载失败', e);
            helpContent.innerHTML = '教程加载失败，请确认 <code>flash-noter-tutorial.md</code> 存在于 <code>public/</code> 目录下。';
        });
}

function closeHelpModal() {
    helpModal.classList.add('hidden');
}

function bindEventListeners() {
    initSelectionMode();
    initSearch();
    initStats();
    initHistory();
    initUndo();
    if (quickContinueBtn) quickContinueBtn.addEventListener('click', fillGapToNow);

    // 时间微调：按钮只服务最高频的「结束时间」，两个输入框都支持 Alt+↑/↓
    document.querySelectorAll('.time-step-btn[data-target]').forEach((btn) => {
        btn.addEventListener('click', () => {
            stepTimeInput(btn.dataset.target, Number(btn.dataset.delta));
        });
    });
    const quickNowBtn = document.getElementById('quick-now-btn');
    if (quickNowBtn) quickNowBtn.addEventListener('click', setEndTimeToNow);
    ['quick-time-start', 'quick-time-end'].forEach((id) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.addEventListener('keydown', (event) => {
            if (!event.altKey) return;
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            stepTimeInput(id, event.key === 'ArrowUp' ? 5 : -5);
        });
    });

    quickAddForm.addEventListener('submit', quickAddNote);
    const quickTagEl = document.getElementById('quick-tag');
    if (quickTagEl) quickTagEl.addEventListener('input', () => { quickTagEl.value = trimTagToLimit(quickTagEl.value); });

    // 标题输入框的补全：输入即给候选，键盘可上下选、Enter/Tab 采纳
    const quickContentEl = document.getElementById('quick-content');
    if (quickContentEl) {
        quickContentEl.addEventListener('input', renderSuggestions);
        quickContentEl.addEventListener('keydown', handleQuickContentKeydown);
        // 失焦就收起来。用 setTimeout 是为了让候选行的 mousedown 先跑完——
        // 直接隐藏会让点击落空（DOM 已经没了）
        quickContentEl.addEventListener('blur', () => setTimeout(hideSuggestions, 0));
        // 重新聚焦时若已有内容，立刻恢复提示（比如用热键唤出、内容还在）
        quickContentEl.addEventListener('focus', renderSuggestions);
    }
    document.getElementById('save-note-btn').addEventListener('click', saveNote);
    document.getElementById('cancel-note-btn').addEventListener('click', closeNoteModal);
    const noteTagEl = document.getElementById('note-tag');
    if (noteTagEl) noteTagEl.addEventListener('input', () => { noteTagEl.value = trimTagToLimit(noteTagEl.value); });
    document.getElementById('confirm-delete-btn').addEventListener('click', deleteNote);
    document.getElementById('cancel-delete-btn').addEventListener('click', closeDeleteModal);
    document.getElementById('edit-note-menu-btn').addEventListener('click', () => { closeContextMenu(); openEditModal(currentNoteId); });
    document.getElementById('duplicate-note-menu-btn').addEventListener('click', duplicateNote);
    document.getElementById('history-note-menu-btn').addEventListener('click', openHistoryForCurrentNote);
    document.getElementById('delete-note-menu-btn').addEventListener('click', () => { closeContextMenu(); openDeleteModal(currentNoteId); });
    if (helpBtn) helpBtn.addEventListener('click', openHelpModal);
    if (closeHelpBtn) closeHelpBtn.addEventListener('click', closeHelpModal);
    if (closeHelpBtn2) closeHelpBtn2.addEventListener('click', closeHelpModal);
    if (helpModal) helpModal.addEventListener('click', (e) => { if (e.target === helpModal) closeHelpModal(); });
    // 颜色子菜单只在这里绑定一次：click 切换显示，移动端也能用（不依赖 hover）
    colorMenuBtn.addEventListener('click', showColorSubmenu);
    document.querySelectorAll('.color-dot').forEach(dot => {
        dot.addEventListener('click', (e) => {
            e.stopPropagation();
            const color = dot.dataset.color ?? '';
            // 只重置当前可见区域里的色点高亮，避免动了编辑弹窗里的选中态
            const scope = dot.closest('#color-submenu') || dot.closest('#note-modal') || document;
            scope.querySelectorAll('.color-dot').forEach(d => d.classList.remove('border-4'));
            dot.classList.add('border-4');
            if (!noteModal.classList.contains('hidden')) document.getElementById('note-color').value = color;
            else changeNoteColor(color);
        });
    });
    document.getElementById('save-indicator').addEventListener('click', () => {
        if (lastSaveFailed) saveNotes();
    });
    document.addEventListener('click', (e) => {
        if (!contextMenu.contains(e.target)) closeContextMenu();
        // 导出菜单：点按钮本身要交给它的 toggle 处理，否则会"开了立刻关"
        const menu = document.getElementById('export-menu');
        const onButton = exportBtn && (exportBtn === e.target || exportBtn.contains(e.target));
        if (menu && !menu.contains(e.target) && !onButton) closeExportMenu();
    });
    noteModal.addEventListener('click', (e) => { if (e.target === noteModal) closeNoteModal(); });
    deleteModal.addEventListener('click', (e) => { if (e.target === deleteModal) closeDeleteModal(); });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        // 历史面板是从统计面板里点开的，两层叠着；Esc 先收上面那层
        if (historyModal && !historyModal.classList.contains('hidden')) {
            closeActivityHistory();
            return;
        }
        // Esc 只关闭「确实开着」的东西；关弹窗不应该顺手清空已选笔记
        const aiSummaryOpen = !aiSummaryModal.classList.contains('hidden');
        const aiResultOpen = !aiResultModal.classList.contains('hidden');
        const anyOpen = anyModalOpen();
        closeNoteModal();
        closeDeleteModal();
        closeContextMenu();
        closeExportMenu();
        closeBatchTagModal();
        closeStats();
        closeHelpModal();
        if (aiSummaryOpen) closeAISummaryModal();
        if (aiResultOpen) closeAIResultModal();
        else if (!anyOpen && selectionMode) exitSelectionMode();
    });
}

function anyModalOpen() {
    return [noteModal, deleteModal, helpModal, aiSummaryModal, aiResultModal, batchTagModal, statsModal, historyModal]
        .some(modal => modal && !modal.classList.contains('hidden'));
}

function bindAIEventListeners() {
    aiSummaryFloatBtn.addEventListener('click', openAISummaryModal);
    clearSelectionBtn.addEventListener('click', clearSelection);
    cancelSummaryBtn.addEventListener('click', () => { closeAISummaryModal(); exitSelectionMode(); });
    generateSummaryBtn.addEventListener('click', generateSummary);
    document.getElementById('toggle-api-config').addEventListener('click', toggleApiConfig);
    document.getElementById('toggle-api-key').addEventListener('click', toggleApiKeyVisibility);
    document.getElementById('api-key').addEventListener('change', refreshModelOptions);
    document.getElementById('temperature').addEventListener('input', updateTemperatureValue);
    document.getElementById('copy-summary-btn').addEventListener('click', copySummaryToClipboard);
    document.getElementById('save-as-note-btn').addEventListener('click', saveSummaryAsNote);
    document.getElementById('regenerate-summary-btn').addEventListener('click', regenerateSummary);
    document.getElementById('adjust-config-btn').addEventListener('click', backToConfig);
    document.getElementById('retry-summary-btn').addEventListener('click', retrySummary);
    document.getElementById('back-to-config-btn').addEventListener('click', backToConfig);
    aiSummaryModal.addEventListener('click', (e) => {
        if (e.target === aiSummaryModal) { closeAISummaryModal(); exitSelectionMode(); }
    });
    aiResultModal.addEventListener('click', (e) => {
        if (e.target === aiResultModal) closeAIResultModal();
    });
}

/** 用密钥拉一次可用模型列表，避免内置模型名过期后再也调不通。 */
async function refreshModelOptions() {
    const select = document.getElementById('model');
    const apiKey = document.getElementById('api-key').value.trim();
    if (!select || !apiKey) return;
    const models = await fetchAvailableModels(apiKey);
    if (models.length === 0) return;
    const previous = select.value;
    select.innerHTML = models
        .map(id => `<option value="${escapeHTML(id)}">${escapeHTML(id)}</option>`)
        .join('');
    if (models.includes(previous)) select.value = previous;
}

// 注意：API 密钥自 v1.2.0 起只存在内存中（api.js 的 memoryApiKey），
// 刷新页面后需要重新输入，这里不再从 localStorage 回填。

function toggleApiConfig() {
    const section = document.getElementById('api-config-section');
    const icon = this.querySelector('i.fa-chevron-down');
    section.classList.toggle('hidden');
    if (icon) {
        icon.classList.toggle('fa-chevron-down');
        icon.classList.toggle('fa-chevron-up');
    }
}

function toggleApiKeyVisibility() {
    const apiKeyInput = document.getElementById('api-key');
    const icon = this.querySelector('i');
    if (apiKeyInput.type === 'password') {
        apiKeyInput.type = 'text';
        icon.classList.remove('fa-eye');
        icon.classList.add('fa-eye-slash');
    } else {
        apiKeyInput.type = 'password';
        icon.classList.remove('fa-eye-slash');
        icon.classList.add('fa-eye');
    }
}

function updateTemperatureValue() {
    document.getElementById('temp-value').textContent = this.value;
}

function openAISummaryModal() {
    if (selectedNotes.size === 0) return;
    if (selectedNotes.size > CONFIG.MAX_SELECTION) {
        alert(`最多只能选择${CONFIG.MAX_SELECTION}条笔记进行AI总结，请减少选择数量`);
        return;
    }
    modalSelectedCount.textContent = selectedNotes.size;
    selectedNotesPreview.innerHTML = '';
    const selectedNoteList = Array.from(selectedNotes)
        .map(id => notes.find(note => note.id === id))
        .filter(note => note)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    selectedNoteList.forEach(note => {
        const noteElement = document.createElement('div');
        noteElement.className = 'flex items-center justify-between p-2 border border-gray-200 rounded hover:bg-gray-50 transition-colors duration-150';
        noteElement.innerHTML = `
            <div class="flex-1 min-w-0">
                <div class="flex items-center space-x-2 mb-1">
                    <span class="text-xs text-gray-500">${escapeHTML(formatDateForDisplay(note.date))}</span>
                    <span class="text-xs text-gray-700">${escapeHTML(note.timeStart)} ~ ${escapeHTML(note.timeEnd)}</span>
                    ${note.tag ? `<span class="tag">${escapeHTML(note.tag)}</span>` : ''}
                </div>
                <p class="text-sm text-gray-800 truncate">${escapeHTML(note.content)}</p>
            </div>
            <button class="ml-2 text-gray-400 hover:text-red-500 transition-colors duration-150 active:scale-95" data-note-id="${escapeHTML(note.id)}"><i class="fa fa-times"></i></button>
        `;
        const removeBtn = noteElement.querySelector('button');
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const noteId = removeBtn.dataset.noteId;
            selectedNotes.delete(noteId);
            updateNoteSelectionUI(noteId, false);
            updateSelectionUI();
            openAISummaryModal();
        });
        selectedNotesPreview.appendChild(noteElement);
    });
    aiSummaryModal.classList.remove('hidden');
}

function closeAISummaryModal() {
    aiSummaryModal.classList.add('hidden');
}

/** 生成中禁用所有会触发 API 调用的按钮，避免连点扣多次费。 */
function setSummaryBusy(busy) {
    setSummaryInFlight(busy);
    ['generate-summary-btn', 'retry-summary-btn', 'regenerate-summary-btn'].forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.disabled = busy;
        btn.classList.toggle('opacity-60', busy);
        btn.classList.toggle('pointer-events-none', busy);
    });
}

async function generateSummary() {
    if (summaryInFlight) return;
    const apiKey = document.getElementById('api-key').value.trim();
    if (!apiKey) {
        alert('请输入 DeepSeek API 密钥');
        document.getElementById('api-key').focus();
        return;
    }
    setApiKey(apiKey);
    const style = document.querySelector('input[name="summary-style"]:checked').value;
    const format = document.querySelector('input[name="output-format"]:checked').value;
    const customPrompt = document.getElementById('custom-prompt').value.trim();
    const model = document.getElementById('model').value;
    const temperature = parseFloat(document.getElementById('temperature').value);
    const selectedNoteList = Array.from(selectedNotes)
        .map(id => notes.find(note => note.id === id))
        .filter(note => note)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const requestData = {
        selectedNotes: selectedNoteList.map(note => ({
            date: note.date,
            timeRange: `${note.timeStart} ~ ${note.timeEnd}`,
            content: note.content,
            tag: note.tag,
            details: note.details || ''
        })),
        summaryConfig: { style, format, customPrompt },
        apiConfig: { model, temperature }
    };
    setCurrentSummaryConfig({ requestData, selectedNotes: Array.from(selectedNotes) });
    closeAISummaryModal();
    aiResultModal.classList.remove('hidden');
    summaryLoading.classList.remove('hidden');
    summaryContent.classList.add('hidden');
    summaryError.classList.add('hidden');
    resultNoteCount.textContent = selectedNoteList.length;
    setSummaryBusy(true);
    try {
        const prompt = buildPrompt(requestData);
        const summary = await callDeepSeekAPI(apiKey, model, prompt, temperature);
        showSummaryResult(summary, selectedNoteList.length);
    } catch (error) {
        showSummaryError(error);
    } finally {
        setSummaryBusy(false);
    }
}

function buildPrompt(requestData) {
    const { selectedNotes, summaryConfig } = requestData;
    const { style, format, customPrompt } = summaryConfig;
    const styleInstructions = {
        '简洁摘要': '用尽量短的篇幅概括，突出结论与要点，不要展开细节',
        '详细报告': '分点展开，保留关键数据、结论与待办，结构清晰',
        '记忆回溯': '采用记忆回溯口吻，节奏舒缓、细节充分，可以渲染情绪，但不得虚构事实'
    };
    const styleInstruction = styleInstructions[style] || '按照所选风格输出';

    let prompt = `你是一个专业的笔记总结助手，擅长将分散的笔记信息整理成有结构的总结。\n\n`
        + `以下是 ${selectedNotes.length} 条笔记，已按记录时间先后排列：\n`;
    selectedNotes.forEach((note, index) => {
        const rawDetails = String(note.details || '');
        const details = rawDetails.slice(0, 500);
        prompt += `\n${index + 1}. 【${note.date} ${note.timeRange}】${note.tag ? ` [标签：${note.tag}]` : ''}\n`
            + `标题：${note.content}\n`
            + (details ? `详情：${details}${rawDetails.length > 500 ? '…（已截断）' : ''}\n` : '');
    });
    prompt += `\n总结要求：\n1. 总结风格：${style}\n2. 风格细则：${styleInstruction}\n3. 输出格式必须遵循：${format}\n`
        + `4. ${customPrompt || '请对以上笔记进行系统性的总结，突出关键信息和主题'}\n`
        + `5. 必须基于原始笔记内容，不得虚构事实\n`
        + `6. 如有矛盾信息，请注明\n7. 用中文输出\n\n请直接给出总结内容，不需要额外的说明文字。`;
    return prompt;
}

function showSummaryResult(summary, noteCount) {
    summaryLoading.classList.add('hidden');
    summaryContent.classList.remove('hidden');
    const format = currentSummaryConfig.requestData.summaryConfig.format;
    if (format === 'Markdown格式') {
        summaryText.innerHTML = markdownToHtml(summary);
    } else if (format === 'HTML格式') {
        // AI 输出属于不可信内容：只保留白名单标签与属性
        summaryText.innerHTML = sanitizeHtml(summary);
    } else {
        summaryText.textContent = summary;
    }
    summaryStats.textContent = `${summary.length}字 ${countWords(summary)}词`;
    setCurrentSummaryResult(summary);
    resultNoteCount.textContent = noteCount;
    // 注意：这里不能调用 exitSelectionMode()。
    // 否则选中集被清空后，"重新生成 / 调整配置"会因为 openAISummaryModal 的
    // `selectedNotes.size === 0` 提前 return 而变成死路。
    updateSyncStatus();
}

function showSummaryError(error) {
    summaryLoading.classList.add('hidden');
    summaryError.classList.remove('hidden');
    let message;
    if (error instanceof ApiError && error.status) {
        const byStatus = {
            400: 'API 请求有误（可能是模型名已失效），请检查模型设置',
            401: 'API 密钥无效，请检查并重新输入',
            402: '账户余额不足，请前往 DeepSeek 平台充值',
            403: '没有访问该模型的权限',
            404: '接口或模型不存在，请检查模型设置',
            422: '请求参数不合法，请检查模型与提示词',
            429: '请求过于频繁，请稍后再试',
            500: 'AI 服务暂时不可用，请稍后重试',
            502: 'AI 服务网关异常，请稍后重试',
            503: 'AI 服务繁忙，请稍后重试',
            504: 'AI 服务响应超时，请稍后重试'
        };
        message = byStatus[error.status] || error.message;
    } else {
        message = error?.message || '生成总结时发生错误';
    }
    errorMessage.textContent = message;
}

async function copySummaryToClipboard() {
    try {
        await navigator.clipboard.writeText(currentSummaryResult);
        showSaveIndicator('已复制到剪贴板');
    } catch (err) {
        alert('复制失败，请手动选择文本复制');
    }
}

function saveSummaryAsNote() {
    const today = new Date();
    const dateStr = getCurrentDateString();
    const timeStr = today.toTimeString().slice(0, 5);
    const sourceCount = currentSummaryConfig?.selectedNotes?.length || 0;
    const newNote = {
        id: generateUUID(),
        date: dateStr,
        timeStart: timeStr,
        timeEnd: timeStr,
        content: `${dateStr} 笔记总结`,
        tag: 'AI总结',
        color: 'ai',
        details: `基于 ${sourceCount} 条笔记的AI总结：\n\n${currentSummaryResult}\n\n来源笔记ID: ${(currentSummaryConfig.selectedNotes || []).join(', ')}`,
        expanded: false,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    notes.unshift(newNote);
    saveNotes();
    renderNotes();
    clearSelection();
    closeAIResultModal();
    showSaveIndicator('已保存为新笔记');
}

/** 重新生成：沿用当前配置，直接再问一次。 */
function regenerateSummary() {
    summaryError.classList.add('hidden');
    summaryLoading.classList.remove('hidden');
    summaryContent.classList.add('hidden');
    generateSummaryFromConfig();
}

/** 调整配置：回到配置弹窗（选中集还在，可以改风格/格式/提示词）。 */
function backToConfig() {
    aiResultModal.classList.add('hidden');
    if (selectedNotes.size === 0) {
        // 兜底：选中集万一被清空（比如用户手动清空过），用生成时记录的那批笔记恢复
        (currentSummaryConfig?.selectedNotes || []).forEach(id => selectedNotes.add(id));
        if (selectedNotes.size > 0 && !selectionMode) enterSelectionMode();
    }
    openAISummaryModal();
}

function retrySummary() {
    summaryError.classList.add('hidden');
    summaryLoading.classList.remove('hidden');
    generateSummaryFromConfig();
}

async function generateSummaryFromConfig() {
    if (summaryInFlight) return;
    try {
        const apiKey = getApiKey();
        if (!apiKey) {
            showSummaryError(new Error('API 密钥已在本次会话中失效，请重新输入'));
            return;
        }
        const { requestData } = currentSummaryConfig;
        const { model, temperature } = requestData.apiConfig;
        const prompt = buildPrompt(requestData);
        setSummaryBusy(true);
        const summary = await callDeepSeekAPI(apiKey, model, prompt, temperature);
        resultNoteCount.textContent = requestData.selectedNotes.length;
        showSummaryResult(summary, requestData.selectedNotes.length);
    } catch (error) {
        showSummaryError(error);
    } finally {
        setSummaryBusy(false);
    }
}

function closeAIResultModal() {
    aiResultModal.classList.add('hidden');
    exitSelectionMode();
}
