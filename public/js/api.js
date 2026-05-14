const API_BASE = '/api';

let userId = localStorage.getItem('userId');
if (!userId) {
    userId = generateUUID() + '-' + Date.now();
    localStorage.setItem('userId', userId);
}

import { generateUUID } from './utils.js';

export async function loadNotesFromServer() {
    try {
        const res = await fetch(`${API_BASE}/notes/${userId}`);
        if (!res.ok) throw new Error('Failed to load notes');
        return await res.json();
    } catch (e) {
        console.warn('Server load failed, falling back to localStorage', e);
        const saved = localStorage.getItem(`notes_${userId}`);
        return saved ? JSON.parse(saved) : [];
    }
}

export async function saveNotesToServer(notes) {
    try {
        const res = await fetch(`${API_BASE}/notes/${userId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(notes)
        });
        if (!res.ok) throw new Error('Failed to save notes');
        localStorage.setItem(`notes_${userId}`, JSON.stringify(notes));
        return true;
    } catch (e) {
        console.warn('Server save failed, saving to localStorage', e);
        localStorage.setItem(`notes_${userId}`, JSON.stringify(notes));
        return false;
    }
}

export async function callDeepSeekAPI(apiKey, model, prompt, temperature) {
    const maxRetries = 3;
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: 'system', content: '你是一个专业的笔记总结助手，请根据用户提供的笔记内容生成高质量的总结。' },
                        { role: 'user', content: prompt }
                    ],
                    temperature: temperature,
                    max_tokens: 2000,
                    stream: false
                }),
                signal: AbortSignal.timeout(30000)
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(`API错误: ${response.status} - ${errorData.error?.message || response.statusText}`);
            }
            const data = await response.json();
            return data.choices[0].message.content;
        } catch (error) {
            lastError = error;
            console.warn(`API调用失败 (尝试 ${attempt}/${maxRetries}):`, error);
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
                continue;
            }
        }
    }
    throw lastError;
}
