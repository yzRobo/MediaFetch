// MediaFetch Server - Fixed version with proper error handling
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const crypto = require('crypto');

// Configuration
const config = {
    port: process.env.PORT || 8234,
    tempDir: process.env.TEMP_DIR || path.join(__dirname, 'temp'),
    enableAuth: process.env.ENABLE_AUTH === 'true',
    authUsername: process.env.AUTH_USERNAME || 'admin',
    authPassword: process.env.AUTH_PASSWORD || 'changeme',
    enableWebhooks: process.env.ENABLE_WEBHOOKS === 'true',
    webhookUrl: process.env.WEBHOOK_URL,
    webhookSecret: process.env.WEBHOOK_SECRET,
};

// Initialize Express app
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Middleware
app.use(express.json());

// Simple auth middleware if enabled
if (config.enableAuth) {
    app.use((req, res, next) => {
        if (req.path.startsWith('/images/') || req.path.endsWith('.css') || req.path.endsWith('.js') || req.path.startsWith('/download/')) {
            return next();
        }
        
        const auth = req.headers.authorization;
        if (!auth) {
            res.setHeader('WWW-Authenticate', 'Basic realm="MediaFetch"');
            return res.status(401).send('Authentication required');
        }
        
        const [username, password] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
        if (username === config.authUsername && password === config.authPassword) {
            next();
        } else {
            res.status(401).send('Invalid credentials');
        }
    });
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'public', 'images')));

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        service: 'MediaFetch',
        timestamp: new Date().toISOString()
    });
});

// Main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Ensure temp directory exists
if (!fs.existsSync(config.tempDir)) {
    fs.mkdirSync(config.tempDir, { recursive: true });
}

// Get the correct base directory
const getBasePath = () => {
    if (typeof process.pkg !== 'undefined') {
        return path.dirname(process.execPath);
    } else {
        return __dirname;
    }
};

const basePath = getBasePath();

// Path definitions for binaries
const platform = process.platform;
const ytDlpPath = path.join(basePath, 'bin', platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const ffmpegPath = path.join(basePath, 'bin', platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

// Store active downloads
const activeDownloads = new Map();
const preparedDownloads = new Map();
let isCancelled = false;
let activeProcesses = new Map();

// Check if yt-dlp and ffmpeg exist on startup
async function checkDependencies() {
    let allGood = true;
    
    try {
        await fs.promises.access(ytDlpPath, fs.constants.F_OK);
        console.log('✓ yt-dlp found at:', ytDlpPath);
    } catch (err) {
        console.error('✗ yt-dlp not found at:', ytDlpPath);
        console.error('Please run: npm install');
        allGood = false;
    }
    
    try {
        await fs.promises.access(ffmpegPath, fs.constants.F_OK);
        console.log('✓ ffmpeg found at:', ffmpegPath);
    } catch (err) {
        console.error('✗ ffmpeg not found at:', ffmpegPath);
        console.error('Note: ffmpeg is required for video+audio downloads');
        console.error('Please ensure ffmpeg-static is installed or run: npm install');
    }
    
    return allGood;
}

checkDependencies();

// Platform detection
function detectPlatform(url) {
    const urlLower = url.toLowerCase();
    
    if (urlLower.includes('vimeo.com')) return 'vimeo';
    if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) return 'youtube';
    if (urlLower.includes('twitter.com') || urlLower.includes('x.com')) return 'twitter';
    if (urlLower.includes('instagram.com')) return 'instagram';
    if (urlLower.includes('tiktok.com')) return 'tiktok';
    if (urlLower.includes('threads.net')) return 'threads';
    
    return 'other';
}

// Spawn function for cross-platform compatibility
function spawnYtDlp(args, options = {}) {
    const cleanArgs = args.map(arg => String(arg));
    
    if (platform === 'win32') {
        return spawn(ytDlpPath, cleanArgs, {
            ...options,
            windowsHide: true,
            shell: false,
            stdio: options.stdio || 'pipe'
        });
    } else {
        return spawn(ytDlpPath, cleanArgs, {
            ...options,
            shell: false,
            stdio: options.stdio || 'pipe'
        });
    }
}

// WebSocket handling
io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("start-download", async (data) => {
        console.log("Received download request with batches:", data.batches.length);
        isCancelled = false;
        
        const sessionId = crypto.randomBytes(16).toString('hex');
        await processAllBatches(data.batches, socket, sessionId);
    });

    socket.on("cancel-download", () => {
        console.log("Cancellation request received from:", socket.id);
        isCancelled = true;
        
        // Kill all active processes
        activeProcesses.forEach((process, id) => {
            if (process && !process.killed) {
                process.kill('SIGKILL');
            }
        });
        activeProcesses.clear();
    });

    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
    });
});

