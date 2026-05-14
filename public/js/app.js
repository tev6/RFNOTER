import {
    generateUUID, getCurrentDateString, formatRelativeTime, formatDateForDisplay,
    calculateTimeDuration, formatDuration, trimTagToLimit, markdownToHtml,
    isTodayDate, groupNotesByDate
} from './utils.js';
import { loadNotesFromServer, saveNotesToServer, callDeepSeekAPI } from './api.js';

let notes = [];
let currentNoteId = null;
let lastEndTime = null;
let selectedNotes = new Set();
let lastClickedNoteId = null;
let currentSummaryConfig = {};
let currentSummaryResult = null;
let selectionMode = false;
let dateGroupNotesMap = new Map();

const colorMap = {
    'note1': '#3b82f6',
    'note2': '#10b981',
    'note3': '#f59e0b',
    'note4': '#ef4444',
    'note5': '#8b5cf6',
    '': '#3b82f6'
};

const notesContainer = document.getElementById('notes-container');
const emptyState = document.getElementById('empty-state');
const noteModal = document.getElementById('note-modal');
const contextMenu = document.getElementById('context-menu');
const deleteModal = document.getElementById('delete-modal');
const saveIndicator = document.getElementById('save-indicator');
const quickAddForm = document.getElementById('quick-add-form');
const colorSubmenu = document.getElementById('color-submenu');
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
const selectionHint = document.getElementById('selection-hint');
const helpBtn = document.getElementById('help-btn');
const helpModal = document.getElementById('help-modal');
const helpContent = document.getElementById('help-content');
const closeHelpBtn = document.getElementById('close-help-btn');
const closeHelpBtn2 = document.getElementById('close-help-btn2');

