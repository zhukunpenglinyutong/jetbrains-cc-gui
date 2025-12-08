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

            // 构造供应商配置对象
            const provider = {
                id: row.id,
                name: row.name || row.id,
                source: 'cc-switch'
            };

            // 从 settings_config 中提取配置
            if (settingsConfig.base_url) {
                provider.baseUrl = settingsConfig.base_url;
            }
            if (settingsConfig.api_key) {
                provider.apiKey = settingsConfig.api_key;
            }
            if (settingsConfig.model) {
                provider.model = settingsConfig.model;
            }
            if (settingsConfig.max_tokens) {
                provider.maxTokens = settingsConfig.max_tokens;
            }
            if (settingsConfig.temperature) {
                provider.temperature = settingsConfig.temperature;
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
