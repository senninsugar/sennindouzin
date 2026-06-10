const express = require('express');
const axios = require('axios');
const http = require('http');
const https = require('https');
const crypto = require('crypto'); // 画像ID生成用
const app = express();
const PORT = process.env.PORT || 3000;

// HTTP/HTTPS Keep-Alive を有効化
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const axiosInstance = axios.create({
    httpAgent,
    httpsAgent,
    timeout: 8000
});

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

app.use(express.static('.'));

// 画像のバイナリデータとMimeTypeを一時的に保持するサーバー内メモリキャッシュ
// フロント側にはこのキー（ランダムID）だけが渡ります
const imageCache = new Map();

// 画像を事前取得してキャッシュに保存し、フロント用の内部プロキシURLを返す関数
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

        // ランダムな一意のIDを生成
        const imageId = crypto.randomBytes(16).toString('hex');

        // メモリにバイナリ情報ごと保存
        imageCache.set(imageId, {
            buffer: buffer,
            contentType: contentType
        });

        // 古いキャッシュによるメモリ圧迫を防ぐため、3分後に自動消去（実用的な軽量化）
        setTimeout(() => {
            imageCache.delete(imageId);
        }, 180000);

        // フロント側はこのURLをそのまま <img src="..."> に入れるだけで画像が表示されます
        return `/api/image/${imageId}`;

    } catch (e) {
        console.error(`Image Cache Error: ${url}`, e.message);
        return null;
    }
}

// 1. 検索API
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
                // 画像をサーバー側にバイナリとして引っ張り込み、内部URLへ差し替え
                const proxyImageUrl = await registerImageProxy(imgUrl);
                return {
                    id: id,
                    image: proxyImageUrl, // 内部用プロキシURLが入る
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

// 2. 詳細情報取得API
app.get('/api/proxy-details', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) return res.status(400).send("URL is required");

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

        // 全ての画像を並列で取得・サーバー内部のメモリに格納
        const proxyImageUrls = await Promise.all(
            uniqueImgUrls.map(url => registerImageProxy(url))
        );

        // null除外
        const filteredImages = proxyImageUrls.filter(img => img !== null);

        const titleMatch = htmlString.match(/<h1[^>]*>(.*?)<\/h1>/);
        const title = titleMatch
            ? titleMatch[1].replace(/<[^>]*>?/gm, '').trim()
            : "No Title";

        // フロント側へは、安全な内部プロキシURLの配列が返却されます
        res.json({
            title,
            images: filteredImages
        });

    } catch (e) {
        console.error(e.message);
        res.status(500).send("Detail fetch error");
    }
});

// 3. 【新設】画像バイナリ実体返却エンドポイント
// フロントからは単なる「画像ファイルへのリンク」として機能します（URLなどの情報は一切含まれません）
app.get('/api/image/:id', (req, res) => {
    const imageId = req.params.id;
    const cachedImage = imageCache.get(imageId);

    if (!cachedImage) {
        return res.status(404).send("Image not found or expired");
    }

    // 正しいContent-Type（image/jpeg等）を設定して、生のバイナリデータをそのまま高速送信
    res.setHeader('Content-Type', cachedImage.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // フロント側のブラウザキャッシュも効かせてさらに高速化
    res.send(cachedImage.buffer);
});

// 4. 元々存在した単体画像Proxy (仕様互換維持のため残していますが、内部はバイナリ直返しに最適化)
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
