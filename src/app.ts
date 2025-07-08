import puppeteer, { Browser } from 'puppeteer-core';
import fs from 'fs/promises';
import { allLesons } from './allLessons';
import { platform } from 'os';
import OpenAI from "openai";
import { stdout } from 'process';

const openai = new OpenAI(
    {
        apiKey: '',
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
    }
);

interface ILessonContent {
    tag: string;
    title: string;
    url: string;
}

interface ILesson {
    headerTitle: string;
    content: ILessonContent[];
}

// 浏览器实例单例
let browserInstance: Browser | null

async function getBrowserInstance() {
    if (!browserInstance) {
        const os = platform()
        let executablePath = ''
        switch (os) {
            case 'linux':
                executablePath = '/usr/bin/google-chrome'
                break;
            case 'win32':
                executablePath = "C:/Program Files/Google/Chrome/Application/chrome.exe"
                break;
            case 'darwin':
                executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
                break;
            default:
                executablePath = '/usr/bin/google-chrome'
                break;
        }
        browserInstance = await puppeteer.launch({
            executablePath
        });

    }
    return browserInstance;
}

async function closeBrowserInstance() {
    if (browserInstance) {
        await browserInstance.close();
        browserInstance = null;
    }
}

const fetchAllSites = async () => {
    try {
        const browser = await getBrowserInstance();
        const page = await browser.newPage();
        await page.setViewport({ width: 1080, height: 1024 });

        await page.goto('https://www.learncpp.com/', { waitUntil: 'networkidle2' });
        await page.waitForSelector('.lessontable', { timeout: 30000 });

        return await page.evaluate(() => {
            const tables = document.querySelectorAll('.lessontable');
            return Array.from(tables).map(table => {
                const headerTitle = table.querySelector('.lessontable-header-title')?.innerHTML;
                if (!headerTitle) throw new Error(`查找标题失败: ${table}`);

                return {
                    headerTitle,
                    content: Array.from(table.querySelectorAll('.lessontable-row')).map(row => {
                        const numberTag = row.querySelector('.lessontable-row-number')?.innerHTML;
                        const link = row.querySelector('a');

                        if (!link) throw new Error(`对应链接没找到: ${table}, .lessontable-row-number: ${numberTag}`);

                        return {
                            tag: numberTag || '',
                            title: link.innerHTML,
                            url: link.href
                        };
                    })
                };
            });
        });
    } catch (error) {
        console.error('Error fetching main site:', error);
        throw error;
    }
};

const fetchPage = async (lesson: ILessonContent): Promise<string> => {
    const browser = await getBrowserInstance();
    const page = await browser.newPage();

    try {
        await page.setViewport({ width: 1080, height: 1024 });
        await page.goto(lesson.url, { waitUntil: 'networkidle2', timeout: 30000 });

        await page.waitForSelector('.entry-content', { timeout: 15000 });

        return await page.evaluate(() => {
            const insert = document.querySelector('.humix-universal-js-insert')
            if (insert) {
                insert.remove()
            }
            const cf_monitor = document.querySelectorAll('.cf_monitor')
            if (cf_monitor.length) {
                cf_monitor.forEach(el => el.remove())
            }
            const content = document.querySelector('.entry-content')?.innerHTML;
            if (!content) throw new Error('没有找到页面元素.entry-content');
            const cleanContent = content!
                .replace(/<script[\s\S]*?<\/script>/gi, '') // 移除脚本
                .replace(/<!--[\s\S]*?-->/gi, '') // 移除注释
                .replace(/(class|id)=["'].*(ad|banner|tracking)["']/gi, 'class="filtered"') // 过滤广告类class
                .replace(/<style[\s\S]*?<\/style>/gi, ''); // 移除样式表
            return cleanContent;
        });
    } catch (error) {
        console.error(`爬取页面错误 ${lesson.url}:`, error);
        throw error;
    } finally {
        await page.close();
    }
};

const analyzePage = async (content: string): Promise<string> => {
    try {
        let responseText = ''
        const completion = await openai.chat.completions.create({
            model: "qwen-turbo",
            messages: [
                {
                    "role": "system", "content": `
                你是一名精通C/C++的计算机专业的教授，你精通程序编写和中英互译
                请严格按以下要求处理：
                1. 仅翻译英文内容，逐字逐句翻译
                2. 完全保留原始HTML标签结构和排版格式
                3. 需过滤以下元素：
                   - <script>、<style>、<noscript>等非内容标签
                   - 广告类class（如ad-banner、sponsored）
                   - 跟踪代码（如google-analytics）
                4. 输出结果需包含完整DOM树结构
                5. 若遇无法翻译的代码片段，用<!-- UNTRANSLATED_CODE -->标记` },
                { "role": "user", "content": content }
            ],
            stream: true,
        });
        for await (const chunk of completion) {
            stdout.write(chunk.choices[0].delta.content!)
            responseText += chunk.choices[0].delta.content
        }
        return responseText
    } catch (error) {
        console.error('AI分析失败:', error);
        throw error;
    }
};

const sanitizeFilename = (filename: string): string => {
    return filename.replace(/[\\/:*?"<>|]/g, '-').trim();
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const startLesson = async (lesson: ILessonContent, retryCount = 10): Promise<string> => {
    try {
        console.log(`正在爬取 ${lesson.title} ...`);

        const content = await fetchPage(lesson);
        const fileHtml = `${lesson.tag} ${sanitizeFilename(lesson.title)}.html`;
        await fs.writeFile(fileHtml, content, 'utf8');

        console.log(`保存网页文件: ${fileHtml}`);
        console.log(`爬取完成 分析 ${lesson.title} ...`);

        const analyzed = await analyzePage(content);
        const analyzedHtml = `${lesson.tag} ${sanitizeFilename(lesson.title)}.html`;
        await fs.writeFile(analyzedHtml, analyzed, 'utf8');
        console.log(`成功生成文件: ${analyzedHtml}`);
        return analyzed;
    } catch (error) {
        if (retryCount > 0) {
            console.log(`爬取 ${lesson.title} 失败, 重试中... (第 ${11 - retryCount} 次 共 10 次)`);
            await delay(3000);
            return startLesson(lesson, retryCount - 1);
        }
        throw new Error(`网页爬取错误: ${error}`);
    }
};

const processLessons = async (lessons: ILesson[]) => {
    const results = [];

    for (const lesson of lessons) {
        console.log(`处理 ${lesson.headerTitle} ...`);
        for (const [index, content] of lesson.content.entries()) {
            try {
                await delay(2000);
                console.log(`第 ${index + 1} 节 共 ${lesson.content.length} 节`);
                const result = await startLesson(content);
                results.push(result);
            } catch (error) {
                console.error(`${content.title} 分析错误: `, error);
            }
        }
    }

    return results;
};

(async () => {
    try {
        // const lessons = await fetchAllSites();
        // console.log('首页爬取完成, 开始整理子页面...');
        const lessons = allLesons
        console.log(`发现 ${lessons.length} 个章节，共 ${lessons.flatMap(l => l.content).length} 个子页面`);

        await processLessons(lessons);
    } catch (error) {
        console.error('Main execution failed:', error);
    } finally {
        await closeBrowserInstance();
    }
})();