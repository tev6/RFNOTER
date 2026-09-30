import {
    generateUUID, getCurrentDateString, formatRelativeTime, formatDateForDisplay,
    calculateTimeDuration, formatDuration, trimTagToLimit, markdownToHtml,
    isTodayDate, groupNotesByDate, escapeHTML, sanitizeHtml, parseDateString,
    parseClockMinutes, minutesToClock, countWords
} from './utils.js';
import {
    loadNotes, saveNotesToServer, saveNotesLocally, callDeepSeekAPI,
    backupLocalNotes, hasPendingChanges, fetchAvailableModels,
    setApiKey, getApiKey, ApiError, REQUEST_TIMEOUT_MS
} from './api.js';

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** 集中管理常量（延续 v1.2.0 的 CONFIG 约定）。 */
const CONFIG = {
    MAX_SELECTION: 100,               // 单次 AI 总结最多可选笔记数
    API_TIMEOUT: REQUEST_TIMEOUT_MS,  // API 超时（真实值来自 api.js）
    DEFAULT_DURATION_MINUTES: 40,     // 快速添加的默认时长
    TAG_LIMIT: 20,                    // 标签上限（一个汉字算 2 个单位）
    MAX_CONTENT_LENGTH: 5000,         // 导入时标题最大长度
    MAX_DETAILS_LENGTH: 10000,        // 导入时详情最大长度
    ANIMATION_DURATION: 200,          // 删除动画时长（毫秒）
    COLOR_MAP: {
        'note1': '#3b82f6',
        'note2': '#10b981',
        'note3': '#f59e0b',
        'note4': '#ef4444',
        'note5': '#8b5cf6',
        'ai': '#8b5cf6',
        '': '#3b82f6'
    }
};

let notes = [];
let currentNoteId = null;
let lastEndTime = null;
let selectedNotes = new Set();
let currentSummaryConfig = {};
let currentSummaryResult = null;
let selectionMode = false;
let dateGroupNotesMap = new Map();
let offlineMode = false;
let lastSaveFailed = false;

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

document.addEventListener('DOMContentLoaded', async () => {
    // 先绑定事件，再加载数据：即使数据异常，界面也不会变成一张点不动的死图。
    try {
        bindEventListeners();
        bindAIEventListeners();
        initImportExport();
        initQuickInput();
    } catch (e) {
        console.error('[RFNOTER] 界面初始化失败', e);
    }
    await initializeNotes();
});

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
    offlineMode = result.offline === true;

    if (result.needImportConfirm) {
        const confirmed = window.confirm(
            `检测到本机保存着 ${result.localCount} 条笔记，但服务器上还没有这份数据。\n\n`
            + '点「确定」：把本地笔记导入到服务器（推荐，续用旧数据）。\n'
            + '点「取消」：以服务器为准，本地副本会先自动备份。'
        );
        if (confirmed) {
            notes = loadedNotes;
            // 用户确认导入后要把旧数据真正推到服务端，否则下次打开又会认为服务器是空的
            await saveNotes();
        } else {
            const backupKey = backupLocalNotes();
            if (backupKey) {
                notes = [];
                console.info('[RFNOTER] 本地笔记已备份到:', backupKey);
            } else {
                notes = loadedNotes;
                window.alert('本地笔记备份失败，为避免丢数据，本次仍保留本地副本。');
            }
        }
    } else {
        notes = loadedNotes;
        if (result.needPush) {
            // 本地存在未同步的改动，以本地为准推到服务端
            await saveNotes();
        }
    }

    renderNotes();
    updateSyncStatus();
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
        startTime = new Date(now);
        const minutes = startTime.getMinutes();
        const nextFiveMinute = Math.ceil(minutes / 5) * 5;
        startTime.setMinutes(nextFiveMinute);
        startTime.setSeconds(0);
        startTime.setMilliseconds(0);
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

function renderNotes() {
    notesContainer.innerHTML = '';
    if (notes.length === 0) {
        updateEmptyState();
        return;
    }
    updateEmptyState();
    notes.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    const notesByDate = groupNotesByDate(notes);
    Object.keys(notesByDate)
        .sort((a, b) => (parseDateString(b)?.getTime() || 0) - (parseDateString(a)?.getTime() || 0))
        .forEach(date => {
        const dateNotes = notesByDate[date];
        const isToday = isTodayDate(date);
        const dateGroupElement = createDateGroupElement(date, dateNotes.length, isToday);
        notesContainer.appendChild(dateGroupElement);
        dateNotes.forEach(note => {
            const noteElement = createNoteElement(note);
            notesContainer.appendChild(noteElement);
            if (!isToday) {
                dateGroupElement.classList.add('collapsed');
                const toggleIcon = dateGroupElement.querySelector('.toggle-icon');
                toggleIcon.classList.remove('fa-chevron-down');
                toggleIcon.classList.add('fa-chevron-right');
                noteElement.classList.add('hidden');
            }
        });
    });
    if (selectionMode) bindDateGroupSelectionEvents();
}

