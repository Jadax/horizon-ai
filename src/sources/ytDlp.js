import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

const execAsync = promisify(exec);

export async function fetchVideoMetadata(url, options = {}) {
    const timeout = options.timeout || 30000;
    const ytDlpPath = config.ytDlpPath || 'yt-dlp';
    
    try {
        const cmd = `"${ytDlpPath}" --dump-json --no-download --quiet "${url}"`;
        const { stdout, stderr } = await execAsync(cmd, { timeout, maxBuffer: 10 * 1024 * 1024 });
        
        if (stderr && !stderr.includes('WARNING')) {
            console.warn('[yt-dlp] stderr:', stderr);
        }
        
        const data = JSON.parse(stdout);
        
        return {
            title: data.title || 'Untitled video',
            url: data.webpage_url || url,
            duration: data.duration || 0,
            views: data.view_count || 0,
            likes: data.like_count || 0,
            comments: data.comment_count || 0,
            uploader: data.uploader || data.channel || 'Unknown',
            platform: data.extractor || detectPlatform(url),
            thumbnailUrl: data.thumbnail || null,
            downloadUrl: null,
            raw: data,
        };
    } catch (error) {
        console.error('[yt-dlp] Metadata fetch failed:', error.message);
        throw new Error(`yt-dlp metadata fetch failed: ${error.message}`);
    }
}

export async function downloadVideo(url, options = {}) {
    const format = options.format || 'mp4';
    const quality = options.quality || 'best';
    const ytDlpPath = config.ytDlpPath || 'yt-dlp';
    
    const tmpFile = path.join(tmpdir(), `horizon-${randomUUID()}.${format}`);
    
    try {
        const cmd = `"${ytDlpPath}" -f "${quality}[ext=${format}]" -o "${tmpFile}" --quiet "${url}"`;
        await execAsync(cmd, { timeout: 120000 });
        
        const buffer = await import('node:fs/promises').then(fs => fs.readFile(tmpFile));
        const metadata = await fetchVideoMetadata(url);
        metadata.downloadUrl = null;
        
        await unlink(tmpFile).catch(() => {});
        
        return {
            buffer,
            filename: path.basename(tmpFile),
            metadata,
        };
    } catch (error) {
        await unlink(tmpFile).catch(() => {});
        console.error('[yt-dlp] Download failed:', error.message);
        throw new Error(`yt-dlp download failed: ${error.message}`);
    }
}

export async function getDownloadUrl(url) {
    const ytDlpPath = config.ytDlpPath || 'yt-dlp';
    try {
        const cmd = `"${ytDlpPath}" -g -f best "${url}"`;
        const { stdout } = await execAsync(cmd, { timeout: 30000 });
        const lines = stdout.trim().split('\n');
        return lines[0] || null;
    } catch (error) {
        console.warn('[yt-dlp] Could not extract direct download URL:', error.message);
        return null;
    }
}

export async function batchFetchVideoMetadata(urls, options = {}) {
    const results = [];
    for (const url of urls) {
        try {
            const meta = await fetchVideoMetadata(url, options);
            results.push(meta);
        } catch (error) {
            results.push({ url, error: error.message });
        }
    }
    return results;
}

function detectPlatform(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        if (hostname.includes('youtube') || hostname.includes('youtu.be')) return 'youtube';
        if (hostname.includes('tiktok')) return 'tiktok';
        if (hostname.includes('instagram')) return 'instagram';
        if (hostname.includes('facebook') || hostname.includes('fb.')) return 'facebook';
        if (hostname.includes('twitter') || hostname.includes('x.com')) return 'twitter';
        if (hostname.includes('reddit')) return 'reddit';
        if (hostname.includes('vimeo')) return 'vimeo';
        if (hostname.includes('twitch')) return 'twitch';
        if (hostname.includes('kick')) return 'kick';
        if (hostname.includes('dailymotion')) return 'dailymotion';
        return 'unknown';
    } catch {
        return 'unknown';
    }
}