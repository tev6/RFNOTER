/**
 * 列表渲染：日期分组、笔记卡片、折叠展开、惰性渲染，以及局部增删。
 *
 * 拆出来的原因：这是 app.js 里最大的一块（四百多行），而且它和"业务动作"
 * （编辑、删除、选择、AI）是两件事。渲染只管把状态画成 DOM。
 *
 * 两个刻意的设计：
 * 1. DOM 引用由 initRender 注入，而不是在模块加载时抓取。
 *    测试用 ?boot=随机数 反复重载 app.js，但静态导入的模块是共享的——
 *    模块级抓取会让第二个用例操作到上一个用例的 document。
 * 2. 渲染不认识弹窗和选择逻辑，需要调用的地方走 hooks 注入，
 *    这样依赖方向始终是 渲染 ← 业务，不会绕成环。
 */
import { escapeHTML, formatDateForDisplay, formatDuration, calculateTimeDuration,
    formatRelativeTime, isTodayDate, groupNotesByDate, parseDateString } from './utils.js';
import { CONFIG } from './config.js';
import { notes, selectedNotes, selectionMode, lazyGroupNotes, searchTerms } from './state.js';
import { matchNote, highlightHtml } from './search.js';

/** 由 initRender 注入。 */
let deps = {};
/** 由 initRender 注入；业务侧要回调渲染时也走这里。 */
let hooks = {};

/** 渲染模块需要向外暴露给业务侧用的钩子（目前没有，留作扩展位）。 */
export function setRenderHooks(next) {
    hooks = { ...hooks, ...next };
}

export function initRender(nextDeps) {
    deps = { ...deps, ...nextDeps };
}

/** 当前该显示的笔记：搜索状态下是命中的那些，否则是全部。 */
function visibleNotes() {
    if (!searchTerms || searchTerms.length === 0) return notes;
    return notes.filter((note) => matchNote(note, searchTerms).matched);
}

export function renderNotes() {
    // 全量重建会把滚动位置弹回顶部；笔记一多（上千条）每次编辑都被弹走非常难受，
    // 所以重建前后自己记住并恢复。
    const scrollY = window.scrollY;
    deps.notesContainer.innerHTML = '';
    updateEmptyState();

    const searching = searchTerms && searchTerms.length > 0;
    const shown = visibleNotes();
    if (shown.length > 0) {
        shown.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
        const notesByDate = groupNotesByDate(shown);
        Object.keys(notesByDate)
            .sort((a, b) => (parseDateString(b)?.getTime() || 0) - (parseDateString(a)?.getTime() || 0))
            .forEach(date => {
                const dateNotes = notesByDate[date];
                const isToday = isTodayDate(date);
                const dateGroupElement = createDateGroupElement(date, dateNotes.length, isToday);
                deps.notesContainer.appendChild(dateGroupElement);
                // 搜索时全部展开：结果藏在折叠的日期里等于没搜到
                if (isToday || searching) {
                    dateNotes.forEach(note => deps.notesContainer.appendChild(createNoteElement(note)));
                } else {
                    // 折叠的分组先不建卡片：1133 条笔记时全部卡片加起来有 2.4 万个节点，
                    // 而其中绝大多数都躺在折叠的日期里看不见。展开时再补（见 flushLazyGroup）。
                    markGroupCollapsed(dateGroupElement, true);
                    lazyGroupNotes.set(dateGroupElement, dateNotes);
                }
            });
        if (selectionMode) hooks.bindGroupSelectionEvents?.();
    }

    if (scrollY > 0) window.scrollTo(0, scrollY);
    hooks.onRendered?.();
}

/** 统一处理折叠/展开的外观（class + 箭头图标）。 */
function markGroupCollapsed(dateGroup, collapsed) {
    dateGroup.classList.toggle('collapsed', collapsed);
    const toggleIcon = dateGroup.querySelector('.toggle-icon');
    if (!toggleIcon) return;
    toggleIcon.classList.toggle('fa-chevron-right', collapsed);
    toggleIcon.classList.toggle('fa-chevron-down', !collapsed);
}