/** 只切换空状态提示，供增量渲染路径复用。 */
function updateEmptyState() {
    if (notes.length === 0) {
        emptyState.classList.remove('hidden');
        notesContainer.classList.add('hidden');
    } else {
        emptyState.classList.add('hidden');
        notesContainer.classList.remove('hidden');
    }
}

/** 找到某一天对应的分组容器。 */
function findDateGroupElement(date) {
    const groups = notesContainer.querySelectorAll('.date-group');
    for (const group of groups) {
        if (group.dataset.date === date) return group;
    }
    return null;
}

/** 增量插入一条笔记，避免每次新增都全量重建 DOM。 */
function renderNoteElement(note) {
    let dateGroupElement = findDateGroupElement(note.date);
    const isToday = isTodayDate(note.date);

    if (!dateGroupElement) {
        const notesInDate = notes.filter(n => n.date === note.date);
        dateGroupElement = createDateGroupElement(note.date, notesInDate.length, isToday);

        // 按日期倒序插到正确的位置
        const allDates = [...new Set(notes.map(n => n.date))]
            .sort((a, b) => (parseDateString(b)?.getTime() || 0) - (parseDateString(a)?.getTime() || 0));
        const dateIndex = allDates.indexOf(note.date);
        let anchor = null;
        for (let i = dateIndex + 1; i < allDates.length; i += 1) {
            const nextGroup = findDateGroupElement(allDates[i]);
            if (nextGroup) { anchor = nextGroup; break; }
        }
        if (anchor) notesContainer.insertBefore(dateGroupElement, anchor);
        else notesContainer.appendChild(dateGroupElement);

        if (!isToday) {
            dateGroupElement.classList.add('collapsed');
            const toggleIcon = dateGroupElement.querySelector('.toggle-icon');
            if (toggleIcon) {
                toggleIcon.classList.remove('fa-chevron-down');
                toggleIcon.classList.add('fa-chevron-right');
            }
        }
    }

    const noteElement = createNoteElement(note);
    if (!isToday) noteElement.classList.add('hidden');
    // 插到该分组现有笔记的最前面（同一天内按创建时间倒序）
    let cursor = dateGroupElement.nextElementSibling;
    let lastNoteInGroup = null;
    while (cursor && !cursor.classList.contains('date-group')) {
        if (cursor.classList.contains('note-card')) lastNoteInGroup = cursor;
        cursor = cursor.nextElementSibling;
    }
    if (lastNoteInGroup) lastNoteInGroup.after(noteElement);
    else dateGroupElement.after(noteElement);

    updateDateGroupCount(dateGroupElement);
    if (selectionMode) bindDateGroupSelectionEvents();
}

/** 增量移除一条笔记的 DOM，并清理空掉的分组。 */
function removeNoteElement(noteId) {
    const noteElement = document.querySelector(`.note-card[data-note-id="${noteId}"]`);
    if (!noteElement) return;

    // 往前找所属的日期分组（不能只看 previousElementSibling，同组第 2 条之后就不是分组了）
    let dateGroup = noteElement.previousElementSibling;
    while (dateGroup && !dateGroup.classList.contains('date-group')) {
        dateGroup = dateGroup.previousElementSibling;
    }

    noteElement.remove();

    const stillHasNotes = dateGroup
        && dateGroup.nextElementSibling
        && dateGroup.nextElementSibling.classList.contains('note-card');

    if (dateGroup && !stillHasNotes) dateGroup.remove();
    else if (dateGroup) updateDateGroupCount(dateGroup);
}

/** 刷新分组标题上的「N 条笔记」。 */
function updateDateGroupCount(dateGroup) {
    if (!dateGroup) return;
    const countSpan = dateGroup.querySelector('.note-count');
    if (!countSpan) return;
    let count = 0;
    let cursor = dateGroup.nextElementSibling;
    while (cursor && !cursor.classList.contains('date-group')) {
        if (cursor.classList.contains('note-card')) count += 1;
        cursor = cursor.nextElementSibling;
    }
    countSpan.textContent = `${count} 条笔记`;
    if (count === 0) dateGroup.remove();
}

