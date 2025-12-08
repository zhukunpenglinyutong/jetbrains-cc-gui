#!/usr/bin/env node
/**
 * 读取 cc-switch SQLite 数据库中的 Claude 供应商配置
 * 使用 sql.js (纯 JavaScript 实现，跨平台兼容)
 *
 * 用法: node read-cc-switch-db.js <数据库文件路径>
 * 输出: JSON 格式的供应商列表
 */

import initSqlJs from 'sql.js';
import fs from 'fs';

// 获取命令行参数
const dbPath = process.argv[2];

if (!dbPath) {
    console.error(JSON.stringify({
        success: false,
        error: '缺少数据库文件路径参数'
    }));
    process.exit(1);
}

// 检查文件是否存在
if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({
        success: false,
        error: `数据库文件不存在: ${dbPath}`
    }));
    process.exit(1);
}

try {
    // 初始化 sql.js
    const SQL = await initSqlJs();

    // 读取数据库文件
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    // 查询 Claude 供应商配置
    const result = db.exec(`
        SELECT * FROM providers
        WHERE app_type = 'claude'
    `);

    // 检查是否有结果
    if (!result || result.length === 0 || !result[0].values || result[0].values.length === 0) {
        console.log(JSON.stringify({
            success: true,
            providers: [],
            count: 0
        }));
        db.close();
        process.exit(0);
    }

    // 获取列名和数据
    const columns = result[0].columns;
    const rows = result[0].values;

    // 解析每一行数据
    const providers = rows.map(rowArray => {
        try {
            // 将数组转为对象（根据列名）
            const row = {};
            columns.forEach((col, index) => {
                row[col] = rowArray[index];
            });

            // 解析 settings_config JSON
            const settingsConfig = row.settings_config ? JSON.parse(row.settings_config) : {};

            // 从 settings_config 中提取配置
            // 支持两种格式：
            // 1. 新格式（env 包含环境变量）: { env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN } }
            // 2. 旧格式（直接包含配置）: { base_url, api_key, model, ... }

            let baseUrl = null;
            let apiKey = null;

            if (settingsConfig.env) {
                // 新格式: 从 env 对象中提取
                const env = settingsConfig.env;
                if (env.ANTHROPIC_BASE_URL) {
                    baseUrl = env.ANTHROPIC_BASE_URL;
                }
                if (env.ANTHROPIC_AUTH_TOKEN) {
                    apiKey = env.ANTHROPIC_AUTH_TOKEN;
                }
                // 也检查其他常见的环境变量名
                if (!apiKey && env.ANTHROPIC_API_KEY) {
                    apiKey = env.ANTHROPIC_API_KEY;
                }
            }

            // 旧格式: 直接从 settingsConfig 提取
            if (!baseUrl && settingsConfig.base_url) {
                baseUrl = settingsConfig.base_url;
            }
            if (!apiKey && settingsConfig.api_key) {
                apiKey = settingsConfig.api_key;
            }

            // 基于 cc-switch 原始 settings_config 构造 settingsConfig，
            // 尽量保留 cc-switch 中的所有字段（包括 model、alwaysThinkingEnabled 等）
            const mergedSettingsConfig = {
                ...settingsConfig,
                env: {
                    ...(settingsConfig.env || {}),
                },
            };

            // 构造供应商配置对象（使用插件期望的格式）
            const provider = {
                id: row.id,
                name: row.name || row.id,
                source: 'cc-switch',
                settingsConfig: mergedSettingsConfig,
            };

            // 设置 env 字段
            if (baseUrl) {
                provider.settingsConfig.env.ANTHROPIC_BASE_URL = baseUrl;
            }
            if (apiKey) {
                provider.settingsConfig.env.ANTHROPIC_AUTH_TOKEN = apiKey;
            }

            // 同时保留顶层字段用于前端预览显示
            if (baseUrl) {
                provider.baseUrl = baseUrl;
            }
            if (apiKey) {
                provider.apiKey = apiKey;
            }

            // 其他元数据
            if (row.website_url) {
                provider.websiteUrl = row.website_url;
            }
            if (row.remark) {
                provider.remark = row.remark;
            }
            if (row.created_at) {
                provider.createdAt = row.created_at;
            }
            if (row.updated_at) {
                provider.updatedAt = row.updated_at;
            }

            return provider;
        } catch (e) {
            console.error(`解析供应商配置失败:`, e.message);
            return null;
        }
    }).filter(p => p !== null);

    // 关闭数据库
    db.close();

    // 输出结果
    console.log(JSON.stringify({
        success: true,
        providers: providers,
        count: providers.length
    }));

} catch (error) {
    console.error(JSON.stringify({
        success: false,
        error: `读取数据库失败: ${error.message}`,
        stack: error.stack
    }));
    process.exit(1);
}
