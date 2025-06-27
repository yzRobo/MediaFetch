// MediaFetch Client - Direct download to user's device
document.addEventListener("DOMContentLoaded", () => {
    const socket = io();
    
    // Element references
    const form = document.getElementById("download-form");
    const urlInput = document.getElementById("url-input");
    const formatSelect = document.getElementById("format-select");
    const refererInput = document.getElementById("referer-input");
    const downloadBtn = document.getElementById("download-btn");
    const platformIndicator = document.getElementById("platform-indicator");
    const activeDownloadsContainer = document.getElementById("active-downloads");
    
    // Store active downloads
    const activeDownloads = new Map();
    
    // Platform detection
    function detectPlatform(url) {
        const urlLower = url.toLowerCase();
        
        if (urlLower.includes('vimeo.com')) return { name: 'vimeo', display: 'Vimeo', color: '#00adef' };
        if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) return { name: 'youtube', display: 'YouTube', color: '#ff0000' };
        if (urlLower.includes('twitter.com') || urlLower.includes('x.com')) return { name: 'twitter', display: 'Twitter/X', color: '#1da1f2' };
        if (urlLower.includes('instagram.com')) return { name: 'instagram', display: 'Instagram', color: '#e1306c' };
        if (urlLower.includes('tiktok.com')) return { name: 'tiktok', display: 'TikTok', color: '#000000' };
        if (urlLower.includes('threads.net')) return { name: 'threads', display: 'Threads', color: '#000000' };
        
        return { name: 'other', display: 'Supported', color: '#6366f1' };
    }
    
    // Update platform indicator
    urlInput.addEventListener('input', (e) => {
        const url = e.target.value.trim();
        
        if (url) {
            const platform = detectPlatform(url);
            platformIndicator.textContent = platform.display;
            platformIndicator.style.backgroundColor = platform.color;
            platformIndicator.style.display = 'inline-block';
            
            // Show/hide referer input for private videos
            if (platform.name === 'vimeo') {
                refererInput.parentElement.style.display = 'block';
            }
        } else {
            platformIndicator.style.display = 'none';
            refererInput.parentElement.style.display = 'none';
        }
    });
    
    // Create download card
    function createDownloadCard(info) {
        const card = document.createElement('div');
        card.className = 'download-card';
        card.id = `download-${info.downloadId}`;
        
        card.innerHTML = `
            <div class="download-header">
                <h4 class="download-title">${info.title}</h4>
                <span class="download-platform" style="background-color: ${detectPlatform(info.platform).color}">
                    ${info.platform}
                </span>
            </div>
            <div class="download-progress">
                <div class="progress-bar">
                    <div class="progress-fill" style="width: 0%"></div>
                </div>
                <span class="progress-text">Preparing...</span>
            </div>
            <div class="download-actions">
                <button class="btn-secondary btn-small cancel-btn" data-id="${info.downloadId}">Cancel</button>
                <span class="download-size"></span>
            </div>
        `;
        
        return card;
    }
    
    // Format bytes
    function formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
    
    // Handle form submission
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const url = urlInput.value.trim();
        const format = formatSelect.value;
        const referer = refererInput.value.trim();
        
        if (!url) return;
        
        // Disable form
        downloadBtn.disabled = true;
        downloadBtn.textContent = 'Preparing...';
        
        try {
            // First, prepare the download
            const prepareResponse = await fetch('/api/prepare-download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, format, referer })
            });
            
            if (!prepareResponse.ok) {
                throw new Error('Failed to prepare download');
            }
            
            const downloadInfo = await prepareResponse.json();
            
            // Add to active downloads
            activeDownloads.set(downloadInfo.downloadId, downloadInfo);
            
            // Create and show download card
            const card = createDownloadCard(downloadInfo);
            activeDownloadsContainer.appendChild(card);
            activeDownloadsContainer.style.display = 'block';
            
            // Update progress text
            const progressText = card.querySelector('.progress-text');
            progressText.textContent = 'Starting download...';
            
            // Create a hidden link for download
            const downloadLink = document.createElement('a');
            downloadLink.href = `/api/download/${downloadInfo.downloadId}`;
            downloadLink.download = downloadInfo.filename;
            downloadLink.style.display = 'none';
            document.body.appendChild(downloadLink);
            
            // Start the download
            downloadLink.click();
            
            // Update UI
            progressText.textContent = 'Downloading to your device...';
            const progressFill = card.querySelector('.progress-fill');
            progressFill.style.width = '100%';
            progressFill.style.background = 'var(--success)';
            
            // Listen for progress updates via WebSocket
            socket.on(`download-progress-${downloadInfo.downloadId}`, (data) => {
                const sizeElement = card.querySelector('.download-size');
                sizeElement.textContent = formatBytes(data.bytesDownloaded);
            });
            
            // Clean up after a delay
            setTimeout(() => {
                card.remove();
                document.body.removeChild(downloadLink);
                activeDownloads.delete(downloadInfo.downloadId);
                
                if (activeDownloadsContainer.children.length === 0) {
                    activeDownloadsContainer.style.display = 'none';
                }
            }, 30000); // 30 seconds
            
        } catch (error) {
            console.error('Download error:', error);
            alert('Failed to start download. Please try again.');
        } finally {
            // Reset form
            downloadBtn.disabled = false;
            downloadBtn.textContent = 'Download';
            urlInput.value = '';
            refererInput.value = '';
            platformIndicator.style.display = 'none';
            refererInput.parentElement.style.display = 'none';
        }
    });
    
    // Handle cancel button clicks
    activeDownloadsContainer.addEventListener('click', (e) => {
        if (e.target.classList.contains('cancel-btn')) {
            const downloadId = e.target.dataset.id;
            const card = document.getElementById(`download-${downloadId}`);
            
            if (card) {
                card.remove();
                activeDownloads.delete(downloadId);
                
                if (activeDownloadsContainer.children.length === 0) {
                    activeDownloadsContainer.style.display = 'none';
                }
            }
        }
    });
    
    // Check for existing downloads on load
    fetch('/api/downloads')
        .then(res => res.json())
        .then(downloads => {
            if (downloads.length > 0) {
                activeDownloadsContainer.style.display = 'block';
                downloads.forEach(download => {
                    if (download.status === 'downloading') {
                        const card = createDownloadCard(download);
                        activeDownloadsContainer.appendChild(card);
                    }
                });
            }
        })
        .catch(console.error);
});