function createDateGroupElement(date, noteCount, isToday) {
    const dateGroupDiv = document.createElement('div');
    dateGroupDiv.className = 'date-group mt-4 first:mt-0';
    dateGroupDiv.dataset.date = date;
    const dateObj = parseDateString(date);
    const formattedDate = dateObj
        ? dateObj.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
        : String(date);
    dateGroupDiv.innerHTML = `
        <div class="date-header flex items-center justify-between p-3 bg-gray-100 rounded-lg cursor-pointer hover:bg-gray-200 transition-colors duration-200">
            <div class="flex items-center">
                <h3 class="font-semibold text-gray-800">${formattedDate}</h3>
                <span class="note-count ml-2 px-2 py-1 text-xs bg-primary text-white rounded-full">${noteCount} 条笔记</span>
                ${isToday ? '<span class="ml-2 px-2 py-1 text-xs bg-green-500 text-white rounded-full">今日</span>' : ''}
            </div>
            <div class="flex items-center">
                <i class="toggle-icon fa fa-chevron-down text-gray-500 transition-transform duration-300"></i>
            </div>
        </div>
    `;
    const dateHeader = dateGroupDiv.querySelector('.date-header');
    if (!selectionMode) {
        dateHeader.addEventListener('click', () => {
            dateGroupDiv.classList.toggle('collapsed');
            const toggleIcon = dateGroupDiv.querySelector('.toggle-icon');
            if (dateGroupDiv.classList.contains('collapsed')) {
                toggleIcon.classList.remove('fa-chevron-down');
                toggleIcon.classList.add('fa-chevron-right');
                let nextElement = dateGroupDiv.nextElementSibling;
                while (nextElement && !nextElement.classList.contains('date-group')) {
                    nextElement.classList.add('hidden');
                    nextElement = nextElement.nextElementSibling;
                }
            } else {
                toggleIcon.classList.remove('fa-chevron-right');
                toggleIcon.classList.add('fa-chevron-down');
                let nextElement = dateGroupDiv.nextElementSibling;
                while (nextElement && !nextElement.classList.contains('date-group')) {
                    nextElement.classList.remove('hidden');
                    nextElement = nextElement.nextElementSibling;
                }
            }
        });
    }
    return dateGroupDiv;
}

function createNoteElement(note) {
    const noteDiv = document.createElement('div');
    noteDiv.className = `note-card animate-fade-in ${selectedNotes.has(note.id) ? 'selected' : ''}`;
    const color = note.color || 'note1';
    noteDiv.style.borderLeftColor = CONFIG.COLOR_MAP[color] || CONFIG.COLOR_MAP['note1'];
    noteDiv.dataset.noteId = note.id;
    noteDiv.addEventListener('click', (e) => handleNoteSelection(e, note.id));
    const durationMinutes = calculateTimeDuration(note.timeStart, note.timeEnd);
    const durationText = formatDuration(durationMinutes);
    // 所有来自笔记数据的字段都必须转义后再拼进 innerHTML，避免笔记内容被当成 HTML 执行。
    noteDiv.innerHTML = `
        <div class="note-row-layout mb-2 items-center">
            <div class="col-span-3 md:col-span-2 lg:col-span-2 text-center text-sm font-medium text-gray-500">${escapeHTML(formatDateForDisplay(note.date))}</div>
            <div class="col-span-4 md:col-span-2 lg:col-span-2 text-center text-sm">${escapeHTML(note.timeStart)} ~ ${escapeHTML(note.timeEnd)}<span class="duration-badge">${escapeHTML(durationText)}</span></div>
            <div class="col-span-3 md:col-span-4 lg:col-span-4 truncate text-sm font-medium">${escapeHTML(note.content)}</div>
            <div class="col-span-1 md:col-span-2 lg:col-span-2 flex justify-center">${note.tag ? `<span class="tag">${escapeHTML(note.tag)}</span>` : ''}</div>
            <div class="col-span-1 flex justify-center">
                <button class="text-xs text-primary hover:text-primary/80 edit-btn px-2 py-1 rounded hover:bg-primary/10 transition-all duration-150 active:scale-95">修改详情</button>
            </div>
            <div class="col-span-1 flex justify-center">
                <button class="details-btn flex items-center justify-center p-1"><i class="fa fa-chevron-down expand-btn text-lg ${note.expanded ? 'rotate-180' : ''}"></i></button>
            </div>
        </div>
        <div class="note-details-expand mt-3 pt-3 border-t border-gray-200 ${note.expanded ? '' : 'hidden'}">
            <div class="bg-gray-50 rounded-md p-3 mb-2">
                <h4 class="text-sm font-medium text-gray-700 mb-2">详细信息</h4>
                <p class="text-sm text-gray-600 whitespace-pre-wrap break-words">${note.details ? escapeHTML(note.details) : '无详细信息'}</p>
            </div>
            <div class="flex justify-between items-center text-xs text-gray-500">
                <span>创建于 ${escapeHTML(formatRelativeTime(note.createdAt))}</span>
                <div class="flex items-center space-x-2">
                    <button class="text-primary hover:underline edit-btn transition-colors duration-150">编辑</button>
                    <button class="text-red-500 hover:underline delete-btn transition-colors duration-150">删除</button>
                </div>
            </div>
        </div>
    `;
    bindNoteEvents(noteDiv, note);
    return noteDiv;
}

