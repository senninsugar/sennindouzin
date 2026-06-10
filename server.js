const express = require('express');
const axios = require('axios');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const axiosInstance = axios.create({
    httpAgent,
    httpsAgent,
    timeout: 8000
});

const ENC_KEY = crypto.randomBytes(32);
const IV_LENGTH = 16;

function encryptBuffer(buffer) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENC_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    return Buffer.concat([iv, encrypted]);
}

function decryptBuffer(buffer) {
    const iv = buffer.subarray(0, IV_LENGTH);
    const encryptedText = buffer.subarray(IV_LENGTH);
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENC_KEY, iv);
    return Buffer.concat([decipher.update(encryptedText), decipher.final()]);
}

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

app.use(express.static('.'));

const imageCache = new Map();

async function registerImageProxy(url) {
    if (!url) return null;
    try {
        const res = await axiosInstance.get(url, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Referer': 'https://momon-ga.com/'
            }
        });

        const contentType = res.headers['content-type'] || 'image/jpeg';
        const buffer = Buffer.from(res.data);
        const encryptedBuffer = encryptBuffer(buffer);

        const imageId = crypto.randomBytes(16).toString('hex');

        imageCache.set(imageId, {
            buffer: encryptedBuffer,
            contentType: contentType
        });

        setTimeout(() => {
            imageCache.delete(imageId);
        }, 180000);

        return `/api/image/${imageId}`;

    } catch (e) {
        console.error(`Image Cache Error: ${url}`, e.message);
        return null;
    }
}

app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ result: [] });

    try {
        const response = await axiosInstance.get(`https://momon-ga.com/?s=${encodeURIComponent(query)}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
            }
        });

        const html = response.data;
        const tasks = [];

        const postRegex = /<a href="https:\/\/momon-ga\.com\/(?:fanzine|magazine)\/(mo[0-9-]+)\/">[\s\S]*?<img src="([^"]+)"[\s\S]*?alt="([^"]+)"/g;

        let match;

        while ((match = postRegex.exec(html)) !== null) {
            const id = match[1];
            const imgUrl = match[2];
            const title = match[3];

            tasks.push((async () => {
                const proxyImageUrl = await registerImageProxy(imgUrl);
                return {
                    id: id,
                    image: proxyImageUrl,
                    title: title,
                    rule: ""
                };
            })());
        }

        const results = await Promise.all(tasks);

        console.log(`Query: ${query}, Found: ${results.length} items`);

        res.json({ result: results });

    } catch (error) {
        console.error("Search API Error:", error.message);
        res.status(500).json({ error: "Search failed" });
    }
});

app.get('/api/proxy-details', async (req, res) => {
    const id = req.query.id;

    if (!id) return res.status(400).send("ID is required");

    const targetUrl = `https://momon-ga.com/fanzine/${id}`;

    try {
        const response = await axiosInstance.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });

        const htmlString = response.data;
        const imgUrls = [];
        const galleryRegex = /src="([^"]*galleries[^"]*)"/g;

        let match;
        while ((match = galleryRegex.exec(htmlString)) !== null) {
            let src = match[1];
            if (src.startsWith('/')) {
                src = 'https://momon-ga.com' + src;
            }
            imgUrls.push(src);
        }

        const uniqueImgUrls = [...new Set(imgUrls)];

        const proxyImageUrls = await Promise.all(
            uniqueImgUrls.map(url => registerImageProxy(url))
        );

        const filteredImages = proxyImageUrls.filter(img => img !== null);

        const titleMatch = htmlString.match(/<h1[^>]*>(.*?)<\/h1>/);
        const title = titleMatch
            ? titleMatch[1].replace(/<[^>]*>?/gm, '').trim()
            : "No Title";

        res.json({
            title,
            images: filteredImages
        });

    } catch (e) {
        console.error(e.message);
        res.status(500).send("Detail fetch error");
    }
});

app.get('/api/image/:id', (req, res) => {
    const imageId = req.params.id;
    const cachedImage = imageCache.get(imageId);

    if (!cachedImage) {
        return res.status(404).send("Image not found or expired");
    }

    try {
        const decryptedBuffer = decryptBuffer(cachedImage.buffer);
        res.setHeader('Content-Type', cachedImage.contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(decryptedBuffer);
    } catch (e) {
        console.error(e.message);
        res.status(500).send("Decryption error");
    }
});

app.get('/api/image-proxy', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send("URL is required");

    try {
        const response = await axiosInstance({
            method: 'get',
            url: imageUrl,
            responseType: 'arraybuffer',
            headers: {
                'Referer': 'https://momon-ga.com/'
            }
        });

        const contentType = response.headers['content-type'] || 'image/jpeg';
        
        res.setHeader('Content-Type', contentType);
        res.send(Buffer.from(response.data));

    } catch (e) {
        console.error(e.message);
        res.status(500).send("Image proxy error");
    }
});

app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
