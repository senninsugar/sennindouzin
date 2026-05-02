const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// CORS設定
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

// 静的ファイルの提供 (Renderデプロイ用)
app.use(express.static('.'));

// 自前スクレイピング検索エンドポイント (s=クエリに対応)
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ result: [] });

    try {
        // ご提示の検索形式 https://momon-ga.com/?s=キーワード に対応
        const response = await axios.get(`https://momon-ga.com/?s=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const html = response.data;
        const results = [];
        
        // 検索結果のアイテム（aタグのhref、imgのsrc、タイトル等）を抽出する正規表現
        const itemRegex = /<div class="fanzine-item">[\s\S]*?href="\/fanzine\/(.*?)"[\s\S]*?src="(.*?)"[\s\S]*?class="title">(.*?)<\/div>/g;
        
        let match;
        while ((match = itemRegex.exec(html)) !== null) {
            results.push({
                id: match[1],
                image: match[2].startsWith('http') ? match[2] : `https://momon-ga.com${match[2]}`,
                title: match[3].trim(),
                rule: "" 
            });
        }
        res.json({ result: results });
    } catch (error) {
        res.status(500).json({ error: "Search failed" });
    }
});

// 詳細ページスクレイピングエンドポイント
app.get('/api/proxy-details', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("URL is required");

    try {
        const response = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const htmlString = response.data;
        const imgUrls = [];
        const galleryRegex = /src="([^"]*galleries[^"]*)"/g;
        let match;
        while ((match = galleryRegex.exec(htmlString)) !== null) {
            let src = match[1];
            if (src.startsWith('/')) src = 'https://momon-ga.com' + src;
            // 画像はプロキシ経由のURLとして返却
            imgUrls.push(`/api/image-proxy?url=${encodeURIComponent(src)}`);
        }

        const uniqueUrls = [...new Set(imgUrls)];
        const titleMatch = htmlString.match(/<h1>(.*?)<\/h1>/);
        const title = titleMatch ? titleMatch[1] : "No Title";

        res.json({
            title: title,
            images: uniqueUrls
        });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch details" });
    }
});

// 画像プロキシエンドポイント (Refererを偽装して取得)
app.get('/api/image-proxy', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send("Image URL is required");

    try {
        const response = await axios({
            method: 'get',
            url: imageUrl,
            responseType: 'stream',
            headers: { 
                'Referer': 'https://momon-ga.com/', 
                'User-Agent': 'Mozilla/5.0' 
            }
        });
        res.setHeader('Content-Type', response.headers['content-type']);
        response.data.pipe(res);
    } catch (error) {
        res.status(500).send("Image proxy error");
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
