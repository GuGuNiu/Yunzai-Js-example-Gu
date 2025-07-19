import fetch from 'node-fetch';
import common from "../../lib/common/common.js";
import fs from "fs/promises";
import path from "path";

const logger_Prefix = `『咕咕牛🐂』[抖音解析]`;

export class Douyin extends plugin {
  constructor() {
    super({
      name: '『咕咕牛🐂』抖音解析',
      dsc: '解析抖音并发送视频',
      event: 'message',
      priority: -1, 
      rule: [
        {
          reg: /https?:\/\/(v\.douyin\.com)\/[a-zA-Z0-9]+/,
          fnc: 'Douyin'
        }
      ]
    });

    this.logger = global.logger || console;
    
    this.cachePath = './temp/GuGuNiu/DouyinCache';
    this.cacheLimit = 10;  //本地缓存数量

    this.apiEndpoints = [
      {
        name: 'Peark-API',
        url: 'https://api.pearktrue.cn/api/video/douyin/',
        method: 'GET',
        params: (link) => `?url=${encodeURIComponent(link)}`,
        parser: (data) => data.url
      },
      {
        name: '渺软公益-API',
        url: 'https://zj.v.api.aa1.cn/api/douyinjx/',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        params: (link) => `url=${encodeURIComponent(link)}`,
        parser: (data) => data.play,
        success_code: 1 
      }
    ];
  }
  
  async _getCacheKey(link) {
    const match = link.match(/([a-zA-Z0-9]+)\/?$/);
    return match ? match[1] : null;
  }

  async _findInCache(cacheKey) {
    if (!cacheKey) return null;
    const filePath = path.join(this.cachePath, `${cacheKey}.mp4`);
    try {
      await fs.access(filePath);
      return filePath;
    } catch (error) {
      return null;
    }
  }

  async _saveToCache(cacheKey, videoUrl) {
    if (!cacheKey) return null;
    try {
      await fs.mkdir(this.cachePath, { recursive: true });
      const filePath = path.join(this.cachePath, `${cacheKey}.mp4`);
      
      const response = await fetch(videoUrl, { timeout: 45000 });
      if (!response.ok) throw new Error(`下载视频失败，状态码: ${response.status}`);
      
      const buffer = await response.arrayBuffer();
      await fs.writeFile(filePath, Buffer.from(buffer));
      
      return filePath;
    } catch (error) {
      this.logger.error(`${logger_Prefix} 缓存视频失败 [${cacheKey}]:`, error);
      return null;
    }
  }

  async _manageCache() {
    try {
        const files = await fs.readdir(this.cachePath);
        if (files.length <= this.cacheLimit) return;

        const fileStats = await Promise.all(
            files.map(async (file) => {
                const filePath = path.join(this.cachePath, file);
                const stats = await fs.stat(filePath);
                return { file, mtime: stats.mtime };
            })
        );
        
        fileStats.sort((a, b) => a.mtime - b.mtime);
        
        const filesToDelete = fileStats.slice(0, fileStats.length - this.cacheLimit);
        
        for (const fileInfo of filesToDelete) {
            this.logger.info(`${logger_Prefix} 清理旧缓存: ${fileInfo.file}`);
            await fs.unlink(path.join(this.cachePath, fileInfo.file));
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            this.logger.error(`${logger_Prefix} 管理缓存时发生错误:`, error);
        }
    }
  }

  async Douyin(e) {
    const linkMatch = e.msg.match(/https?:\/\/(v\.douyin\.com)\/[a-zA-Z0-9]+/);
    if (!linkMatch) return false; 
    
    const shareLink = linkMatch[0];
    const cacheKey = await this._getCacheKey(shareLink);

    const cachedPath = await this._findInCache(cacheKey);
    if (cachedPath) {
      //this.logger.info(`${logger_Prefix} 缓存命中: ${cacheKey}`);
      await e.reply(segment.video(`file://${path.resolve(cachedPath)}`));
      return true;
    }
    
    //this.logger.info(`${logger_Prefix} 缓存未命中，开始解析链接: ${shareLink}`);

    for (const api of this.apiEndpoints) {
      this.logger.info(`${logger_Prefix} 正在尝试使用 [${api.name}] 进行解析...`);
      try {
        let fetchOptions = {
          method: api.method,
          headers: { 
            'User-Agent': 'Miao-Yunzai-GuGuNiu-Plugin',
            ...(api.headers || {}) 
          },
          timeout: 15000 
        };
        
        let fullUrl = api.url;

        if (api.method === 'GET') {
          fullUrl += api.params(shareLink);
        } else if (api.method === 'POST') {
          fetchOptions.body = api.params(shareLink);
        }

        const response = await fetch(fullUrl, fetchOptions);
        if (!response.ok) throw new Error(`API请求失败，HTTP状态码: ${response.status}`);
        
        const result = await response.json();
        const successCode = api.success_code === undefined ? 200 : api.success_code;
        if (result.code !== successCode) throw new Error(`API返回错误: ${result.msg || '未知错误'}`);
        
        const videoData = result.data;
        if (!videoData) throw new Error('API返回数据中缺少 data 字段');

        const videoUrl = api.parser(videoData);
        if (!videoUrl) throw new Error('从API返回数据中未能提取到视频地址');
        
        const localVideoPath = await this._saveToCache(cacheKey, videoUrl);
        if (!localVideoPath) throw new Error('视频下载或保存至本地缓存失败');

        await this._manageCache();

        const videoTitle = videoData.title || '无标题';
        this.logger.info(`${logger_Prefix} [${api.name}] 解析成功，标题: ${videoTitle}`);
        
        const replyMsg = [
          `标题：${videoTitle}`,
          segment.video(`file://${path.resolve(localVideoPath)}`)
        ];

        if (e.isGroup && common.makeForwardMsg) {
           let forwardMsg = await common.makeForwardMsg(e, replyMsg, `咕咕牛视频解析`);
           await e.reply(forwardMsg);
        } else {
           await e.reply(replyMsg[0]);
           await common.sleep(500);
           await e.reply(replyMsg[1]);
        }
        
        return true; 

      } catch (error) {
        //this.logger.warn(`${logger_Prefix} [${api.name}] 解析失败: ${error.message}。正在尝试下一个节点...`);
      }
    }

    //this.logger.error(`${logger_Prefix} 所有解析节点均尝试失败。`);
    await e.reply("解析失败了，所有的接口都联系不上或返回错误。", true);

    return true; 
  }
}