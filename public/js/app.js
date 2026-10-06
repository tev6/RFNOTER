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
import { CONFIG, STORE_LABEL, SAFE_ID_RE } from './config.js';
import {
    initRender, setRenderHooks, renderNotes, renderNoteElement,
    removeNoteElement, updateEmptyState, setDateGroupCollapsed
} from './render.js';
import {
    notes, currentNoteId, lastEndTime, selectedNotes,
    currentSummaryConfig, currentSummaryResult, selectionMode,
    dateGroupNotesMap, offlineMode, lastSaveFailed, summaryInFlight,
    lazyGroupNotes, resetState,
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
        bindGroupSelectionEvents: bindDateGroupSelectionEvents
    });
    // 先绑定事件，再加载数据：即使数据异常，界面也不会变成一张点不动的死图。
    try {
        bindEventListeners();
        bindAIEventListeners();
        initImportExport();
        initQuickInput();
        initDesktopBridge();
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
 * 依据：1133 条真实数据里 40.5% 的标题是重复的（CS 用了 146 次、B站 90 次），
 * 而这些重复正是每天 11.7 次录入里最浪费时间的部分。
 * 数据全部现算，不新增存储、不需要迁移。
 */
function computeQuickPicks(limit = 8) {
    const stats = new Map();
    for (const note of notes) {
        const key = (note.content || '').trim();
        if (!key) continue;
        const entry = stats.get(key) || { count: 0, lastUsedAt: 0 };
        entry.count += 1;
        entry.lastUsedAt = Math.max(entry.lastUsedAt, Number(note.createdAt) || 0);
        stats.set(key, entry);
    }
    const now = Date.now();
    const week = 7 * 86400000;
    return [...stats.entries()]
        .filter(([, entry]) => entry.count >= 2)   // 只用过一次的不算"常用"
        .map(([content, entry]) => ({
            content,
            count: entry.count,
            lastUsedAt: entry.lastUsedAt,
            // 频率为主；最近一周用过的额外加权，避免旧习惯长期占位
            score: entry.count + (now - entry.lastUsedAt < week ? 3 : 0)
        }))
        .sort((a, b) => b.score - a.score || b.lastUsedAt - a.lastUsedAt)
        .slice(0, limit);
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
    picks.forEach(({ content, count }) => {
        const chip = document.createElement('button');
        chip.type = 'button';   // 必须在表单外/非 submit，否则点一下就把笔记提交了
        chip.className = 'px-2.5 py-1 text-xs rounded-full bg-white border border-gray-300 text-gray-700 hover:border-primary hover:text-primary transition-colors duration-150';
        chip.textContent = content;
        chip.title = `用过 ${count} 次 · 点击填入，双击直接记录`;
        chip.addEventListener('click', () => fillQuickContent(content));
        chip.addEventListener('dblclick', () => {
            fillQuickContent(content);
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
    if (!selectedNotes.has(noteId) && selectedNotes.size >= CONFIG.MAX_SELECTION) {
        alert(`最多只能选择${CONFIG.MAX_SELECTION}条笔记，请先取消选择一些笔记`);
        return;
    }
    toggleNoteSelection(noteId);
    updateAllDateGroupSelectionUI();
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
}

/** 绑定导出 / 导入按钮（v1.2.0 功能）。 */
function initImportExport() {
    if (exportBtn) exportBtn.addEventListener('click', toggleExportMenu);
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
    const warnClass = 'text-xs px-2 py-1 rounded-full bg-amber-100 text-amber-800';
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
    document.getElementById('save-note-btn').addEventListener('click', saveNote);
    document.getElementById('cancel-note-btn').addEventListener('click', closeNoteModal);
    const noteTagEl = document.getElementById('note-tag');
    if (noteTagEl) noteTagEl.addEventListener('input', () => { noteTagEl.value = trimTagToLimit(noteTagEl.value); });
    document.getElementById('confirm-delete-btn').addEventListener('click', deleteNote);
    document.getElementById('cancel-delete-btn').addEventListener('click', closeDeleteModal);
    document.getElementById('edit-note-menu-btn').addEventListener('click', () => { closeContextMenu(); openEditModal(currentNoteId); });
    document.getElementById('duplicate-note-menu-btn').addEventListener('click', duplicateNote);
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
        // Esc 只关闭「确实开着」的东西；关弹窗不应该顺手清空已选笔记
        const aiSummaryOpen = !aiSummaryModal.classList.contains('hidden');
        const aiResultOpen = !aiResultModal.classList.contains('hidden');
        const anyOpen = anyModalOpen();
        closeNoteModal();
        closeDeleteModal();
        closeContextMenu();
        closeExportMenu();
        closeHelpModal();
        if (aiSummaryOpen) closeAISummaryModal();
        if (aiResultOpen) closeAIResultModal();
        else if (!anyOpen && selectionMode) exitSelectionMode();
    });
}

function anyModalOpen() {
    return [noteModal, deleteModal, helpModal, aiSummaryModal, aiResultModal]
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
