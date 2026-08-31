const express = require('express');
const axios = require('axios');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const path = require('path'); // パス操作用に追加
const app = express();
const PORT = process.env.PORT || 3000;

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const axiosInstance = axios.create({
    httpAgent,
    httpsAgent,
    timeout: 8000
});

// サーバー再起動時にもキーが維持されるよう、環境変数か固定の32バイトバッファを使用（セキュリティ向上のため推奨）
const ENC_KEY = process.env.ENCRYPTION_KEY ? Buffer.from(process.env.ENCRYPTION_KEY, 'hex') : crypto.scryptSync('momon-ga-secret-password-1234', 'salt', 32);
const IV_LENGTH = 16;

function encryptBuffer(buffer) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENC_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    // 先頭に16バイトのIV、その後に暗号化データを結合
    return Buffer.concat([iv, encrypted]);
}

function decryptBuffer(buffer) {
    // 先頭16バイトからIVを抽出
    const iv = buffer.subarray(0, IV_LENGTH);
    // 残りの部分から暗号化データを抽出
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

// --- 追加ルーティング設定 ---
// お気に入り画面 (favorite.html) へのルート
app.get('/favorite.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'favorite.html'));
});

// 読み途中画面 (yomitotyuu.html) へのルート
app.get('/yomitotyuu.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'yomitotyuu.html'));
});
// ----------------------------

const imageCache = new Map();

async function registerImageProxy(url) {
    if (!url) return null;
    try {
        const res = await axiosInstance.get(url, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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

        // --- 追加のスクレイピング抽出処理（修正版） ---

        // 1. 制作サークル (「制作サークル」という文字列の後方にあるリンク文字列を取得。間に他要素や改行が入るケースに対応)
        const circleMatch = htmlString.match(/制作サークル\s*:\s*(?:<[^>]+>\s*)*<a[^>]*>([^<]+)<\/a>/i);
        const circle = circleMatch ? circleMatch[1].trim() : "不明";

        // 2. 作者 (「作者」という文字列の後方にあるリンク文字列を取得)
        const authorMatch = htmlString.match(/作者\s*:\s*(?:<[^>]+>\s*)*<a[^>]*>([^<]+)<\/a>/i);
        const author = authorMatch ? authorMatch[1].trim() : "不明";

        // 3. ページ数 (「ページ数」の後ろの数値を確実に取得。余計な文字やスペースを許容)
        const pagesMatch = htmlString.match(/ページ数\s*:\s*(?:<[^>]+>\s*)*(\d+)\s*ページ/i);
        const pages = pagesMatch ? parseInt(pagesMatch[1], 10) : 0;

        // 4. 公開/投稿日時 (timeタグのタグ内、もしくはdatetime属性などから柔軟に取得)
        const dateMatch = htmlString.match(/公開\/投稿日時\s*:\s*(?:<[^>]+>\s*)*<time[^>]*>([^<]+)<\/time>/i);
        const postDate = dateMatch ? dateMatch[1].trim() : "不明";

        // 5. 属性・タグ情報（コンテンツの傾向）
        const tags = [];
        const tagRegex = /<a\s+href="https:\/\/momon-ga\.com\/tag\/[^"]+"[^>]*>([^<]+)<\/a>/gi;
        let tagMatch;
        while ((tagMatch = tagRegex.exec(htmlString)) !== null) {
            tags.push(tagMatch[1].trim());
        }

        // 6. コメント一覧
        const comments = [];
        const commentRegex = /<div\s+class="comment\s+[^"]*id="comment-\d+"[^>]*>([\s\S]*?)<\/div>\s*<\/li>/gi;
        let commentBlockMatch;
        while ((commentBlockMatch = commentRegex.exec(htmlString)) !== null) {
            const block = commentBlockMatch[1];

            const numMatch = block.match(/<span\s+class="comment_num">([^<]+)<\/span>/);
            const authorMatch = block.match(/<span\s+class="comment_author">([^<]+)<\/span>/);
            const dateMatch = block.match(/<span\s+class="comment_date">([^<]+)<\/span>/);
            const textMatch = block.match(/<p>([\s\S]*?)<\/p>/);
            const likesMatch = block.match(/data-ulike-counter-value="([^"]+)"/);

            const num = numMatch ? numMatch[1].trim() : "";
            const authorName = authorMatch ? authorMatch[1].trim() : "";
            const date = dateMatch ? dateMatch[1].trim() : "";
            const text = textMatch ? textMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>?/gm, '').trim() : "";
            const likes = likesMatch ? likesMatch[1].trim() : "";

            if (text) {
                comments.push({
                    num,
                    author: authorName,
                    date,
                    text,
                    likes
                });
            }
        }

        // 7. 関連作品一覧
        const relatedTasks = [];
        const relatedRegex = /<a\s+href="https:\/\/momon-ga\.com\/(?:fanzine|magazine)\/(mo[0-9-]+)\/">[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?alt="([^"]+)"[\s\S]*?(?:<div\s+class="post-list-wpulike">([^<]+)<\/div>)?[\s\S]*?<\/a>/gi;
        let relatedMatch;
        while ((relatedMatch = relatedRegex.exec(htmlString)) !== null) {
            const relId = relatedMatch[1];
            const relImgUrl = relatedMatch[2];
            const relTitle = relatedMatch[3];
            const relLikes = relatedMatch[4] ? relatedMatch[4].trim() : "";

            relatedTasks.push((async () => {
                const proxyImageUrl = await registerImageProxy(relImgUrl);
                return {
                    id: relId,
                    title: relTitle,
                    image: proxyImageUrl,
                    likes: relLikes
                };
            })());
        }
        const related = await Promise.all(relatedTasks);
        // ------------------------------------

        res.json({
            title,
            images: filteredImages,
            circle,       // サークル名
            author,       // 作者名
            pages,        // ページ数 (数値)
            postDate,     // 投稿日時
            tags,         // タグの配列
            comments,     // コメントのオブジェクト配列
            related       // 関連作品の配列
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
        console.error("Decryption error details:", e.message);
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
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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
