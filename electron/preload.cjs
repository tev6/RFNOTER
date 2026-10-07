const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染进程只需要这一个桥：读写笔记文件、拿到应用信息、接收全局热键事件。
 * contextIsolation 打开，页面拿不到 Node，只能调这几个白名单方法。
 */
contextBridge.exposeInMainWorld('rfnoter', {
    isDesktop: true,
    platform: process.platform,
    readNotes: (userId) => ipcRenderer.invoke('notes:read', userId),
    writeNotes: (userId, notes) => ipcRenderer.invoke('notes:write', userId, notes),
    listUserIds: () => ipcRenderer.invoke('notes:list-user-ids'),
    appInfo: () => ipcRenderer.invoke('app:info'),
    openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
    openLogDir: () => ipcRenderer.invoke('app:open-log-dir'),
    openBackupDir: () => ipcRenderer.invoke('app:open-backup-dir'),
    setThemeSource: (mode) => ipcRenderer.invoke('theme:set', mode),
    backupNow: (userId) => ipcRenderer.invoke('app:backup-now', userId),
    onQuickCapture: (callback) => {
        ipcRenderer.on('quick-capture', () => callback());
    }
});