/** 展开折叠分组时，把它跳过的卡片补进 DOM。 */
function flushLazyGroup(dateGroup) {
    const pending = lazyGroupNotes.get(dateGroup);
    if (!pending || pending.length === 0) return;
    lazyGroupNotes.delete(dateGroup);
    let anchor = dateGroup;
    for (const note of pending) {
        const noteElement = createNoteElement(note);
        anchor.after(noteElement);
        anchor = noteElement;
    }
}

/** 只切换空状态提示，供增量渲染路径复用。 */
export function updateEmptyState() {
    if (notes.length === 0) {
        deps.emptyState.classList.remove('hidden');
        deps.notesContainer.classList.add('hidden');
    } else {
        deps.emptyState.classList.add('hidden');
        deps.notesContainer.classList.remove('hidden');
    }
}

/** 找到某一天对应的分组容器。 */
function findDateGroupElement(date) {
    const groups = deps.notesContainer.querySelectorAll('.date-group');
    for (const group of groups) {
        if (group.dataset.date === date) return group;
    }
    return null;
}

/** 增量插入一条笔记，避免每次新增都全量重建 DOM。 */
export function renderNoteElement(note) {
    // 搜索状态下只画命中的：新记的笔记如果不在结果里，不该凭空出现在列表里
    if (searchTerms && searchTerms.length > 0 && !matchNote(note, searchTerms).matched) return;

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
        if (anchor) deps.notesContainer.insertBefore(dateGroupElement, anchor);
        else deps.notesContainer.appendChild(dateGroupElement);

        if (!isToday) markGroupCollapsed(dateGroupElement, true);
    }

    const noteElement = createNoteElement(note);
    // 同一天内是按创建时间倒序排列的，所以新笔记必须插在分组标题的正下方（也就是最前面）。
    // 之前的实现是追加到分组里最后一条笔记之后，结果新建的笔记会沉到当天所有笔记的下方，
    // 界面上看起来"没生效"，必须刷新（走全量排序）才会回到顶部。
    if (dateGroupElement.classList.contains('collapsed')) {
        // 往折叠的分组里插 = 让人看不见，直接展开
        setDateGroupCollapsed(dateGroupElement, false);
    }
    dateGroupElement.after(noteElement);

    updateDateGroupCount(dateGroupElement);
    if (selectionMode) hooks.bindGroupSelectionEvents?.();
    // 只有新笔记不在可视区时才滚动，避免打断正在看别处的人。
    // 单独兜住异常：滚动失败绝不能影响"这条笔记已经加好了"这件事。
    try {
        if (typeof noteElement.scrollIntoView === 'function') {
            noteElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    } catch { /* 忽略：滚动只是锦上添花 */ }
}

/** 增量移除一条笔记的 DOM，并清理空掉的分组。 */
export function removeNoteElement(noteId, date) {
    const noteElement = document.querySelector(`.note-card[data-note-id="${noteId}"]`);
    if (noteElement) noteElement.remove();

    const dateGroup = findDateGroupElement(date);
    if (!dateGroup) return;

    // 折叠分组里的卡片可能还没渲染，要从待渲染列表里一并剔除，否则展开时它会"复活"
    const pending = lazyGroupNotes.get(dateGroup);
    if (pending) {
        const index = pending.findIndex(n => n.id === noteId);
        if (index !== -1) pending.splice(index, 1);
    }
    updateDateGroupCount(dateGroup);
}

