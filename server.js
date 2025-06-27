// MediaFetch Server - Stream downloads directly to users
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Configuration
const config = {
    port: process.env.PORT || 3000,
    tempDir: process.env.TEMP_DIR || path.join(__dirname, 'temp'),
    enableAuth: process.env.ENABLE_AUTH === 'true',
    authUsername: process.env.AUTH_USERNAME || 'admin',
    authPassword: process.env.AUTH_PASSWORD || 'changeme',
    enableWebhooks: process.env.ENABLE_WEBHOOKS === 'true',
    webhookUrl: process.env.WEBHOOK_URL,
    webhookSecret: process.env.WEBHOOK_SECRET,
    maxConcurrentDownloads: parseInt(process.env.MAX_CONCURRENT_DOWNLOADS) || 3,
    cleanupInterval: parseInt(process.env.CLEANUP_INTERVAL) || 3600000, // 1 hour
    maxFileAge: parseInt(process.env.MAX_FILE_AGE) || 7200000, // 2 hours
};

// Initialize Express app
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    maxHttpBufferSize: 1e8 // 100 MB
});

// Middleware
app.use(express.json());

// Simple auth middleware if enabled
if (config.enableAuth) {
    app.use((req, res, next) => {
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

// Store active downloads
const activeDownloads = new Map();

// Cleanup old temp files
function cleanupTempFiles() {
    const now = Date.now();
    fs.readdir(config.tempDir, (err, files) => {
        if (err) return;
        
        files.forEach(file => {
            const filePath = path.join(config.tempDir, file);
            fs.stat(filePath, (err, stats) => {
                if (err) return;
                
                if (now - stats.mtimeMs > config.maxFileAge) {
                    fs.unlink(filePath, err => {
                        if (!err) console.log(`Cleaned up old file: ${file}`);
                    });
                }
            });
        });
    });
}

// Start cleanup interval
setInterval(cleanupTempFiles, config.cleanupInterval);

// Ensure temp directory exists
if (!fs.existsSync(config.tempDir)) {
    fs.mkdirSync(config.tempDir, { recursive: true });
}

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

// Webhook notification
async function sendWebhook(event, data) {
    if (!config.enableWebhooks || !config.webhookUrl) return;
    
    try {
        const payload = {
            event,
            timestamp: new Date().toISOString(),
            service: 'MediaFetch',
            data
        };
        
        const signature = config.webhookSecret 
            ? crypto.createHmac('sha256', config.webhookSecret).update(JSON.stringify(payload)).digest('hex')
            : null;
        
        await fetch(config.webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(signature && { 'X-MediaFetch-Signature': signature })
            },
            body: JSON.stringify(payload)
        });
    } catch (error) {
        console.error('Webhook error:', error);
    }
}

// Download preparation endpoint
app.post('/api/prepare-download', async (req, res) => {
    const { url, format, referer } = req.body;
    const downloadId = crypto.randomBytes(16).toString('hex');
    const platform = detectPlatform(url);
    
    try {
        // Get video info first
        const ytDlpPath = path.join(__dirname, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
        const infoArgs = ['--dump-json', '--no-warnings'];
        
        if (referer) {
            infoArgs.push('--referer', referer);
        }
        
        infoArgs.push(url);
        
        const infoProcess = spawn(ytDlpPath, infoArgs);
        let infoData = '';
        let errorData = '';
        
        infoProcess.stdout.on('data', (data) => {
            infoData += data.toString();
        });
        
        infoProcess.stderr.on('data', (data) => {
            errorData += data.toString();
        });
        
        infoProcess.on('close', async (code) => {
            if (code !== 0) {
                return res.status(500).json({ error: 'Failed to get video info', details: errorData });
            }
            
            try {
                const videoInfo = JSON.parse(infoData.trim().split('\n').pop());
                const title = videoInfo.title || 'Unknown';
                const duration = videoInfo.duration || 0;
                
                // Determine file extension based on format
                let extension = '.mp4';
                if (format === 'audio-mp3') extension = '.mp3';
                else if (format === 'audio-m4a') extension = '.m4a';
                else if (format === 'video-only') extension = '_no_audio.mp4';
                
                const safeTitle = title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
                const filename = `${safeTitle}${extension}`;
                
                // Store download info
                activeDownloads.set(downloadId, {
                    url,
                    format,
                    referer,
                    filename,
                    title,
                    duration,
                    platform,
                    status: 'prepared',
                    createdAt: Date.now()
                });
                
                // Send webhook
                sendWebhook('download.prepared', {
                    downloadId,
                    title,
                    platform,
                    format,
                    duration
                });
                
                res.json({
                    downloadId,
                    filename,
                    title,
                    duration,
                    platform,
                    estimatedSize: videoInfo.filesize || videoInfo.filesize_approx || null
                });
                
            } catch (parseError) {
                res.status(500).json({ error: 'Failed to parse video info' });
            }
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Stream download endpoint
app.get('/api/download/:downloadId', (req, res) => {
    const downloadId = req.params.downloadId;
    const downloadInfo = activeDownloads.get(downloadId);
    
    if (!downloadInfo) {
        return res.status(404).json({ error: 'Download not found' });
    }
    
    const { url, format, referer, filename, title } = downloadInfo;
    
    // Update status
    downloadInfo.status = 'downloading';
    downloadInfo.startedAt = Date.now();
    
    // Set headers for file download
    res.setHeader('Content-Type', format.includes('audio') ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    // Prepare yt-dlp arguments
    const ytDlpPath = path.join(__dirname, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    const ytDlpArgs = [];
    
    if (referer) {
        ytDlpArgs.push('--referer', referer);
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
            ytDlpArgs.push('-f', 'bestvideo[ext=mp4]/bestvideo', '--no-audio');
            break;
        default:
            ytDlpArgs.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4');
            break;
    }
    
    // Output to stdout for streaming
    ytDlpArgs.push('-o', '-', '--no-warnings', '--no-progress', '--quiet');
    
    // Add ffmpeg location if available
    const ffmpegPath = path.join(__dirname, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (fs.existsSync(ffmpegPath)) {
        ytDlpArgs.push('--ffmpeg-location', ffmpegPath);
    }
    
    ytDlpArgs.push(url);
    
    // Start download process
    const downloadProcess = spawn(ytDlpPath, ytDlpArgs);
    
    let totalBytes = 0;
    let hasError = false;
    
    // Pipe stdout directly to response
    downloadProcess.stdout.pipe(res);
    
    downloadProcess.stdout.on('data', (chunk) => {
        totalBytes += chunk.length;
        
        // Emit progress via WebSocket if client is connected
        io.emit(`download-progress-${downloadId}`, {
            downloadId,
            bytesDownloaded: totalBytes,
            status: 'downloading'
        });
    });
    
    downloadProcess.stderr.on('data', (data) => {
        console.error(`Download error for ${downloadId}:`, data.toString());
    });
    
    downloadProcess.on('error', (error) => {
        hasError = true;
        console.error(`Process error for ${downloadId}:`, error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Download process failed' });
        }
    });
    
    downloadProcess.on('close', (code) => {
        downloadInfo.status = hasError || code !== 0 ? 'failed' : 'completed';
        downloadInfo.completedAt = Date.now();
        downloadInfo.totalBytes = totalBytes;
        
        // Send webhook
        sendWebhook('download.completed', {
            downloadId,
            title,
            filename,
            status: downloadInfo.status,
            totalBytes,
            duration: downloadInfo.completedAt - downloadInfo.startedAt
        });
        
        // Clean up after a delay
        setTimeout(() => {
            activeDownloads.delete(downloadId);
        }, 300000); // 5 minutes
    });
    
    // Handle client disconnect
    res.on('close', () => {
        if (downloadProcess && !downloadProcess.killed) {
            downloadProcess.kill('SIGTERM');
            downloadInfo.status = 'cancelled';
            
            sendWebhook('download.cancelled', {
                downloadId,
                title
            });
        }
    });
});

// Get download status
app.get('/api/status/:downloadId', (req, res) => {
    const downloadInfo = activeDownloads.get(req.params.downloadId);
    
    if (!downloadInfo) {
        return res.status(404).json({ error: 'Download not found' });
    }
    
    res.json({
        status: downloadInfo.status,
        filename: downloadInfo.filename,
        title: downloadInfo.title,
        platform: downloadInfo.platform,
        createdAt: downloadInfo.createdAt,
        startedAt: downloadInfo.startedAt,
        completedAt: downloadInfo.completedAt,
        totalBytes: downloadInfo.totalBytes
    });
});

// List active downloads
app.get('/api/downloads', (req, res) => {
    const downloads = Array.from(activeDownloads.entries()).map(([id, info]) => ({
        id,
        title: info.title,
        status: info.status,
        platform: info.platform,
        createdAt: info.createdAt
    }));
    
    res.json(downloads);
});

// WebSocket handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Start server
httpServer.listen(config.port, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════╗
║          MediaFetch Server            ║
║                                       ║
║  Running on: http://0.0.0.0:${config.port}     ║
║  Auth: ${config.enableAuth ? 'Enabled' : 'Disabled'}                       ║
║  Webhooks: ${config.enableWebhooks ? 'Enabled' : 'Disabled'}                  ║
║                                       ║
║  Ready to fetch media!                ║
╚═══════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    httpServer.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});