// Process all batches
async function processAllBatches(batches, socket, sessionId) {
    socket.emit("all-batches-start");
    
    const allDownloadIds = [];
    
    for (const [index, batch] of batches.entries()) {
        if (isCancelled) {
            socket.emit("log", { type: 'error', message: `Skipping remaining batches due to cancellation.` });
            break;
        }
        
        socket.emit("log", { type: 'info', message: `\n--- Starting Batch ${index + 1} / ${batches.length} (Prefix: ${batch.prefixMajor}.x, Format: ${batch.format}) ---` });
        socket.emit("new-batch-starting", { 
            batchIndex: index, 
            totalVideos: batch.videos.length 
        });
        
        const batchDownloadIds = await prepareBatch(batch, socket, index);
        allDownloadIds.push(...batchDownloadIds);
    }
    
    // Auto-trigger all downloads
    if (!isCancelled && allDownloadIds.length > 0) {
        socket.emit("auto-download-start", { 
            downloadIds: allDownloadIds,
            sessionId: sessionId 
        });
    }
    
    if (isCancelled) {
        socket.emit("log", { type: "error", message: "\nDownload process cancelled." });
    } else {
        socket.emit("log", { type: "success", message: "\nAll downloads prepared and started." });
    }
    
    socket.emit("all-batches-complete", { cancelled: isCancelled });
}

// Prepare single batch
async function prepareBatch(batchConfig, socket, batchIndex) {
    const { videos, prefixMajor, prefixMinorStart, format } = batchConfig;
    const downloadIds = [];
    
    socket.emit("log", { type: "info", message: `Preparing ${videos.length} videos for download...`});
    
    let prefixMinorCounter = parseInt(prefixMinorStart, 10);
    
    for (let i = 0; i < videos.length; i++) {
        if (isCancelled) {
            socket.emit("log", { type: 'error', message: `Skipping remaining videos due to cancellation.` });
            break;
        }
        
        const video = videos[i];
        const filePrefix = `${prefixMajor}.${prefixMinorCounter}_`;
        const platform = detectPlatform(video.url);
        
        socket.emit("log", { type: "info", message: `[${i + 1}/${videos.length}] Detected platform: ${platform}` });
        
        // Handle Vimeo URLs
        if (platform === 'vimeo') {
            let newUrl = video.url;
            const match = video.url.match(/vimeo\.com\/(\d+)\/([a-zA-Z0-9]+)/);
            if (match) {
                newUrl = `https://player.vimeo.com/video/${match[1]}?h=${match[2]}`;
            } else {
                const simpleMatch = video.url.match(/vimeo\.com\/(\d+)$/);
                if (simpleMatch) {
                    newUrl = `https://player.vimeo.com/video/${simpleMatch[1]}`;
                }
            }
            if (newUrl !== video.url) {
                socket.emit("log", { type: "info", message: `  Converted: ${video.url} -> ${newUrl}` });
            }
            video.url = newUrl;
        }
        
        const downloadId = await prepareDownload(video, i, videos.length, filePrefix, format, platform, socket, batchIndex);
        if (downloadId) {
            downloadIds.push(downloadId);
        }
        
        prefixMinorCounter++;
    }
    
    return downloadIds;
}