document.addEventListener('DOMContentLoaded', async () => {
    initQuickInput();
    notes = await loadNotesFromServer();
    renderNotes();
    bindEventListeners();
    bindAIEventListeners();
    loadApiConfig();
});

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
    const endTime = new Date(startTime.getTime() + 40 * 60000);
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
        emptyState.classList.remove('hidden');
        notesContainer.classList.add('hidden');
        return;
    }
    emptyState.classList.add('hidden');
    notesContainer.classList.remove('hidden');
    notes.sort((a, b) => b.createdAt - a.createdAt);
    const notesByDate = groupNotesByDate(notes);
    Object.keys(notesByDate).sort((a, b) => new Date(b) - new Date(a)).forEach(date => {
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

function createDateGroupElement(date, noteCount, isToday) {
    const dateGroupDiv = document.createElement('div');
    dateGroupDiv.className = 'date-group mt-4 first:mt-0';
    const dateObj = new Date(date);
    const formattedDate = dateObj.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    dateGroupDiv.innerHTML = `
        <div class="date-header flex items-center justify-between p-3 bg-gray-100 rounded-lg cursor-pointer hover:bg-gray-200 transition-colors duration-200">
            <div class="flex items-center">
                <h3 class="font-semibold text-gray-800">${formattedDate}</h3>
                <span class="ml-2 px-2 py-1 text-xs bg-primary text-white rounded-full">${noteCount} 条笔记</span>
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
            saveNotes();
        });
    }
    return dateGroupDiv;
}

function createNoteElement(note) {
    const noteDiv = document.createElement('div');
    noteDiv.className = `note-card animate-fade-in ${selectedNotes.has(note.id) ? 'selected' : ''}`;
    const color = note.color || 'note1';
    noteDiv.style.borderLeftColor = colorMap[color] || colorMap['note1'];
    noteDiv.dataset.noteId = note.id;
    noteDiv.addEventListener('click', (e) => handleNoteSelection(e, note.id));
    const date = new Date(note.date);
    const formattedDate = date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
    const durationMinutes = calculateTimeDuration(note.timeStart, note.timeEnd);
    const durationText = formatDuration(durationMinutes);
    noteDiv.innerHTML = `
        <div class="note-row-layout mb-2 items-center">
            <div class="col-span-3 md:col-span-2 lg:col-span-2 text-center text-sm font-medium text-gray-500">${formattedDate}</div>
            <div class="col-span-4 md:col-span-2 lg:col-span-2 text-center text-sm">${note.timeStart} ~ ${note.timeEnd}<span class="duration-badge">${durationText}</span></div>
            <div class="col-span-3 md:col-span-4 lg:col-span-4 truncate text-sm font-medium">${note.content}</div>
            <div class="col-span-1 md:col-span-2 lg:col-span-2 flex justify-center">${note.tag ? `<span class="tag">${note.tag}</span>` : ''}</div>
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
                <p class="text-sm text-gray-600 whitespace-pre-wrap break-words">${note.details || '无详细信息'}</p>
            </div>
            <div class="flex justify-between items-center text-xs text-gray-500">
                <span>创建于 ${formatRelativeTime(note.createdAt)}</span>
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
            saveNotes();
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
    event.preventDefault();
    event.stopPropagation();
    if (!selectionMode) {
        if (event.detail === 2) openEditModal(noteId);
        return;
    }
    if (!selectedNotes.has(noteId) && selectedNotes.size >= 100) {
        alert('最多只能选择100条笔记，请先取消选择一些笔记');
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
        if (!selectionMode) {
            quickAddForm.querySelectorAll('input, button').forEach(el => {
                el.style.opacity = '0.6';
                el.style.pointerEvents = 'none';
            });
        }
    } else {
        selectionInfo.classList.add('hidden');
        aiSummaryFloatBtn.classList.add('hidden');
        quickAddForm.querySelectorAll('input, button').forEach(el => {
            el.style.opacity = '1';
            el.style.pointerEvents = 'auto';
        });
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
        if (selectedNotes.size + newSelections.length > 100) {
            alert(`最多只能选择100条笔记，当前已选择${selectedNotes.size}条，无法再选择${newSelections.length}条`);
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

function toggleSelectionMode() {
    if (!selectionMode) {
        enterSelectionMode();
    } else {
        if (selectedNotes.size === 0) {
            alert('请先选择至少一条笔记');
            return;
        }
        if (selectedNotes.size > 100) {
            alert('最多只能选择100条笔记进行AI总结，请减少选择数量');
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
    renderNotes();
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
        document.getElementById('note-color').value = note.color || 'note1';
        document.querySelectorAll('.color-dot').forEach(dot => {
            dot.classList.remove('border-4');
            if (dot.dataset.color === (note.color || 'note1')) dot.classList.add('border-4');
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
    const color = document.getElementById('note-color').value;
    if (!date || !timeStart || !timeEnd || !content) {
        alert('请填写所有必填字段');
        return;
    }
    const noteData = { date, timeStart, timeEnd, content, tag, color: color || 'note1', details, updatedAt: Date.now() };
    if (currentNoteId) {
        const noteIndex = notes.findIndex(note => note.id === currentNoteId);
        if (noteIndex !== -1) {
            const originalDate = notes[noteIndex].date;
            notes[noteIndex] = { ...notes[noteIndex], ...noteData };
            if (originalDate !== date) {
                closeNoteModal();
                setTimeout(() => renderNotes(), 100);
            }
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
    if (currentNoteId) {
        const noteIndex = notes.findIndex(note => note.id === currentNoteId);
        if (noteIndex !== -1) {
            if (selectedNotes.has(currentNoteId)) {
                selectedNotes.delete(currentNoteId);
                updateSelectionUI();
            }
            const noteElement = document.querySelector(`[data-note-id="${currentNoteId}"]`);
            if (noteElement) {
                noteElement.classList.add('animate-fade-out');
                setTimeout(() => {
                    notes.splice(noteIndex, 1);
                    saveNotes();
                    renderNotes();
                }, 200);
            } else {
                notes.splice(noteIndex, 1);
                saveNotes();
                renderNotes();
            }
        }
        closeDeleteModal();
        closeContextMenu();
    }
}

function duplicateNote() {
    if (currentNoteId) {
        const noteIndex = notes.findIndex(note => note.id === currentNoteId);
        if (noteIndex !== -1) {
            const originalNote = notes[noteIndex];
            const durationMinutes = calculateTimeDuration(originalNote.timeStart, originalNote.timeEnd);
            const now = new Date();
            const originalEndParts = originalNote.timeEnd.split(':').map(Number);
            const originalEnd = new Date();
            originalEnd.setHours(originalEndParts[0], originalEndParts[1], 0, 0);
            const gapMinutes = Math.floor((now.getTime() - originalEnd.getTime()) / 60000);
            const roundedNow = new Date(now);
            const roundedMinutes = Math.ceil(roundedNow.getMinutes() / 5) * 5;
            if (roundedMinutes === 60) {
                roundedNow.setHours(roundedNow.getHours() + 1, 0, 0, 0);
            } else {
                roundedNow.setMinutes(roundedMinutes, 0, 0);
            }
            const startParts = originalNote.timeStart.split(':').map(Number);
            const startTotal = startParts[0] * 60 + startParts[1];
            const endTotal = originalEndParts[0] * 60 + originalEndParts[1];
            const isCrossDay = endTotal < startTotal;
            const startTime = isCrossDay ? originalEnd : (gapMinutes > durationMinutes ? roundedNow : originalEnd);
            const endTime = new Date(startTime.getTime() + durationMinutes * 60000);
            const newStartHour = String(startTime.getHours()).padStart(2, '0');
            const newStartMinute = String(startTime.getMinutes()).padStart(2, '0');
            const newEndHour = String(endTime.getHours()).padStart(2, '0');
            const newEndMinute = String(endTime.getMinutes()).padStart(2, '0');
            const duplicatedNote = {
                ...originalNote,
                id: generateUUID(),
                date: getCurrentDateString(),
                timeStart: `${newStartHour}:${newStartMinute}`,
                timeEnd: `${newEndHour}:${newEndMinute}`,
                content: originalNote.content,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            notes.unshift(duplicatedNote);
            saveNotes();
            renderNotes();
        }
        closeContextMenu();
    }
}

function changeNoteColor(color) {
    if (currentNoteId) {
        const noteIndex = notes.findIndex(note => note.id === currentNoteId);
        if (noteIndex !== -1) {
            notes[noteIndex].color = color || 'note1';
            notes[noteIndex].updatedAt = Date.now();
            saveNotes();
            renderNotes();
        }
        closeContextMenu();
    }
}

function openContextMenu(event, noteId) {
    if (selectionMode) return;
    currentNoteId = noteId;
    contextMenu.style.top = `${event.clientY}px`;
    contextMenu.style.left = `${event.clientX}px`;
    contextMenu.classList.remove('hidden');
    const colorMenuBtn = document.getElementById('color-menu-btn');
    colorMenuBtn.addEventListener('mouseenter', showColorSubmenu);
    colorMenuBtn.addEventListener('click', showColorSubmenu);
}

function closeContextMenu() {
    contextMenu.classList.add('hidden');
    colorSubmenu.classList.add('hidden');
}

function showColorSubmenu(e) {
    e.stopPropagation();
    colorSubmenu.classList.toggle('hidden');
}

async function saveNotes() {
    await saveNotesToServer(notes);
    showSaveIndicator('已保存');
}

function showSaveIndicator(message = '已保存') {
    const indicator = document.getElementById('save-indicator');
    indicator.querySelector('span').textContent = message;
    indicator.classList.remove('translate-y-10', 'opacity-0');
    setTimeout(() => {
        indicator.classList.add('translate-y-10', 'opacity-0');
    }, 2000);
}

function openHelpModal() {
    helpModal.classList.remove('hidden');
    fetch('flash-noter-tutorial.md')
        .then(r => r.text())
        .then(md => { helpContent.innerHTML = markdownToHtml(md); })
        .catch(() => {
            helpContent.innerHTML = '教程加载失败，请确认 flash-noter-tutorial.md 存在于同目录';
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
    document.querySelectorAll('.color-dot').forEach(dot => {
        dot.addEventListener('click', (e) => {
            e.stopPropagation();
            const color = dot.dataset.color;
            document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('border-4'));
            dot.classList.add('border-4');
            if (noteModal.classList.contains('hidden')) changeNoteColor(color);
            else document.getElementById('note-color').value = color;
        });
    });
    document.addEventListener('click', (e) => { if (!contextMenu.contains(e.target)) closeContextMenu(); });
    noteModal.addEventListener('click', (e) => { if (e.target === noteModal) closeNoteModal(); });
    deleteModal.addEventListener('click', (e) => { if (e.target === deleteModal) closeDeleteModal(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (selectionMode) exitSelectionMode();
            else {
                closeNoteModal();
                closeDeleteModal();
                closeContextMenu();
                closeAISummaryModal();
                closeAIResultModal();
                closeHelpModal();
            }
        }
    });
}

function bindAIEventListeners() {
    aiSummaryFloatBtn.addEventListener('click', openAISummaryModal);
    clearSelectionBtn.addEventListener('click', clearSelection);
    cancelSummaryBtn.addEventListener('click', () => { closeAISummaryModal(); exitSelectionMode(); });
    generateSummaryBtn.addEventListener('click', generateSummary);
    document.getElementById('toggle-api-config').addEventListener('click', toggleApiConfig);
    document.getElementById('toggle-api-key').addEventListener('click', toggleApiKeyVisibility);
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
        if (e.target === aiResultModal) { closeAIResultModal(); exitSelectionMode(); }
    });
}

function loadApiConfig() {
    const savedApiKey = localStorage.getItem('deepseek_api_key');
    if (savedApiKey) document.getElementById('api-key').value = savedApiKey;
}

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
    if (selectedNotes.size > 100) {
        alert('最多只能选择100条笔记进行AI总结，请减少选择数量');
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
                    <span class="text-xs text-gray-500">${formatDateForDisplay(note.date)}</span>
                    <span class="text-xs text-gray-700">${note.timeStart} ~ ${note.timeEnd}</span>
                    ${note.tag ? `<span class="tag">${note.tag}</span>` : ''}
                </div>
                <p class="text-sm text-gray-800 truncate">${note.content}</p>
            </div>
            <button class="ml-2 text-gray-400 hover:text-red-500 transition-colors duration-150 active:scale-95" data-note-id="${note.id}"><i class="fa fa-times"></i></button>
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
    localStorage.setItem('deepseek_api_key', apiKey);
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
        summaryConfig: { style, format, customPrompt, mergeMethod: "time" },
        apiConfig: { model, temperature, maxTokens: 2000 }
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
    let prompt = `你是一个专业的笔记总结助手，擅长将分散的笔记信息整理成有结构的总结。\n\n以下是${selectedNotes.length}条笔记，按时间顺序排序：\n\n`;
    selectedNotes.forEach((note, index) => {
        prompt += `\n${index + 1}. 【${note.date} ${note.timeRange}】${note.tag ? ` [标签：${note.tag}]` : ''}\n标题：${note.content}\n${note.details ? `详情：${note.details}\n` : ''}`;
    });
    const styleInstruction = style === '记忆回溯'
        ? '采用记忆回溯口吻，细节充分、节奏舒缓、积极客观，但必须基于原始笔记，可以夸大'
        : '根据所选风格输出';
    prompt += `\n总结要求：\n1. 总结风格：${style}\n2. 风格细则：${styleInstruction}\n3. 输出格式必须遵循：${format}\n4. ${customPrompt || '请对以上笔记进行系统性的总结，突出关键信息和主题'}\n5. 保持原始信息的准确性\n6. 如有矛盾信息，请注明\n7. 用中文输出\n\n请直接给出总结内容，不需要额外的说明文字。`;
    return prompt;
}

function showSummaryResult(summary, noteCount) {
    summaryLoading.classList.add('hidden');
    summaryContent.classList.remove('hidden');
    if (currentSummaryConfig.requestData.summaryConfig.format === 'Markdown格式') {
        summaryText.innerHTML = summary.replace(/\n/g, '<br>').replace(/#{1,6}\s+(.+)/g, '<strong>$1</strong>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
    } else if (currentSummaryConfig.requestData.summaryConfig.format === 'HTML格式') {
        summaryText.innerHTML = summary;
    } else {
        summaryText.textContent = summary;
    }
    const charCount = summary.length;
    const wordCount = summary.split(/\s+/).length;
    summaryStats.textContent = `${charCount}字 ${wordCount}词`;
    currentSummaryResult = summary;
    exitSelectionMode();
}

function showSummaryError(error) {
    summaryLoading.classList.add('hidden');
    summaryError.classList.remove('hidden');
    let userFriendlyMessage = '生成总结时发生错误';
    if (error.message.includes('401')) userFriendlyMessage = 'API密钥无效，请检查并重新输入';
    else if (error.message.includes('429')) userFriendlyMessage = '请求过于频繁，请稍后再试';
    else if (error.message.includes('500')) userFriendlyMessage = 'AI服务暂时不可用，请稍后重试';
    else if (error.message.includes('timeout')) userFriendlyMessage = '请求超时，请检查网络连接后重试';
    else if (error.message.includes('network') || error.message.includes('Network')) userFriendlyMessage = '网络连接失败，请检查网络连接';
    else userFriendlyMessage = error.message;
    errorMessage.textContent = userFriendlyMessage;
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
    const newNote = {
        id: generateUUID(),
        date: dateStr,
        timeStart: timeStr,
        timeEnd: timeStr,
        content: `${dateStr} 笔记总结`,
        tag: 'AI总结',
        color: 'ai',
        details: `基于 ${currentSummaryConfig.selectedNotes.length} 条笔记的AI总结：\n\n${currentSummaryResult}\n\n来源笔记ID: ${currentSummaryConfig.selectedNotes.join(', ')}`,
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

function regenerateSummary() {
    aiResultModal.classList.add('hidden');
    openAISummaryModal();
}

function backToConfig() {
    aiResultModal.classList.add('hidden');
    openAISummaryModal();
}

function retrySummary() {
    summaryError.classList.add('hidden');
    summaryLoading.classList.remove('hidden');
    generateSummaryFromConfig();
}

async function generateSummaryFromConfig() {
    try {
        const apiKey = localStorage.getItem('deepseek_api_key');
        const { requestData } = currentSummaryConfig;
        const { model, temperature } = requestData.apiConfig;
        const prompt = buildPrompt(requestData);
        const summary = await callDeepSeekAPI(apiKey, model, prompt, temperature);
        showSummaryResult(summary, requestData.selectedNotes.length);
    } catch (error) {
        showSummaryError(error);
    }
}

function closeAIResultModal() {
    aiResultModal.classList.add('hidden');
    exitSelectionMode();
}
