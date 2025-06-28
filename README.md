![MediaFetch_RepoPreview](https://github.com/user-attachments/assets/d086293e-ccd9-4814-b937-a431ad9027f2)


A self-hosted media archival tool for personal content backup. Archive your own content from various platforms for personal use.

## Features

- **Direct Archival**: Content streams directly to your device
- **Multi-Platform Support**: Works with numerous video platforms
- **Multiple Formats**: Video, audio-only, and various quality options
- **Docker Ready**: Simple deployment with Docker
- **Privacy Focused**: Your content never stays on the server
- **GPL Licensed**: Free and open source software

## Quick Start with Docker

### Using Docker Compose (Recommended)

1. Create a `docker-compose.yml` file:

```yaml
version: '3.8'

services:
  mediafetch:
    image: yzRobo/mediafetch:latest
    container_name: mediafetch
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      # Optional: Enable authentication
      - ENABLE_AUTH=false
      - AUTH_USERNAME=admin
      - AUTH_PASSWORD=changeme
    restart: unless-stopped
```

2. Start the container:
```bash
docker-compose up -d
```

3. Access MediaFetch at `http://localhost:8234`

### Using Docker Run

```bash
docker run -d \
  --name mediafetch \
  -p 8234:8234 \
  -e NODE_ENV=production \
  --restart unless-stopped \
  yourusername/mediafetch:latest
```

## Building from Source

1. Clone the repository:
```bash
git clone https://github.com/yourusername/mediafetch.git
cd mediafetch
```

2. Build the Docker image:
```bash
docker build -t mediafetch .
```

3. Run with docker-compose:
```bash
docker-compose up -d
```

## Configuration

Environment variables you can set:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8234` | Port to run the server on |
| `ENABLE_AUTH` | `false` | Enable basic authentication |
| `AUTH_USERNAME` | `admin` | Username for basic auth |
| `AUTH_PASSWORD` | `changeme` | Password for basic auth |
| `ENABLE_WEBHOOKS` | `false` | Enable webhook notifications |
| `WEBHOOK_URL` | | URL to send webhooks to |
| `WEBHOOK_SECRET` | | Secret for webhook signatures |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | Maximum simultaneous downloads |

## Webhook Events

When webhooks are enabled, MediaFetch sends POST requests to your webhook URL for these events:

- `download.prepared` - When video info is fetched and ready
- `download.completed` - When download finishes successfully
- `download.cancelled` - When user cancels a download

Webhook payload example:
```json
{
  "event": "download.completed",
  "timestamp": "2024-01-10T12:00:00Z",
  "service": "MediaFetch",
  "data": {
    "downloadId": "abc123",
    "title": "Video Title",
    "filename": "video_title.mp4",
    "status": "completed",
    "totalBytes": 104857600,
    "duration": 45000
  }
}
```

## Security Considerations

- **Authentication**: Enable auth if exposing to the internet
- **Reverse Proxy**: Use Nginx/Caddy with SSL for production
- **Firewall**: Only expose necessary ports
- **Updates**: Keep yt-dlp updated for best compatibility

## Reverse Proxy with Nginx

```nginx
server {
    listen 80;
    server_name media.yourdomain.com;

    location / {
        proxy_pass http://localhost:8234;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # For large file downloads
        proxy_buffering off;
        proxy_request_buffering off;
    }
}
```

## Updating

To update MediaFetch:

```bash
docker-compose pull
docker-compose up -d
```

## Troubleshooting

- **Downloads fail**: Make sure yt-dlp is up to date in the container
- **Can't access**: Check firewall rules and Docker port mapping
- **Auth not working**: Ensure `ENABLE_AUTH=true` is set correctly

## License

GNU General Public License v3.0 - see LICENSE file for details

## Purpose

MediaFetch is designed for personal archival and backup of your own content. Please respect content creators and platform terms of service.