// Prepare download
async function prepareDownload(videoInfo, index, total, filenamePrefix, format, platform, socket, batchIndex) {
    const logPrefix = `[${index + 1}/${total}]`;
    
    try {
        await fs.promises.access(ytDlpPath, fs.constants.F_OK);
    } catch (err) {
        socket.emit("log", { type: "error", message: `${logPrefix} yt-dlp not found.` });
        socket.emit("progress", { index, status: `❌ Error: yt-dlp not found` });
        return null;
    }
    
    socket.emit("log", { type: "info", message: `${logPrefix} Getting video information...` });
    socket.emit("progress", { index, percentage: 0, status: "⏳ Fetching info..." });
    
    // Get video info
    let videoInfoJson = '';
    let errorOutput = '';
    
    try {
        const infoArgs = ['--dump-json', '--no-warnings'];
        
        if (videoInfo.domain) {
            infoArgs.push('--referer', videoInfo.domain);
        }
        
        // Add no-playlist flag here to prevent downloading entire playlists
        if (platform !== 'instagram') {
            infoArgs.push('--no-playlist');
        }
        
        infoArgs.push(videoInfo.url);
        
        const infoProcess = spawnYtDlp(infoArgs);
        
        infoProcess.stdout.on('data', (data) => {
            videoInfoJson += data.toString();
        });
        
        infoProcess.stderr.on('data', (data) => {
            const error = data.toString();
            errorOutput += error;
            if (!error.includes('WARNING')) {
                socket.emit("log", { type: "warning", message: `${logPrefix} ${error.trim()}` });
            }
        });
        
        const infoCode = await new Promise((resolve) => {
            infoProcess.on('close', (code) => resolve(code));
            infoProcess.on('error', (err) => {
                errorOutput += err.message;
                resolve(1);
            });
        });
        
        if (infoCode !== 0) {
            throw new Error(`Failed to get video info. Exit code: ${infoCode}`);
        }
    } catch (error) {
        socket.emit("log", { type: "error", message: `${logPrefix} ${error.message}` });
        socket.emit("progress", { index, status: `❌ Error: Failed to get info` });
        return null;
    }
    
    let videoDetails = { title: 'Unknown', duration: 0 };
    
    if (videoInfoJson) {
        try {
            const lastLine = videoInfoJson.trim().split('\n').pop();
            const info = JSON.parse(lastLine);
            videoDetails = { 
                title: info.title || 'Unknown', 
                duration: info.duration || 0,
                thumbnail: info.thumbnail || null
            };
            socket.emit("log", { type: "info", message: `${logPrefix} Found: ${videoDetails.title}` });
        } catch (e) {
            socket.emit("log", { type: "error", message: `${logPrefix} Failed to parse video info: ${e.message}` });
        }
    }
    
    const sanitizedTitle = (videoDetails.title || 'Unknown')
        .replace(/\.(mp4|mkv|webm|mov|avi|mp3|m4a)$/i, '')
        .replace(/[<>:"/\\|?*]/g, '_')
        .trim();
    
    let filename = (filenamePrefix || "") + sanitizedTitle;
    
    // Add extension based on format
    switch (format) {
        case 'audio-mp3':
            filename += '.mp3';
            break;
        case 'audio-m4a':
            filename += '.m4a';
            break;
        case 'video-only':
            filename += '_No_Audio.mp4';
            break;
        default:
            filename += '.mp4';
            break;
    }
    
    // Create download ID
    const downloadId = crypto.randomBytes(16).toString('hex');
    
    // Store download info
    preparedDownloads.set(downloadId, {
        url: videoInfo.url,
        domain: videoInfo.domain,
        format,
        filename,
        title: videoDetails.title,
        duration: videoDetails.duration,
        platform,
        index,
        batchIndex,
        status: 'prepared'
    });
    
    socket.emit("progress", {
        index: index,
        percentage: 100,
        status: "✅ Ready to download",
        filename: filename
    });
    
    return downloadId;
}

// Download endpoint
app.get('/download/:downloadId', async (req, res) => {
    const downloadId = req.params.downloadId;
    const downloadInfo = preparedDownloads.get(downloadId);
    
    if (!downloadInfo) {
        return res.status(404).send('Download not found');
    }
    
    const { url, domain, format, filename, index, duration, platform } = downloadInfo;
    
    console.log(`Starting download: ${filename}`);
    
    // Update status
    downloadInfo.status = 'downloading';
    activeDownloads.set(downloadId, downloadInfo);
    
    // Emit download started
    io.emit("download-started", { downloadId, index });
    
    // Set headers
    res.setHeader('Content-Type', format.includes('audio') ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    // Prepare yt-dlp arguments
    const ytDlpArgs = [];
    
    if (domain) {
        ytDlpArgs.push('--referer', domain);
    }
    
    // Format-specific arguments
    switch (format) {
        case 'audio-mp3':
            ytDlpArgs.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
            break;
        case 'audio-m4a':
            ytDlpArgs.push('-x', '--audio-format', 'm4a', '--audio-quality', '0');
            break;
        case 'video-only':
            // For platforms other than YouTube, we need to handle differently
            if (platform === 'youtube') {
                ytDlpArgs.push('-f', 'bestvideo[ext=mp4]/bestvideo');
            } else {
                // For other platforms, download best and strip audio with ffmpeg
                ytDlpArgs.push('-f', 'best[ext=mp4]/best');
                ytDlpArgs.push('--postprocessor-args', 'ffmpeg:-an -c:v copy');
            }
            break;
        default:
            // For video+audio, use simpler format selection that's more reliable
            ytDlpArgs.push('-f', 'best[ext=mp4]/best');
            // Don't use merge-output-format with stdout
            // ytDlpArgs.push('--merge-output-format', 'mp4');
            // Don't use remux-video with stdout
            // ytDlpArgs.push('--remux-video', 'mp4');
            // Metadata embedding might cause issues with stdout
            // ytDlpArgs.push('--embed-subs', '--embed-thumbnail', '--add-metadata');
            break;
    }
    
    // Common arguments
    ytDlpArgs.push('-o', '-');  // Output to stdout
    ytDlpArgs.push('--no-warnings');
    ytDlpArgs.push('--no-progress');
    
    // Conditionally allow multi-file downloads ONLY for Instagram carousels
    if (platform === 'instagram') {
        console.log('Instagram post detected. Multi-video download enabled.');
    } else {
        ytDlpArgs.push('--no-playlist');
    }
    
    // Add ffmpeg location if available
    if (fs.existsSync(ffmpegPath)) {
        ytDlpArgs.push('--ffmpeg-location', ffmpegPath);
        console.log('Using ffmpeg at:', ffmpegPath);
    } else {
        console.log('Warning: ffmpeg not found at expected location, using system ffmpeg');
    }
    
    ytDlpArgs.push(url);
    
    console.log('Starting download command...');
    console.log('Command:', ytDlpPath);
    console.log('Arguments:', ytDlpArgs.join(' '));
    
    // Start download
    const downloadProcess = spawnYtDlp(ytDlpArgs, {
        maxBuffer: 1024 * 1024 * 1024, // 1GB buffer
        stdio: ['ignore', 'pipe', 'pipe']
    });
    
    // Store process
    activeProcesses.set(downloadId, downloadProcess);
    
    let totalBytes = 0;
    let hasError = false;
    let lastProgress = 0;
    let debugOutput = '';
    
    // Parse progress from stderr
    downloadProcess.stderr.on('data', (data) => {
        const output = data.toString();
        debugOutput += output;
        
        // Log first few lines of stderr for debugging
        if (debugOutput.length < 1000) {
            console.log('yt-dlp stderr:', output.trim());
        }
        
        // Look for download progress
        const percentMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
        if (percentMatch) {
            const percent = parseFloat(percentMatch[1]);
            if (percent > lastProgress) {
                lastProgress = percent;
                io.emit("download-progress", {
                    downloadId,
                    index,
                    percentage: Math.round(percent),
                    bytesDownloaded: totalBytes
                });
            }
        }
        
        // Check if it's downloading audio only
        if (output.includes('[ExtractAudio]') || output.includes('Extracting audio')) {
            console.warn('WARNING: yt-dlp is extracting audio only!');
            io.emit("log", { 
                type: "warning", 
                message: "Warning: Download appears to be audio-only. Check format settings." 
            });
        }
        
        // Check for format selection
        if (output.includes('format:')) {
            console.log('Selected format:', output);
        }
        
        // Check for errors
        if (output.includes('ERROR') || output.includes('error:')) {
            console.error(`Download error for ${filename}:`, output);
            hasError = true;
        }
    });
    
    // Pipe stdout to response
    downloadProcess.stdout.pipe(res);
    
    downloadProcess.stdout.on('data', (chunk) => {
        totalBytes += chunk.length;
    });
    
    downloadProcess.on('error', (error) => {
        console.error(`Process error for ${filename}:`, error);
        hasError = true;
        if (!res.headersSent) {
            res.status(500).end();
        }
    });
    
    downloadProcess.on('close', (code) => {
        activeProcesses.delete(downloadId);
        
        const status = code === 0 && !hasError ? 'completed' : 'failed';
        downloadInfo.status = status;
        
        console.log(`Download ${status}: ${filename} (exit code: ${code})`);
        
        io.emit("download-complete", {
            downloadId,
            index,
            status,
            totalBytes
        });
        
        // Send webhook if enabled
        if (config.enableWebhooks && config.webhookUrl) {
            sendWebhook('download.completed', {
                downloadId,
                title: downloadInfo.title,
                filename,
                status,
                totalBytes,
                duration
            });
        }
        
        // Cleanup
        setTimeout(() => {
            preparedDownloads.delete(downloadId);
            activeDownloads.delete(downloadId);
        }, 300000); // 5 minutes
    });
    
    // Handle client disconnect
    let clientDisconnected = false;
    res.on('close', () => {
        clientDisconnected = true;
        if (downloadProcess && !downloadProcess.killed) {
            console.log(`Client disconnected, killing download: ${filename}`);
            downloadProcess.kill('SIGTERM');
            activeProcesses.delete(downloadId);
        }
    });
    
    res.on('error', (err) => {
        console.error(`Response error for ${filename}:`, err);
        clientDisconnected = true;
    });
});

// Webhook function
async function sendWebhook(event, data) {
    if (!config.enableWebhooks || !config.webhookUrl) return;
    
    const payload = {
        event,
        timestamp: new Date().toISOString(),
        service: 'MediaFetch',
        data
    };
    
    try {
        const axios = require('axios');
        await axios.post(config.webhookUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
                'X-Webhook-Secret': config.webhookSecret || ''
            }
        });
    } catch (error) {
        console.error('Webhook error:', error.message);
    }
}

// Utility functions
function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Start server
httpServer.listen(config.port, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════╗
║          MediaFetch Server            ║
║                                       ║
║  Running on: http://0.0.0.0:${config.port}     ║
║  Auth: ${config.enableAuth ? 'Enabled' : 'Disabled'}                       ║
║                                       ║
║  Files download to your browser's     ║
║  default download location            ║
╚═══════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    httpServer.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});