/** 刷新分组标题上的「N 条笔记」。数量以当前可见的笔记为准（搜索时是命中数）。 */
function updateDateGroupCount(dateGroup) {
    if (!dateGroup) return;
    const date = dateGroup.dataset.date;
    const count = visibleNotes().filter(n => n.date === date).length;
    const countSpan = dateGroup.querySelector('.note-count');
    if (countSpan) countSpan.textContent = `${count} 条笔记`;
    if (count === 0) {
        lazyGroupNotes.delete(dateGroup);
        dateGroup.remove();
    }
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
        // 必须走 setDateGroupCollapsed：惰性渲染的卡片是在那里补出来的。
        // 之前这段是内联实现，绕过它会导致"展开一个折叠的日期是空的"。
        dateHeader.addEventListener('click', () => {
            setDateGroupCollapsed(dateGroupDiv, !dateGroupDiv.classList.contains('collapsed'));
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
    noteDiv.addEventListener('click', (e) => hooks.onNoteClick(e, note.id));
    const durationMinutes = calculateTimeDuration(note.timeStart, note.timeEnd);
    const durationText = formatDuration(durationMinutes);
    // 搜索状态下高亮命中的片段；highlightHtml 自己负责转义，
    // 所有来自笔记的字符都过了 escapeHTML，只有它加的 <mark> 是"生"的
    const searching = searchTerms && searchTerms.length > 0;
    const match = searching ? matchNote(note, searchTerms) : { matched: true, onlyInDetails: false };
    const contentHtml = highlightHtml(note.content, searchTerms);
    const tagHtml = highlightHtml(note.tag || '', searchTerms);
    // 只在详情里命中的，卡片上高亮不出来，得给个交代，否则用户会觉得"这条凭什么在这"
    const detailsHitHtml = match.onlyInDetails
        ? '<span class="ml-2 text-xs text-amber-600 whitespace-nowrap">（详情中匹配）</span>'
        : '';
    // 所有来自笔记数据的字段都必须转义后再拼进 innerHTML，避免笔记内容被当成 HTML 执行。
    noteDiv.innerHTML = `
        <div class="note-row-layout mb-2 items-center">
            <div class="col-span-3 md:col-span-2 lg:col-span-2 text-center text-sm font-medium text-gray-500">${escapeHTML(formatDateForDisplay(note.date))}</div>
            <div class="col-span-4 md:col-span-2 lg:col-span-2 text-center text-sm">${escapeHTML(note.timeStart)} ~ ${escapeHTML(note.timeEnd)}<span class="duration-badge">${escapeHTML(durationText)}</span></div>
            <div class="col-span-3 md:col-span-4 lg:col-span-4 truncate text-sm font-medium">${contentHtml}${detailsHitHtml}</div>
            <div class="col-span-1 md:col-span-2 lg:col-span-2 flex justify-center">${note.tag ? `<span class="tag">${tagHtml}</span>` : ''}</div>
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
        hooks.onEdit(note.id);
    });
    noteElement.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (selectionMode) return;
        hooks.onContextMenu(e, note.id);
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
            hooks.onExpandToggled();
        }
    });
    const editBtns = noteElement.querySelectorAll('.edit-btn');
    editBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (selectionMode) return;
            hooks.onEdit(note.id);
        });
    });
    const deleteBtn = noteElement.querySelector('.delete-btn');
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (selectionMode) return;
        hooks.onDelete(note.id);
    });
}

export function setDateGroupCollapsed(dateGroup, collapsed) {
    if (!dateGroup) return;
    // 展开前先把惰性跳过的卡片补上，否则展开出来是空的
    if (!collapsed) flushLazyGroup(dateGroup);
    markGroupCollapsed(dateGroup, collapsed);
    let nextElement = dateGroup.nextElementSibling;
    while (nextElement && !nextElement.classList.contains('date-group')) {
        nextElement.classList.toggle('hidden', collapsed);
        nextElement = nextElement.nextElementSibling;
    }
}

/**
 * 按日期展开某一天的分组，供"跳到某条笔记"使用。
 *
 * 必须走这里而不是让调用方自己 `querySelector`：折叠的分组里没有卡片 DOM
 * （惰性渲染），只有 `flushLazyGroup` 知道该怎么把它补出来。
 *
 * @returns {boolean} 是否找到了这一天的分组
 */
export function expandDateGroup(date) {
    const dateGroup = findDateGroupElement(date);
    if (!dateGroup) return false;
    setDateGroupCollapsed(dateGroup, false);
    return true;
}
