/**
 * 日志模块。
 *
 * 这里只有一组用例，但它守着一条**实测踩过**的红线：
 * `write()` 会往 stdout/stderr 写，而这正是全局 `uncaughtException`
 * 处理器唯一会调用的地方。如果写控制台这一步会抛（管道断了就抛 EPIPE），
 * 就会被 uncaughtException 接住 → 再记一次 → 再抛 → **同一个错误刷爆整个日志文件**。
 *
 * 打包后从资源管理器启动、或把输出重定向到已关闭的管道，都会制造出坏管道，
 * 所以这条路径在真实使用里是走得到的，不是理论问题。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger, describeError } from '../electron/logger.js';

function tempLog() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfnoter-log-'));
    return { dir, logger: createLogger(dir) };
}

/** 在"写控制台必抛 EPIPE"的环境下跑一段代码，结束后恢复。 */
function withBrokenPipe(fn) {
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    const boom = () => { throw new Error('EPIPE: broken pipe, write'); };
    process.stdout.write = boom;
    process.stderr.write = boom;
    try {
        return fn();
    } finally {
        process.stdout.write = realOut;
        process.stderr.write = realErr;
    }
}

test('日志：写进去能读出来', () => {
    const { dir, logger } = tempLog();
    logger.info('一条普通记录');
    const text = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
    assert.match(text, /一条普通记录/);
    assert.match(text, /\[INFO\]/);
});

test('日志：目录不存在时会自己建出来', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rfnoter-log-')), 'nested', 'logs');
    const logger = createLogger(dir);
    logger.info('嵌套目录');
    assert.equal(fs.existsSync(logger.file), true);
});

test('日志：坏管道下写日志不抛异常（否则会被 uncaughtException 刷成死循环）', () => {
    const { dir, logger } = tempLog();
    assert.doesNotThrow(() => withBrokenPipe(() => {
        logger.info('管道坏了也要能记');
        logger.warn('warn 同理');
        logger.error('error 走 stderr，同样不能抛');
    }));
    // 而且内容真的落到了文件里——不能因为控制台写不出去就整体放弃
    const text = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
    assert.match(text, /管道坏了也要能记/);
    assert.match(text, /error 走 stderr/);
});

test('日志：坏管道下连续记很多条也不会抛（模拟 uncaughtException 反复触发的场景）', () => {
    const { logger } = tempLog();
    assert.doesNotThrow(() => withBrokenPipe(() => {
        for (let i = 0; i < 50; i += 1) logger.error(`重复的错误 ${i}`);
    }));
});

test('日志：error 会把 Error 对象铺成可读文本', () => {
    const { dir, logger } = tempLog();
    logger.error('出事了', new Error('具体原因'));
    const text = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
    assert.match(text, /出事了/);
    assert.match(text, /具体原因/);
});

test('describeError：各种抛出物都能整理成一行', () => {
    assert.equal(describeError(null), '');
    assert.equal(describeError(undefined), '');
    assert.equal(describeError('直接给字符串'), '直接给字符串');
    assert.match(describeError(new Error('标准错误')), /标准错误/);
    assert.match(describeError({ code: 42 }), /42/);
    // 循环引用不该让它抛出去
    const cyclic = {};
    cyclic.self = cyclic;
    assert.doesNotThrow(() => describeError(cyclic));
});
