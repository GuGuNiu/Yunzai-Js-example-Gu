import fetch from 'node-fetch';
import common from "../../lib/common/common.js";
import fs from "fs/promises";
import path from "path";
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { exec } from 'child_process';

ffmpeg.setFfmpegPath(ffmpegStatic);

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
          fnc: 'Douyin'
        }
      ]
    });

    this.logger = global.logger || console;
    
    this.cachePath = './temp/GuGuNiu/DouyinCache';
    this.cacheNum = 10;
    this.compressionThreshold = 20;
    this.splitThreshold = 70; // 视频切片阈值（MB）

    this.ffmpegChecked = false;
    this.ffmpegInstallScriptPath = null;
    try {
        const ffmpegDir = path.dirname(ffmpegStatic);
        this.ffmpegInstallScriptPath = path.join(ffmpegDir, 'install.js');
    } catch (err) {
        this.logger.error(`${logger_Prefix} 严重错误：无法定位 ffmpeg-static 包的路径。`);
    }

    this.APIS = [
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
      },
      {
        name: 'DouyinWTF',
        url: 'https://api.douyin.wtf/api/download',
        method: 'GET',
        params: (link) => `?url=${encodeURIComponent(link)}&prefix=true&with_watermark=false`,
        parser: (data) => {
          const urls = data?.video_url || {};
          return urls['360p'] || urls['480p'] || urls['720p'] || null;
        }
      }
    ];
  }
  
  _runInstallScript() {
    return new Promise(resolve => {
        this.logger.warn(`${logger_Prefix} 尝试自动执行安装脚本: node ${path.basename(this.ffmpegInstallScriptPath)}`);
        exec(`node "${this.ffmpegInstallScriptPath}"`, { cwd: path.dirname(this.ffmpegInstallScriptPath) }, (error, stdout, stderr) => {
            if (error) {
                this.logger.error(`${logger_Prefix} 自动安装失败:`, error);
                resolve(false);
            } else {
                fs.access(ffmpegStatic).then(() => resolve(true)).catch(() => resolve(false));
            }
        });
    });
  }

  async _ensureFfmpeg(e) {
    if (this.ffmpegChecked) return true;
    try {
        await fs.access(ffmpegStatic);
        this.ffmpegChecked = true;
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') {
            //await e.reply("正在尝试自动修复FFmpeg环境...", true);
            const success = await this._runInstallScript();
            if (success) {
                this.ffmpegChecked = true;
                //await e.reply("环境修复成功！将继续处理视频。", true);
                return true;
            }
            return false;
        }
        return false;
    }
  }

  compress(input, output, targetHeight = 360) {
    return new Promise((resolve, reject) => {
      ffmpeg(input)
        .videoCodec('libx264')
        .audioCodec('aac')
        .size(`?x${targetHeight}`)
        .outputOptions(['-preset veryfast', '-crf 23', '-movflags +faststart'])
        .save(output)
        .on('end', () => resolve(output))
        .on('error', err => {
          this.logger.error(`${logger_Prefix} 视频压缩失败`, err);
          reject(err);
        });
    });
  }

  async _splitVideo(inputPath, outputDir, chunkDuration = 55) {
    const baseName = path.basename(inputPath, '.mp4');
    const outputPattern = path.join(outputDir, `${baseName}_chunk_%03d.mp4`);
    
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-c copy',
          '-f segment',
          `-segment_time ${chunkDuration}`,
          '-reset_timestamps 1'
        ])
        .output(outputPattern)
        .on('end', async () => {
          try {
            const files = await fs.readdir(outputDir);
            const chunkPaths = files
              .filter(file => file.startsWith(`${baseName}_chunk_`))
              .map(file => path.join(outputDir, file))
              .sort();
            resolve(chunkPaths);
          } catch (e) {
            reject(e);
          }
        })
        .on('error', err => {
          this.logger.error(`${logger_Prefix} 视频切片失败`, err);
          reject(err);
        });
    });
  }
  
  async _getCacheKey(link) {
    const match = link.match(/(?:v\.douyin\.com\/|\/video\/)([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
  }

  async _findInCache(cacheKey) {
    if (!cacheKey) return null;
    const path240p = path.join(this.cachePath, `${cacheKey}_240p.mp4`);
    try { await fs.access(path240p); return path240p; } catch (error) {}
    const path360p = path.join(this.cachePath, `${cacheKey}_360p.mp4`);
    try { await fs.access(path360p); return path360p; } catch (error) {}
    const originalPath = path.join(this.cachePath, `${cacheKey}.mp4`);
    try { await fs.access(originalPath); return originalPath; } catch (error) { return null; }
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
        if (files.length <= this.cacheNum) return;
        const fileStats = await Promise.all(files.map(async (file) => {
            const filePath = path.join(this.cachePath, file);
            const stats = await fs.stat(filePath);
            return { file, mtime: stats.mtime };
        }));
        fileStats.sort((a, b) => a.mtime - b.mtime);
        const filesToDelete = fileStats.slice(0, fileStats.length - this.cacheNum);
        for (const fileInfo of filesToDelete) {
            await fs.unlink(path.join(this.cachePath, fileInfo.file));
        }
    } catch (error) {
        if (error.code !== 'ENOENT') this.logger.error(`${logger_Prefix} 管理缓存时发生错误:`, error);
    }
  }

  async Douyin(e) {
    const linkMatch = e.msg.match(/https?:\/\/[^\s]*douyin\.com[^\s]*/);
    if (!linkMatch) return false; 
    
    const shareLink = linkMatch[0];
    const cacheKey = await this._getCacheKey(shareLink);
    const cachedPath = await this._findInCache(cacheKey);
    if (cachedPath) {
      await e.reply(segment.video(cachedPath));
      return true;
    }
    
    for (const api of this.APIS) {
      try {
        let fetchOptions = {
          method: api.method,
          headers: { 'User-Agent': 'GuGuNiu', ...(api.headers || {}) },
          timeout: 15000 
        };
        
        let fullUrl = api.url;
        if (api.method === 'GET') {
          fullUrl += api.params(shareLink);
        } else {
          fetchOptions.body = api.params(shareLink);
        }

        const response = await fetch(fullUrl, fetchOptions);
        if (!response.ok) throw new Error(`API请求失败，状态码: ${response.status}`);
        
        const result = await response.json();
        const successCode = api.success_code === undefined ? 200 : api.success_code;
        if (result.code !== successCode) throw new Error(`API返回错误: ${result.msg || '未知错误'}`);
        
        const videoData = result.data;
        if (!videoData) throw new Error('API返回数据中缺少 data 字段');

        const videoUrl = api.parser(videoData);
        if (!videoUrl) throw new Error('从API返回数据中未能提取到视频地址');
        
        const rawVideoPath = await this._saveToCache(cacheKey, videoUrl);
        if (!rawVideoPath) throw new Error('视频下载或保存至本地缓存失败');

        let finalVideoPath = rawVideoPath;
        const stats = await fs.stat(rawVideoPath);
        const fileSizeInMB = stats.size / (1024 * 1024);

        let targetHeight = 0;
        if (fileSizeInMB > 50) {
            targetHeight = 240;
        } else if (fileSizeInMB > this.compressionThreshold) {
            targetHeight = 360;
        }

        if (targetHeight > 0) {
            const ffmpegReady = await this._ensureFfmpeg(e);
            if (ffmpegReady) {
                const compressedPath = path.join(this.cachePath, `${cacheKey}_${targetHeight}p.mp4`);
                try {
                    await this.compress(rawVideoPath, compressedPath, targetHeight);
                    finalVideoPath = compressedPath;
                    await fs.unlink(rawVideoPath);
                } catch (compressError) {
                    this.logger.error(`${logger_Prefix} 压缩失败，将尝试发送原始文件。`);
                }
            } else {
                //await e.reply("FFmpeg 环境异常且无法自动修复，将尝试发送原始文件。", true);
            }
        }
        
        const videoTitle = videoData.title || '无标题';
        
        const finalStats = await fs.stat(finalVideoPath);
        const finalSizeInMB = finalStats.size / (1024 * 1024);

        if (finalSizeInMB > this.splitThreshold) {
          const ffmpegReady = await this._ensureFfmpeg(e);
          if (ffmpegReady) {
              //this.logger.info(`${logger_Prefix} 最终文件大小 (${finalSizeInMB.toFixed(2)}MB) 超出切片阈值，开始切片并合并转发...`);
              //await e.reply(`标题：${videoTitle}\n视频过大，正在分段处理...`, true);
              const chunks = await this._splitVideo(finalVideoPath, this.cachePath);

              if (chunks && chunks.length > 0) {
                  const forwardNodes = chunks.map((chunkPath, index) => ({
                      user_id: e.self_id,
                      nickname: `视频片段 (${index + 1}/${chunks.length})`,
                      message: segment.video(chunkPath)
                  }));
                  
                  const forwardMsg = await common.makeForwardMsg(e, forwardNodes, `[视频] ${videoTitle}`);
                  await e.reply(forwardMsg);

                  for (const chunk of chunks) {
                      await fs.unlink(chunk).catch(err => this.logger.error(`清理切片失败: ${chunk}`, err));
                  }
                  await fs.unlink(finalVideoPath).catch(err => this.logger.error(`清理大文件失败: ${finalVideoPath}`, err));
              } else {
                  await e.reply(segment.video(finalVideoPath));
              }
          } else {
              await e.reply(segment.video(finalVideoPath));
          }
        } else {
            //await e.reply(`标题：${videoTitle}`);
            //await common.sleep(500);
            await e.reply(segment.video(finalVideoPath));
        }
        
        await this._manageCache();
        return true; 

      } catch (error) {
        this.logger.warn(`${logger_Prefix} [${api.name}] 解析失败: ${error.message}。`);
      }
    }

    this.logger.error(`${logger_Prefix} 所有解析节点均尝试失败。`);
    return true; 
  }
}