function bindNoteEvents(noteElement, note) {
    noteElement.addEventListener('dblclick', (e) => {
        if (e.target.closest('button') || selectionMode) return;
        openEditModal(note.id);
    });
    noteElement.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (selectionMode) return;
        openContextMenu(e, note.id);
    });
    const detailsBtn = noteElement.querySelector('.details-btn');
    const expandIcon = detailsBtn.querySelector('i');
    detailsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (selectionMode) return;
        const noteIndex = notes.findIndex(n => n.id === note.id);
        if (noteIndex !== -1) {
            notes[noteIndex].expanded = !notes[noteIndex].expanded;
            if (notes[noteIndex].expanded) {
                expandIcon.classList.add('rotate-180');
                noteElement.querySelector('.note-details-expand').classList.remove('hidden');
            } else {
                expandIcon.classList.remove('rotate-180');
                noteElement.querySelector('.note-details-expand').classList.add('hidden');
            }
            // 展开/收起只是界面状态，只写本地，不触发一次全量服务端保存
            persistViewState();
        }
    });
    const editBtns = noteElement.querySelectorAll('.edit-btn');
    editBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (selectionMode) return;
            openEditModal(note.id);
        });
    });
    const deleteBtn = noteElement.querySelector('.delete-btn');
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (selectionMode) return;
        openDeleteModal(note.id);
    });
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
        selectionToggleBtn.innerHTML = `<i class="fa fa-check-circle mr-2"></i>确认，开始AI总结 (${count})`;
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
    const dateGroups = document.querySelectorAll('.date-group');
    dateGroups.forEach(group => {
        const noteIds = [];
        let nextElement = group.nextElementSibling;
        while (nextElement && !nextElement.classList.contains('date-group')) {
            if (nextElement.classList.contains('note-card')) noteIds.push(nextElement.dataset.noteId);
            nextElement = nextElement.nextElementSibling;
        }
        dateGroupNotesMap.set(group, noteIds);
        const dateHeader = group.querySelector('.date-header');
        dateHeader.addEventListener('click', handleDateGroupClick);
        dateHeader.style.cursor = 'pointer';
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

function setDateGroupCollapsed(dateGroup, collapsed) {
    if (!dateGroup) return;
    const toggleIcon = dateGroup.querySelector('.toggle-icon');
    if (collapsed) {
        dateGroup.classList.add('collapsed');
        if (toggleIcon) {
            toggleIcon.classList.remove('fa-chevron-down');
            toggleIcon.classList.add('fa-chevron-right');
        }
        let nextElement = dateGroup.nextElementSibling;
        while (nextElement && !nextElement.classList.contains('date-group')) {
            nextElement.classList.add('hidden');
            nextElement = nextElement.nextElementSibling;
        }
    } else {
        dateGroup.classList.remove('collapsed');
        if (toggleIcon) {
            toggleIcon.classList.remove('fa-chevron-right');
            toggleIcon.classList.add('fa-chevron-down');
        }
        let nextElement = dateGroup.nextElementSibling;
        while (nextElement && !nextElement.classList.contains('date-group')) {
            nextElement.classList.remove('hidden');
            nextElement = nextElement.nextElementSibling;
        }
    }
}

function initSelectionMode() {
    selectionToggleBtn.addEventListener('click', toggleSelectionMode);
    if (closeSelectionHintBtn) {
        closeSelectionHintBtn.addEventListener('click', () => {
            selectionModeHint.classList.add('hidden');
        });
    }
}

/** 绑定导出 / 导入按钮（v1.2.0 功能）。 */
function initImportExport() {
    if (exportBtn) exportBtn.addEventListener('click', exportNotes);
    if (importBtn) importBtn.addEventListener('click', importNotes);
    if (importFileInput) importFileInput.addEventListener('change', handleFileImport);
}

/** 导出全部笔记为 JSON 文件下载。 */
function exportNotes() {
    if (notes.length === 0) {
        alert('没有笔记可导出');
        return;
    }
    const exportData = {
        version: '1.2.0',
        exportTime: new Date().toISOString(),
        noteCount: notes.length,
        notes
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `rfnoter-backup-${getCurrentDateString()}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    showSaveIndicator('已导出笔记');
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
        notes = merge ? [...newNotes, ...notes] : validation.notes;

        const result = await saveNotes();
        renderNotes();
        showSaveIndicator(result.ok ? `已导入 ${newNotes.length} 条笔记` : '已导入到本机，尚未同步到服务器');
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
    } else {
        if (selectedNotes.size === 0) {
            alert('请先选择至少一条笔记');
            return;
        }
        if (selectedNotes.size > CONFIG.MAX_SELECTION) {
            alert(`最多只能选择${CONFIG.MAX_SELECTION}条笔记进行AI总结，请减少选择数量`);
            return;
        }
        openAISummaryModal();
    }
}

function enterSelectionMode() {
    selectionMode = true;
    selectionToggleBtn.innerHTML = '<i class="fa fa-check-circle mr-2"></i>确认，开始AI总结';
    selectionToggleBtn.classList.remove('btn-secondary');
    selectionToggleBtn.classList.add('btn-ai');
    selectionModeHint.classList.remove('hidden');
    clearSelection();
    bindDateGroupSelectionEvents();
    updateSelectionUI();
}

function exitSelectionMode() {
    selectionMode = false;
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
    const [hours, minutes] = timeEnd.split(':');
    const today = new Date();
    const endTime = new Date(today);
    endTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
    lastEndTime = endTime.getTime();
    document.getElementById('quick-content').value = '';
    document.getElementById('quick-tag').value = '';
    initQuickInput();
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
        currentNoteId = noteId;
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
    closeNoteModal();
}

function openDeleteModal(noteId) {
    if (selectionMode) {
        alert('选择模式下无法删除笔记，请先退出选择模式');
        return;
    }
    currentNoteId = noteId;
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
        notes.splice(index, 1);
        saveNotes();
        removeNoteElement(noteId);
        updateEmptyState();
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
    currentNoteId = noteId;
    contextMenu.style.top = `${event.clientY}px`;
    contextMenu.style.left = `${event.clientX}px`;
    contextMenu.classList.remove('hidden');
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
    if (offlineMode) {
        badge.textContent = '离线模式 · 数据仅保存在本机';
        badge.className = 'text-xs px-2 py-1 rounded-full bg-amber-100 text-amber-800';
    } else if (hasPendingChanges()) {
        badge.textContent = '有改动未同步到服务器';
        badge.className = 'text-xs px-2 py-1 rounded-full bg-amber-100 text-amber-800';
    } else {
        badge.textContent = '';
        badge.className = 'hidden';
    }
}

async function saveNotes() {
    const result = await saveNotesToServer(notes);
    lastSaveFailed = !result.ok;
    if (result.ok) {
        offlineMode = false;
        showSaveIndicator('已保存');
    } else {
        showSaveIndicator('未同步到服务器，点击重试', { failed: true });
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
    document.addEventListener('click', (e) => { if (!contextMenu.contains(e.target)) closeContextMenu(); });
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

async function generateSummary() {
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
    currentSummaryConfig = { requestData, selectedNotes: Array.from(selectedNotes) };
    closeAISummaryModal();
    aiResultModal.classList.remove('hidden');
    summaryLoading.classList.remove('hidden');
    summaryContent.classList.add('hidden');
    summaryError.classList.add('hidden');
    resultNoteCount.textContent = selectedNoteList.length;
    try {
        const prompt = buildPrompt(requestData);
        const summary = await callDeepSeekAPI(apiKey, model, prompt, temperature);
        showSummaryResult(summary, selectedNoteList.length);
    } catch (error) {
        showSummaryError(error);
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
    currentSummaryResult = summary;
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
    try {
        const apiKey = getApiKey();
        if (!apiKey) {
            showSummaryError(new Error('API 密钥已在本次会话中失效，请重新输入'));
            return;
        }
        const { requestData } = currentSummaryConfig;
        const { model, temperature } = requestData.apiConfig;
        const prompt = buildPrompt(requestData);
        const summary = await callDeepSeekAPI(apiKey, model, prompt, temperature);
        resultNoteCount.textContent = requestData.selectedNotes.length;
        showSummaryResult(summary, requestData.selectedNotes.length);
    } catch (error) {
        showSummaryError(error);
    }
}

function closeAIResultModal() {
    aiResultModal.classList.add('hidden');
    exitSelectionMode();
}
