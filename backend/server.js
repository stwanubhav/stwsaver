const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json());

// Store download jobs
const downloads = new Map();

// Ensure downloads directory exists
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// Cleanup old files every hour
setInterval(() => {
    const now = Date.now();
    for (const [id, data] of downloads.entries()) {
        if (now - data.createdAt > 5 * 60 * 1000) {
            if (data.filePath && fs.existsSync(data.filePath)) {
                fs.unlinkSync(data.filePath);
                console.log(`🗑️ Deleted expired: ${data.filename}`);
            }
            downloads.delete(id);
        }
    }
}, 60 * 60 * 1000);

// Clean filename
function cleanFilename(title, format) {
    return title
        .replace(/[^\w\s]/gi, '')
        .replace(/\s+/g, '_')
        .substring(0, 50) + (format === 'mp3' ? '.mp3' : '.mp4');
}

// Root endpoint
app.get('/', (req, res) => {
    res.json({ 
        message: 'STWSAVER Backend API',
        status: 'online',
        version: '1.0.0'
    });
});

// Start download
app.post('/api/download', async (req, res) => {
    const { url, format, quality } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    
    const fileId = crypto.randomBytes(16).toString('hex');
    const createdAt = Date.now();
    
    downloads.set(fileId, {
        id: fileId,
        url,
        format,
        quality,
        status: 'downloading',
        progress: 0,
        createdAt,
        filePath: null,
        filename: null
    });
    
    res.json({
        file_id: fileId,
        message: 'Download started',
        status: 'processing'
    });
    
    // Process in background
    processDownload(fileId).catch(console.error);
});

// Process download
async function processDownload(fileId) {
    const job = downloads.get(fileId);
    if (!job) return;
    
    try {
        const { url, format, quality } = job;
        
        // Get video info
        const info = await ytdl.getInfo(url);
        const title = info.videoDetails.title;
        
        let stream;
        let filename;
        
        if (format === 'mp3') {
            // Audio only
            const audioFormat = ytdl.chooseFormat(info.formats, { 
                quality: 'highestaudio',
                filter: 'audioonly'
            });
            filename = cleanFilename(title, 'mp3');
            stream = ytdl(url, { format: audioFormat });
        } else {
            // Video with selected quality
            let videoFormat;
            if (quality) {
                const qualityMap = {
                    '144p': '144',
                    '240p': '240',
                    '360p': '360',
                    '480p': '480',
                    '720p': '720',
                    '1080p': '1080'
                };
                const itag = qualityMap[quality];
                if (itag) {
                    videoFormat = info.formats.find(f => f.qualityLabel === `${itag}p` && f.hasVideo);
                }
            }
            if (!videoFormat) {
                videoFormat = ytdl.chooseFormat(info.formats, { quality: 'highestvideo' });
            }
            filename = cleanFilename(title, 'mp4');
            stream = ytdl(url, { format: videoFormat });
        }
        
        const filePath = path.join(downloadsDir, `${fileId}_${filename}`);
        const writeStream = fs.createWriteStream(filePath);
        
        let totalBytes = 0;
        
        stream.on('progress', (chunkLength, downloaded, total) => {
            totalBytes = total;
            const percent = total ? Math.round((downloaded / total) * 100) : 0;
            
            const jobUpdate = downloads.get(fileId);
            if (jobUpdate) {
                jobUpdate.progress = percent;
                jobUpdate.status = percent >= 100 ? 'converting' : 'downloading';
            }
        });
        
        stream.pipe(writeStream);
        
        await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
            stream.on('error', reject);
        });
        
        // Update job
        const jobUpdate = downloads.get(fileId);
        if (jobUpdate) {
            jobUpdate.status = 'completed';
            jobUpdate.progress = 100;
            jobUpdate.filePath = filePath;
            jobUpdate.filename = filename;
        }
        
        console.log(`✅ Downloaded: ${filename}`);
        
    } catch (error) {
        console.error(`❌ Failed ${fileId}:`, error.message);
        const job = downloads.get(fileId);
        if (job) {
            job.status = 'failed';
            job.error = error.message;
        }
    }
}

// Check progress
app.get('/api/progress/:fileId', (req, res) => {
    const { fileId } = req.params;
    const job = downloads.get(fileId);
    
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    
    let downloadUrl = null;
    if (job.status === 'completed' && job.filePath && fs.existsSync(job.filePath)) {
        downloadUrl = `/api/download-file/${fileId}`;
    }
    
    res.json({
        file_id: fileId,
        status: job.status,
        progress: job.progress,
        message: job.error || null,
        download_url: downloadUrl,
        filename: job.filename
    });
});

// Download file
app.get('/api/download-file/:fileId', (req, res) => {
    const { fileId } = req.params;
    const job = downloads.get(fileId);
    
    if (!job || job.status !== 'completed' || !job.filePath) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    if (!fs.existsSync(job.filePath)) {
        return res.status(404).json({ error: 'File expired' });
    }
    
    res.download(job.filePath, job.filename, (err) => {
        if (err) {
            console.error('Download error:', err);
        }
        // Delete after 5 minutes
        setTimeout(() => {
            if (fs.existsSync(job.filePath)) {
                fs.unlinkSync(job.filePath);
                console.log(`🗑️ Deleted: ${job.filename}`);
            }
        }, 5 * 60 * 1000);
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
